import { Service, type Context } from 'cordis'
import {
  TRACE_STATUS,
  type AgentTraceRecord,
  type TraceStatusEvent
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
    'trace/status': (payload: TraceStatusEvent) => void
    // 规则层路由策略点（bail）：监听器返回 agentId 即命中（确定性规则，如群绑定/命令/关键词）；
    // 全部未命中则走 agentClient LLM 识别兜底
    'agent/resolve': (threadId: string, input: string) => string | void
  }
}

const POLL_INTERVAL_MS = 3_000
/** 心跳刷新间隔：处理期间周期续租，证明本实例存活（30s，租约超时见 TracesService.LEASE_TIMEOUT_SECONDS） */
const HEARTBEAT_INTERVAL_MS = 30_000
/** 租约 sweep 周期：周期性回收租约过期的 processing trace（不依赖重启，单实例也能自愈） */
const SWEEP_INTERVAL_MS = 60_000

/**
 * worker Service：周期轮询 agent_traces 队列，取 pending 记录交给 process 处理
 * （路由归属 → agent.run → 出站回复）。处理期间持有租约（30s 心跳续租），
 * 租约过期（90s 未刷新）的 trace 由周期 sweep 回收重派——多实例安全，恢复语义为至少一次。
 */
export default class WorkerService extends Service {
  static inject = ['agent', 'capability', 'traces', 'threads', 'channel']

  private timer: ReturnType<typeof setInterval> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private processing = false
  /** 当前持有租约的 trace id（worker 串行处理，同一时刻至多一条；心跳 timer 据此续租） */
  private currentTraceId: number | null = null
  private lastSweepAt = 0

  constructor(ctx: Context) {
    super(ctx, 'worker')
  }

  start() {
    if (this.timer) return
    this.lastSweepAt = 0 // 让首轮 poll 顺带做一次启动 sweep（回收崩溃遗留）
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
    this.heartbeatTimer = setInterval(() => {
      if (this.currentTraceId !== null) this.ctx.traces.heartbeat(this.currentTraceId)
    }, HEARTBEAT_INTERVAL_MS)
    this.poll()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.currentTraceId = null
  }

  /** 启动恢复改为 poll 内周期 sweep：首轮必触发（lastSweepAt=0），此后每 SWEEP_INTERVAL_MS 一次 */
  private maybeSweep() {
    const now = Date.now()
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return
    this.lastSweepAt = now
    const recovered = this.ctx.traces.resetStaleProcessingTraces()
    if (recovered > 0) {
      logger.warn(`[worker] 回收 ${recovered} 条租约过期的 processing trace`)
    }
  }

  private async poll() {
    if (this.processing) return
    this.processing = true
    try {
      this.maybeSweep()
      while (true) {
        const trace = this.ctx.traces.getPendingTrace()
        if (!trace) return

        // 原子抢锁 + 领租约：失败说明被其他进程抢走
        const locked = this.ctx.traces.claimTrace(trace.id)
        if (!locked) continue

        this.currentTraceId = trace.id
        try {
          // process 内部自兜底（标记 failed + 出站失败回复），永不外抛：单条失败不中断队列
          await this.process(trace)
        } finally {
          this.currentTraceId = null
        }
      }
    } catch (err) {
      // 队列基础设施异常（取队列/抢锁本身出错）：记录后等下一轮 poll 重试
      logger.error('[worker] 轮询异常: ', err)
    } finally {
      this.processing = false
    }
  }

  /**
   * process：trace 消费入口（worker 不再直接 run）。单条 trace 的唯一兜底出口：
   * 成功 → DONE + 正常回复；任何失败（run 重抛 / 路由 / DB / 回复）→ FAILED + 失败回复。
   * 1. thread 已绑定 agent → 直接用；
   * 2. 未绑定 → 规则层（agent/resolve bail 事件）→ 未命中则 agentClient 识别（LLM 兜底）；
   * 3. 识别 null / 失败 / agent 不存在 → 降级 default；
   * 4. 绑定 thread（一次性定终身）→ run → 出站回复。
   */
  private async process(trace: AgentTraceRecord) {
    try {
      this.ctx.emit('trace/status', { threadId: trace.threadId, status: TRACE_STATUS.PROCESSING })

      await threadContext.run(trace.threadId, async () => {
        logger.info('[worker] 开始处理')
        const agentId = await this.resolveAgentId(trace)
        const answer = await this.ctx.agent.run(trace.inputText, trace.threadId, agentId)

        // 结果与回复都挂在 CAS 成功之后：租约被回收重派后所有权易主，
        // 旧实例的收尾不得再写状态/回复（at-least-once 下防用户收到两条回复）
        if (
          this.ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE)
        ) {
          this.ctx.emit('trace/status', { threadId: trace.threadId, status: TRACE_STATUS.DONE })
          logger.info(`[worker] agent run done (agent=${agentId})`)
          await this.replyIfNeeded(trace, answer)
        } else {
          logger.warn(`[worker] trace 所有权已易主，放弃结果（id=${trace.id}）`)
        }
      })
    } catch (err) {
      // agent.run 失败时内部已 emit agent/error 后重抛，这里统一收口：
      // 标记 failed（CAS 保证已 done 的 trace 不会被误标）+ 出站失败回复
      logger.error(`[worker] trace 处理失败（id=${trace.id} thread=${trace.threadId}）: `, err)
      if (
        this.ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.FAILED)
      ) {
        this.ctx.emit('trace/status', { threadId: trace.threadId, status: TRACE_STATUS.FAILED })
        await this.replyIfNeeded(trace, `Agent 处理失败：${stringify(err)}`)
      }
    }
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

  /** 完成路径出站回复：按 trace.channel 路由到对应渠道 adapter（worker 不感知具体渠道）。
   *  内部再兜一层：adapter 失败返回 false 不抛，sync 抛错也吞掉——保证 process 的兜底出口永不外抛。 */
  private async replyIfNeeded(trace: AgentTraceRecord, text: string | null) {
    if (!trace.channel || !trace.messageId || !text) return
    try {
      await this.ctx.channel.send({ channel: trace.channel, messageId: trace.messageId, text })
    } catch (err) {
      logger.error('[worker] 出站回复异常: ', err)
    }
  }
}
