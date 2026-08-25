import { Service, type Context } from 'cordis'
import { eq, max } from 'drizzle-orm'
import { agentTurns } from '@/services/data/database/schema'

export type AgentTurnRecord = typeof agentTurns.$inferSelect

/** 插入一行 turn 记录所需字段（id / createdAt 由数据库生成） */
export type InsertTurnParams = Omit<AgentTurnRecord, 'id' | 'createdAt'>

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

  /** 取某 thread 当前最大轮次，没有记录返回 0 */
  getMaxTurnNo(threadId: string): number {
    const row = this.ctx.database.db
      .select({ max: max(agentTurns.turnNo) })
      .from(agentTurns)
      .where(eq(agentTurns.threadId, threadId))
      .get()
    return row?.max ?? 0
  }

  /** 写入一行 turn 记录 */
  insertTurn(record: InsertTurnParams) {
    this.ctx.database.db.insert(agentTurns).values(record).run()
  }
}
