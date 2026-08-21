import { getDb } from './base/db'

/**
 * 日志落库。注意：不走 safe 层 —— 日志写入失败绝不能反过来中断业务或掩盖原错误，
 * 这里自行捕获并用 console 兜底。
 */
export function insertLog(
  level: string,
  message: string,
  data: string | null,
  threadId: string | null
) {
  try {
    getDb()
      .prepare(`INSERT INTO logger (level, message, data, thread_id) VALUES (?, ?, ?, ?)`)
      .run(level, message, data, threadId)
  } catch (err) {
    console.error('[sqlite] logger 写入失败:', err)
  }
}
