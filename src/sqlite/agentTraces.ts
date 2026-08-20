import { getDb } from "./db"

export type AgentTraceRecord = {
  id: number
  thread_id: string
  message_id: string
  chat_id: string
  input_text: string
  status: string
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
       WHERE status = 'pending'
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
       WHERE thread_id = ? AND status = 'processing'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(threadId) as AgentTraceRecord | undefined
  return row ?? null
}

/** 原子更新状态（仅当当前状态匹配时） */
export function updateTraceStatus(id: number, fromStatus: string, toStatus: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE agent_traces
       SET status = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ? AND status = ?`
    )
    .run(toStatus, id, fromStatus)
  return result.changes > 0
}
