import { Service, type Context } from 'cordis'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import { agentTraces, TRACE_STATUS, type TraceStatus } from '@/services/data/database/schema'

export { TRACE_STATUS } from '@/services/data/database/schema'
export type { TraceStatus } from '@/services/data/database/schema'

export type AgentTraceRecord = typeof agentTraces.$inferSelect

/** trace/status 事件载荷：worker 状态流转广播 */
export interface TraceStatusEvent {
  threadId: string
  status: TraceStatus
}

/** 心跳租约超时（秒）：processing 的 heartbeat_at 超过该时长未刷新视为"无主"（进程崩溃/卡死残留）。
 *  必须大于心跳刷新间隔（HEARTBEAT_INTERVAL_MS = 30s）并留足抖动冗余，否则会把正在跑的 trace 误判。 */
export const LEASE_TIMEOUT_SECONDS = 90

declare module 'cordis' {
  interface Context {
    traces: TracesService
  }
}

/**
 * traces Service：agent_traces 队列能力（enqueue / 抢锁 / 状态流转）。
 * lark 生产、worker 消费，两边注入。drizzle better-sqlite3 为同步驱动。
 */
export default class TracesService extends Service {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, 'traces')
  }

  /** 插入一条消息 trace（pending），返回新记录 id；channel 为来源渠道（出站回复路由依据） */
  insertTrace(
    threadId: string,
    messageId: string,
    chatId: string,
    inputText: string,
    channel: string
  ): number {
    const [row] = this.ctx.database.db
      .insert(agentTraces)
      .values({ threadId, messageId, chatId, inputText, channel, status: TRACE_STATUS.PENDING })
      .returning({ id: agentTraces.id })
      .all()
    return row?.id ?? 0
  }

  /** 取最早一条 pending 的 trace */
  getPendingTrace(): AgentTraceRecord | null {
    const row = this.ctx.database.db
      .select()
      .from(agentTraces)
      .where(eq(agentTraces.status, TRACE_STATUS.PENDING))
      .orderBy(asc(agentTraces.createdAt))
      .limit(1)
      .get()
    return row ?? null
  }

  /** 原子更新状态（仅当当前状态匹配时） */
  updateTraceStatus(id: number, fromStatus: TraceStatus, toStatus: TraceStatus): boolean {
    const result = this.ctx.database.db
      .update(agentTraces)
      .set({ status: toStatus, updatedAt: sql`datetime('now', 'localtime')` })
      .where(and(eq(agentTraces.id, id), eq(agentTraces.status, fromStatus)))
      .run()
    return result.changes > 0
  }

  /** 原子抢锁（pending → processing），同时领取心跳租约（写 heartbeat_at） */
  claimTrace(id: number): boolean {
    const result = this.ctx.database.db
      .update(agentTraces)
      .set({
        status: TRACE_STATUS.PROCESSING,
        heartbeatAt: sql`datetime('now', 'localtime')`,
        updatedAt: sql`datetime('now', 'localtime')`
      })
      .where(and(eq(agentTraces.id, id), eq(agentTraces.status, TRACE_STATUS.PENDING)))
      .run()
    return result.changes > 0
  }

  /** 刷新心跳租约（仅当仍处于 processing：已回收/已完成的 trace 不续命） */
  heartbeat(id: number): void {
    this.ctx.database.db
      .update(agentTraces)
      .set({ heartbeatAt: sql`datetime('now', 'localtime')` })
      .where(and(eq(agentTraces.id, id), eq(agentTraces.status, TRACE_STATUS.PROCESSING)))
      .run()
  }

  /**
   * 回收租约过期的 processing 记录（heartbeat_at 超 LEASE_TIMEOUT_SECONDS 未刷新）重置回 pending。
   * 心跳证明活性，多实例下正在跑的实例不会被判死；恢复语义 = 至少一次（工具副作用需幂等）。返回重置条数。
   */
  resetStaleProcessingTraces(): number {
    const result = this.ctx.database.db
      .update(agentTraces)
      .set({ status: TRACE_STATUS.PENDING, updatedAt: sql`datetime('now', 'localtime')` })
      .where(
        and(
          eq(agentTraces.status, TRACE_STATUS.PROCESSING),
          lt(
            agentTraces.heartbeatAt,
            sql`datetime('now', 'localtime', ${`-${LEASE_TIMEOUT_SECONDS} seconds`})`
          )
        )
      )
      .run()
    return result.changes
  }
}
