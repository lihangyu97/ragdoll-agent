import { safeRun } from './base/safe'

/** agent_threads.status：会话线程状态（唯一事实来源，禁止魔法字符串） */
export const THREAD_STATUS = {
  /** 活跃（当前唯一在用的取值） */
  ACTIVE: 'active',
  /** 停用/上下文已重置（docs 设计预留，暂无代码写入） */
  INACTIVE: 'inactive'
} as const

export type ThreadStatus = (typeof THREAD_STATUS)[keyof typeof THREAD_STATUS]

export type AgentThreadRecord = {
  thread_id: string
  chat_type: string
  chat_id: string
  sender_open_id: string | null
  status: ThreadStatus
}

/** 确保 thread 存在（没有则创建）。INSERT OR IGNORE 只在首次写入，sender_open_id 即会话发起者 */
export function ensureThread(
  threadId: string,
  chatType: string,
  chatId: string,
  senderOpenId: string | null
) {
  safeRun(
    `INSERT OR IGNORE INTO agent_threads (thread_id, chat_type, chat_id, sender_open_id)
     VALUES (?, ?, ?, ?)`,
    [threadId, chatType, chatId, senderOpenId]
  )
}
