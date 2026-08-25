import { Service, type Context } from 'cordis'
import {
  TRACE_STATUS,
  type AgentTraceRecord,
  type TraceStatus
} from '@/services/data/traces/TracesService'

import logger from '@/utils/logger'
import { threadContext } from '@/utils/context'
import { stringify } from '@/utils'

declare module 'cordis' {
  interface Context {
    worker: WorkerService
  }
  interface Events {
    /** worker 状态流转 pending→processing→done/failed，观察/审计用，避免别人轮询 DB */
    'trace/status': (threadId: string, status: TraceStatus) => void
  }
}

/** 轮询间隔（毫秒）：每个 tick 内把队列消费到空，运行中新消息最多延迟一个间隔 */
const POLL_INTERVAL_MS = 3_000

/**
 * worker Service：周期轮询 agent_traces 队列，取 pending 记录调用 ctx.agent.run 处理。
 * 只负责消费 + 状态流转（并发 trace/status 事件）+ 完成后出站回复。
 * 回复用 lark 出站 REST（不需要 WS），多实例下 worker 自己就能回消息，不依赖同进程事件。
 */
export default class WorkerService extends Service {
  static inject = ['agent', 'traces', 'lark']

  private timer: ReturnType<typeof setInterval> | null = null
  private processing = false

  constructor(ctx: Context) {
    super(ctx, 'worker')
  }

  start() {
    if (this.timer) return
    this.recoverStaleTraces()
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
    this.poll() // 启动立即消费一轮，避免积压队列等一个间隔
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 启动恢复：把进程崩溃/重启遗留的超时 processing trace 重置回 pending（只回收超过
   * STALE_PROCESSING_MINUTES 的无主记录，不误伤其他实例正在跑的 trace），随后 poll 会重新领取。
   */
  private recoverStaleTraces() {
    const recovered = this.ctx.traces.resetStaleProcessingTraces()
    if (recovered > 0) {
      logger.warn(`[worker] 启动恢复 ${recovered} 条遗留 processing trace`)
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

  /** 跑一条 trace：agent.run + 状态流转（成功 done / 失败 failed）+ 完成后直调 lark 出站回复；logger 由 threadContext 自动关联 threadId */
  private async handle(trace: AgentTraceRecord) {
    this.ctx.emit('trace/status', trace.threadId, TRACE_STATUS.PROCESSING)

    await threadContext.run(trace.threadId, async () => {
      logger.info('[worker] 开始处理')
      try {
        const answer = await this.ctx.agent.run(trace.inputText, trace.threadId)

        this.ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE)
        this.ctx.emit('trace/status', trace.threadId, TRACE_STATUS.DONE)
        logger.info('[worker] agent run done')
        await this.replyIfNeeded(trace, answer)
      } catch (err) {
        this.ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.FAILED)
        this.ctx.emit('trace/status', trace.threadId, TRACE_STATUS.FAILED)
        logger.error('[worker] agent run fail', err)
        await this.replyIfNeeded(trace, `Agent 处理失败：${stringify(err)}`)
      }
    })
  }

  /** 只有 lark 渠道入站的 trace 带 messageId，才回复；reply 内部吞错，不影响主流程 */
  private async replyIfNeeded(trace: AgentTraceRecord, text: string | null) {
    if (!trace.messageId || !text) return
    await this.ctx.lark.reply(trace.messageId, text)
  }
}
