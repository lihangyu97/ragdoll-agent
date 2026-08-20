import { getDb } from './db'

export type AgentThreadRecord = {
  thread_id: string
  chat_type: string
  chat_id: string
  status: string
}

/** 确保 thread 存在（没有则创建） */
export function ensureThread(threadId: string, chatType: string, chatId: string) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agent_threads (thread_id, chat_type, chat_id)
       VALUES (?, ?, ?)`
    )
    .run(threadId, chatType, chatId)
}
