import { Service, type Context } from 'cordis'
import { and, eq, max } from 'drizzle-orm'
import { agentTurns, TURN_HOOK } from '@/services/data/database/schema'

export type AgentTurnRecord = typeof agentTurns.$inferSelect

/** 插入一行 turn 记录所需字段（id / createdAt 由数据库生成；可空列可省略） */
export type InsertTurnParams = typeof agentTurns.$inferInsert

declare module 'cordis' {
  interface Context {
    turns: TurnsService
  }
}

/** turns Service：agent_turns 每轮轨迹 repository（由 turn-recorder 插件写入） */
export default class TurnsService extends Service {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, 'turns')
  }

  /**
   * 取某 thread 当前最大轮次，没有记录返回 0。
   * 过滤 hook_type='INPUT'（语义等价：每轮必有 INPUT 且同轮各 hook 共享 turn_no），
   * 使查询能命中部分唯一索引 agent_turns(thread_id, turn_no) WHERE INPUT，避免全表扫。
   */
  getMaxTurnNo(threadId: string): number {
    const row = this.ctx.database.db
      .select({ max: max(agentTurns.turnNo) })
      .from(agentTurns)
      .where(and(eq(agentTurns.threadId, threadId), eq(agentTurns.hookType, TURN_HOOK.INPUT)))
      .get()
    return row?.max ?? 0
  }

  /** 某 thread 的下一轮次号：当前最大轮次 + 1（无记录从 1 开始）。由 AgentService 在 input 时调用一次 */
  nextTurnNo(threadId: string): number {
    return this.getMaxTurnNo(threadId) + 1
  }

  /** 写入一行 turn 记录 */
  insertTurn(record: InsertTurnParams) {
    this.ctx.database.db.insert(agentTurns).values(record).run()
  }

  /** 批量写入多行 turn 记录（单条 INSERT 多 VALUES） */
  insertTurns(records: InsertTurnParams[]) {
    if (records.length === 0) return
    this.ctx.database.db.insert(agentTurns).values(records).run()
  }
}
