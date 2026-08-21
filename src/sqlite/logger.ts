import { getDb } from './db'

export function insertLog(
  level: string,
  message: string,
  data: string | null,
  threadId: string | null
) {
  getDb()
    .prepare(`INSERT INTO logger (level, message, data, thread_id) VALUES (?, ?, ?, ?)`)
    .run(level, message, data, threadId)
}
