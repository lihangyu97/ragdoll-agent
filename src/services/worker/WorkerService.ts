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
    // 规则层路由策略点（bail）：监听器返回 agentId 即命中（确定性规则，如群绑定/命令/关键词）；
    // 全部未命中则走 agentClient LLM 识别兜底
    'agent/resolve': (threadId: string, input: string) => string | void
  }
}

const POLL_INTERVAL_MS = 3_000

/**
 * worker Service：周期轮询 agent_traces 队列，取 pending 记录交给 process 处理
 * （路由归属 → agent.run → 出站回复）。
 */
export default class WorkerService extends Service {
  static inject = ['agent', 'capability', 'traces', 'threads', 'lark']

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

        await this.process(trace)
      }
    } catch (err) {
      logger.error('[worker] 轮询异常: ', err)
    } finally {
      this.processing = false
    }
  }

  /**
   * process：trace 消费入口（worker 不再直接 run）。
   * 1. thread 已绑定 agent → 直接用；
   * 2. 未绑定 → 规则层（agent/resolve bail 事件）→ 未命中则 agentClient 识别（LLM 兜底）；
   * 3. 识别 null / 失败 / agent 不存在 → 降级 default；
   * 4. 绑定 thread（一次性定终身）→ run → 出站回复。
   */
  private async process(trace: AgentTraceRecord) {
    this.ctx.emit('trace/status', trace.threadId, TRACE_STATUS.PROCESSING)

    await threadContext.run(trace.threadId, async () => {
      logger.info('[worker] 开始处理')
      try {
        const agentId = await this.resolveAgentId(trace)
        const answer = await this.ctx.agent.run(trace.inputText, trace.threadId, agentId)

        this.ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE)
        this.ctx.emit('trace/status', trace.threadId, TRACE_STATUS.DONE)
        logger.info(`[worker] agent run done (agent=${agentId})`)
        await this.replyIfNeeded(trace, answer)
      } catch (err) {
        this.ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.FAILED)
        this.ctx.emit('trace/status', trace.threadId, TRACE_STATUS.FAILED)
        logger.error('[worker] agent run fail', err)
        await this.replyIfNeeded(trace, `Agent 处理失败：${stringify(err)}`)
      }
    })
  }

  /** 路由归属：已绑定 → 规则 → LLM 识别 → default */
  private async resolveAgentId(trace: AgentTraceRecord): Promise<string> {
    const bound = this.ctx.threads.getAgentId(trace.threadId)
    if (bound) return bound

    const rule = this.ctx.bail('agent/resolve', trace.threadId, trace.inputText)
    if (rule && this.ctx.capability.hasDefinition(rule)) {
      this.ctx.threads.setAgentId(trace.threadId, rule)
      return rule
    }

    const identified = await this.ctx.agent.identify(trace.inputText)
    const agentId =
      identified && this.ctx.capability.hasDefinition(identified) ? identified : 'default'
    this.ctx.threads.setAgentId(trace.threadId, agentId)
    logger.info(`[worker] thread ${trace.threadId} 绑定 agent=${agentId}`)
    return agentId
  }

  private async replyIfNeeded(trace: AgentTraceRecord, text: string | null) {
    if (!trace.messageId || !text) return
    await this.ctx.lark.reply(trace.messageId, text)
  }
}
