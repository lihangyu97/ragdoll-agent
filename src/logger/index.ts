import { insertLog } from '@sqlite/logger'
import { threadContext } from './context'

/** 任意 JS 值统一 string 化：Error 取 message+stack，循环引用等 JSON 序列化失败时兜底 */
function stringify(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    return value.stack ? `${value.message}\n${value.stack}` : value.message
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 记录日志到 logger 表：第一个参数是原因描述，第二个是任意 JS 值（可选） */
export const logger = {
  info(message: string, data?: unknown) {
    insertLog('info', message, data === undefined ? null : stringify(data), currentThreadId())
  },
  warn(message: string, data?: unknown) {
    insertLog('warn', message, data === undefined ? null : stringify(data), currentThreadId())
  },
  error(message: string, data?: unknown) {
    insertLog('error', message, data === undefined ? null : stringify(data), currentThreadId())
  }
}

/** 读取当前 threadId 上下文，无则 null（全局日志不关联会话） */
function currentThreadId(): string | null {
  return threadContext.getStore() ?? null
}
