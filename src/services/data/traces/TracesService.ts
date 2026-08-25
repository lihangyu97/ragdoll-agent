import { Service, type Context } from 'cordis'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { agentTraces, TRACE_STATUS, type TraceStatus } from '@/services/data/database/schema'

export { TRACE_STATUS } from '@/services/data/database/schema'
export type { TraceStatus } from '@/services/data/database/schema'

export type AgentTraceRecord = typeof agentTraces.$inferSelect

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

  /** 插入一条消息 trace（pending），返回新记录 id */
  insertTrace(threadId: string, messageId: string, chatId: string, inputText: string): number {
    const [row] = this.ctx.database.db
      .insert(agentTraces)
      .values({ threadId, messageId, chatId, inputText, status: TRACE_STATUS.PENDING })
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

  /** 取某 thread 最新一条 processing 的 trace（AGENT_RESULT 触发时 worker 尚未标记 done） */
  getLatestProcessingTrace(threadId: string): AgentTraceRecord | null {
    const row = this.ctx.database.db
      .select()
      .from(agentTraces)
      .where(
        and(eq(agentTraces.threadId, threadId), eq(agentTraces.status, TRACE_STATUS.PROCESSING))
      )
      .orderBy(desc(agentTraces.createdAt))
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

  /** worker 启动时调用：把上次进程遗留的 processing 记录重置回 pending（进程崩溃/重启后无主），返回重置条数 */
  resetStaleProcessingTraces(): number {
    const result = this.ctx.database.db
      .update(agentTraces)
      .set({ status: TRACE_STATUS.PENDING, updatedAt: sql`datetime('now', 'localtime')` })
      .where(eq(agentTraces.status, TRACE_STATUS.PROCESSING))
      .run()
    return result.changes
  }
}
