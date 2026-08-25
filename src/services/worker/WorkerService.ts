import { Service, type Context } from 'cordis'
import { TRACE_STATUS, type AgentTraceRecord } from '@/services/traces/TracesService'
import logger from '@/logger'
import { threadContext } from '@/logger/context'

/** 轮询间隔（毫秒）：每个 tick 内把队列消费到空，运行中新消息最多延迟一个间隔 */
const POLL_INTERVAL_MS = 3_000

/**
 * worker Service：周期轮询 agent_traces 队列，取 pending 记录调用 ctx.agent.run 处理。
 * 只负责消费 + 状态流转（并发 trace/status 事件）；回复由 lark 订阅 agent/* 事件完成，worker 完全不知道 lark 存在。
 */
export default class WorkerService extends Service {
  static inject = ['agent', 'traces']

  private timer: ReturnType<typeof setInterval> | null = null
  private processing = false

  constructor(ctx: Context) {
    super(ctx, 'worker')
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
    this.poll() // 启动立即消费一轮，避免积压队列等一个间隔
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 消费一轮：把 pending 全部处理完；上一轮未结束时跳过本次 tick（防重入） */
  private async poll() {
    if (this.processing) return
    this.processing = true
    try {
      while (true) {
        const trace = this.ctx.traces.getPendingTrace()
        if (!trace) return

        // 原子抢锁：pending → processing，失败说明被其他进程抢走
        const locked = this.ctx.traces.updateTraceStatus(
          trace.id,
          TRACE_STATUS.PENDING,
          TRACE_STATUS.PROCESSING
        )
        if (!locked) continue

        await this.handle(trace)
      }
    } catch (err) {
      // 兜底：轮询/抢锁的 sql 报错不能逃出（否则 unhandled rejection 崩 worker），记日志等下一个 tick
      logger.error('[worker] 轮询异常: ', err)
    } finally {
      this.processing = false
    }
  }

  /** 跑一条 trace：agent.run + 状态流转（成功 done / 失败 failed）；logger 由 threadContext 自动关联 threadId */
  private async handle(trace: AgentTraceRecord) {
    this.ctx.emit('trace/status', trace.thread_id, TRACE_STATUS.PROCESSING)

    await threadContext.run(trace.thread_id, async () => {
      logger.info('[worker] 开始处理')
      try {
        await this.ctx.agent.run(trace.input_text, trace.thread_id)

        this.ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE)
        this.ctx.emit('trace/status', trace.thread_id, TRACE_STATUS.DONE)
        logger.info('[worker] agent run done')
      } catch (err) {
        // agent.run 已 emit agent/error（lark 订阅回消息），这里只标记失败
        this.ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.FAILED)
        this.ctx.emit('trace/status', trace.thread_id, TRACE_STATUS.FAILED)
        logger.error('[worker] agent run fail', err)
      }
    })
  }
}
