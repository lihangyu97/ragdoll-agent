import { insertLog } from '@/sqlite/logger'
import { currentThreadId } from './context'

export function stringify(value: unknown): string {
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
