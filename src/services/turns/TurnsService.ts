import { Service, type Context } from 'cordis'
import type DatabaseService from '@/services/database/DatabaseService'

/** agent_turns 表的一行记录（表结构见 DatabaseService.initSchema） */
export type AgentTurnRecord = {
  id: number
  thread_id: string
  turn_no: number
  hook_type: string
  node: string | null
  msg_type: string | null
  tool_call_id: string | null
  tool_calls: string | null
  content: string | null
  tools_result: string | null
  created_at: string
}

/** 插入一行 turn 记录所需字段（id / created_at 由数据库生成） */
export type InsertTurnParams = Omit<AgentTurnRecord, 'id' | 'created_at'>

/** turns Service：agent_turns 每轮轨迹 repository（由 turn-recorder 插件写入） */
export default class TurnsService extends Service {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, 'turns')
  }

  /** 取某 thread 当前最大轮次，没有记录返回 0 */
  getMaxTurnNo(threadId: string): number {
    const row = this.ctx.database.get<{ max_turn: number | null }>(
      `SELECT MAX(turn_no) as max_turn FROM agent_turns WHERE thread_id = ?`,
      [threadId]
    )
    return row?.max_turn ?? 0
  }

  /** 写入一行 turn 记录 */
  insertTurn(record: InsertTurnParams) {
    this.ctx.database.run(
      `INSERT INTO agent_turns (thread_id, turn_no, hook_type, node, msg_type, tool_call_id, tool_calls, content, tools_result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.thread_id,
        record.turn_no,
        record.hook_type,
        record.node,
        record.msg_type,
        record.tool_call_id,
        record.tool_calls,
        record.content,
        record.tools_result
      ]
    )
  }
}
