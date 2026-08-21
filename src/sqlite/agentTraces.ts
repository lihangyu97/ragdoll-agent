import { getDb } from './db'

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

/** 插入一条消息 trace（pending） */
export function insertTrace(
  threadId: string,
  messageId: string,
  chatId: string,
  inputText: string
) {
  getDb()
    .prepare(
      `INSERT INTO agent_traces (thread_id, message_id, chat_id, input_text)
       VALUES (?, ?, ?, ?)`
    )
    .run(threadId, messageId, chatId, inputText)
}

/** 取最早一条 pending 的 trace */
export function getPendingTrace(): AgentTraceRecord | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM agent_traces
       WHERE status = '${TRACE_STATUS.PENDING}'
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get() as AgentTraceRecord | undefined
  return row ?? null
}

/** 取某 thread 最新一条 processing 的 trace（AGENT_RESULT 触发时 worker 尚未标记 done） */
export function getLatestProcessingTrace(threadId: string): AgentTraceRecord | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM agent_traces
       WHERE thread_id = ? AND status = '${TRACE_STATUS.PROCESSING}'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(threadId) as AgentTraceRecord | undefined
  return row ?? null
}

/** 原子更新状态（仅当当前状态匹配时） */
export function updateTraceStatus(
  id: number,
  fromStatus: TraceStatus,
  toStatus: TraceStatus
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE agent_traces
       SET status = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ? AND status = ?`
    )
    .run(toStatus, id, fromStatus)
  return result.changes > 0
}
