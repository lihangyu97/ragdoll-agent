import { getDb } from './db'

export type AgentThreadRecord = {
  thread_id: string
  chat_type: string
  chat_id: string
  sender_open_id: string | null
  status: string
}

/** 确保 thread 存在（没有则创建）。INSERT OR IGNORE 只在首次写入，sender_open_id 即会话发起者 */
export function ensureThread(
  threadId: string,
  chatType: string,
  chatId: string,
  senderOpenId: string | null
) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_threads (thread_id, chat_type, chat_id, sender_open_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(threadId, chatType, chatId, senderOpenId)
}
