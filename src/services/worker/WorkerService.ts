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
    // 后续观察状态可能有用...
    'trace/status': (threadId: string, status: TraceStatus) => void
  }
}

const POLL_INTERVAL_MS = 3_000

/**
 * worker Service：周期轮询 agent_traces 队列，取 pending 记录调用 ctx.agent.run 处理。
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
    this.poll()
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
      logger.error('[worker] 轮询异常: ', err)
    } finally {
      this.processing = false
    }
  }

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

  private async replyIfNeeded(trace: AgentTraceRecord, text: string | null) {
    if (!trace.messageId || !text) return
    await this.ctx.lark.reply(trace.messageId, text)
  }
}
