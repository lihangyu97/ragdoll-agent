import { getDb } from './sqlite'
import { currentThreadId } from './context'
import { stringify } from './index'

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

export default {
  info(message: string, data?: unknown) {
    insertLog('info', message, stringify(data), currentThreadId())
  },
  warn(message: string, data?: unknown) {
    insertLog('warn', message, stringify(data), currentThreadId())
  },
  error(message: string, data?: unknown) {
    insertLog('error', message, stringify(data), currentThreadId())
  }
}
