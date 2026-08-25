import { Service, type Context } from 'cordis'
import { TRACE_STATUS } from '@/services/traces/TracesService'
import logger from '@/logger'
import { threadContext } from '@/logger/context'

/**
 * worker Service：后台轮询 agent_traces 队列，取 pending 记录调用 ctx.agent.run 处理。
 * 只负责消费 + 状态流转（并发 trace/status 事件）；回复由 lark 订阅 agent/* 事件完成，worker 完全不知道 lark 存在。
 */
export default class WorkerService extends Service {
  static inject = ['agent', 'traces']

  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private wakeSleep: (() => void) | null = null

  constructor(ctx: Context) {
    super(ctx, 'worker')
  }

  start() {
    if (this.running) return
    this.running = true

    // 上次进程崩溃/重启可能残留 processing 记录，重置回 pending 避免永远挂起
    const reset = this.ctx.traces.resetStaleProcessingTraces()
    if (reset > 0) logger.warn(`[worker] 重置 ${reset} 条残留 processing 记录`)

    this.poll()
  }

  stop() {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // 唤醒正在 sleep 的 poll 循环，回到 while 顶部检查 running 后退出
    this.wakeSleep?.()
    this.wakeSleep = null
  }

  private async poll() {
    while (this.running) {
      try {
        const processed = await this.processNext()
        if (!processed) await this.sleep(3000) // 队列空，等 3s 再查
      } catch (err) {
        // 兜底：轮询/抢锁的 sql 报错不能逃出循环（否则 unhandled rejection 崩 worker），记日志后继续
        logger.error('[worker] 轮询异常: ', err)
        await this.sleep(3000)
      }
    }
  }

  /** 取一条 pending 并处理。返回 false 表示队列空（调用方 sleep 后再查）；抢锁失败/已处理返回 true 直接查下一条 */
  private async processNext(): Promise<boolean> {
    const trace = this.ctx.traces.getPendingTrace()
    if (!trace) return false

    // 原子抢锁：pending → processing，失败说明被其他进程抢走
    const locked = this.ctx.traces.updateTraceStatus(
      trace.id,
      TRACE_STATUS.PENDING,
      TRACE_STATUS.PROCESSING
    )
    if (!locked) return true

    this.ctx.emit('trace/status', trace.thread_id, TRACE_STATUS.PROCESSING)
    logger.info(`[worker] 开始处理: ${trace.thread_id}`)

    // logger 自动关联 threadId
    await threadContext.run(trace.thread_id, async () => {
      try {
        await this.ctx.agent.run(trace.input_text, trace.thread_id)

        this.ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE)
        this.ctx.emit('trace/status', trace.thread_id, TRACE_STATUS.DONE)
        logger.info(`[worker] agent run done: ${trace.thread_id}`)
      } catch (err) {
        // agent.run 已 emit agent/error（lark 订阅回消息），这里只标记失败
        this.ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.FAILED)
        this.ctx.emit('trace/status', trace.thread_id, TRACE_STATUS.FAILED)
        logger.error(`[worker] agent run fail: ${trace.thread_id}`, err)
      }
    })
    return true
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.wakeSleep = resolve
      this.timer = setTimeout(() => {
        this.timer = null
        this.wakeSleep = null
        resolve()
      }, ms)
    })
  }
}
