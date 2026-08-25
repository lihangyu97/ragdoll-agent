import { Service, type Context } from 'cordis'
import type DatabaseService from '@/services/data/database/DatabaseService'

/** agent_traces.status：消息执行轨迹状态（唯一事实来源，禁止魔法字符串） */
export const TRACE_STATUS = {
  /** 已入队，等待 worker 领取 */
  PENDING: 'pending',
  /** worker 已抢锁，处理中 */
  PROCESSING: 'processing',
  /** 处理成功 */
  DONE: 'done',
  /** 处理失败 */
  FAILED: 'failed'
} as const

export type TraceStatus = (typeof TRACE_STATUS)[keyof typeof TRACE_STATUS]

export type AgentTraceRecord = {
  id: number
  thread_id: string
  message_id: string
  chat_id: string
  input_text: string
  status: TraceStatus
  created_at: string
}

/**
 * traces Service：agent_traces 队列能力（enqueue / 抢锁 / 状态流转）。
 * lark 生产、worker 消费，两边注入。
 */
export default class TracesService extends Service {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, 'traces')
  }

  /** 插入一条消息 trace（pending），返回新记录 id */
  insertTrace(threadId: string, messageId: string, chatId: string, inputText: string): number {
    const row = this.ctx.database.get<{ id: number }>(
      `INSERT INTO agent_traces (thread_id, message_id, chat_id, input_text)
       VALUES (?, ?, ?, ?)
       RETURNING id`,
      [threadId, messageId, chatId, inputText]
    )
    return row?.id ?? 0
  }

  /** 取最早一条 pending 的 trace */
  getPendingTrace(): AgentTraceRecord | null {
    const row = this.ctx.database.get<AgentTraceRecord>(
      `SELECT * FROM agent_traces
       WHERE status = '${TRACE_STATUS.PENDING}'
       ORDER BY created_at ASC
       LIMIT 1`
    )
    return row ?? null
  }

  /** 取某 thread 最新一条 processing 的 trace（AGENT_RESULT 触发时 worker 尚未标记 done） */
  getLatestProcessingTrace(threadId: string): AgentTraceRecord | null {
    const row = this.ctx.database.get<AgentTraceRecord>(
      `SELECT * FROM agent_traces
       WHERE thread_id = ? AND status = '${TRACE_STATUS.PROCESSING}'
       ORDER BY created_at DESC
       LIMIT 1`,
      [threadId]
    )
    return row ?? null
  }

  /** 原子更新状态（仅当当前状态匹配时） */
  updateTraceStatus(id: number, fromStatus: TraceStatus, toStatus: TraceStatus): boolean {
    const changes = this.ctx.database.run(
      `UPDATE agent_traces
       SET status = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ? AND status = ?`,
      [toStatus, id, fromStatus]
    )
    return changes > 0
  }

  /** worker 启动时调用：把上次进程遗留的 processing 记录重置回 pending（进程崩溃/重启后无主），返回重置条数 */
  resetStaleProcessingTraces(): number {
    return this.ctx.database.run(
      `UPDATE agent_traces
       SET status = '${TRACE_STATUS.PENDING}', updated_at = datetime('now', 'localtime')
       WHERE status = '${TRACE_STATUS.PROCESSING}'`
    )
  }
}
