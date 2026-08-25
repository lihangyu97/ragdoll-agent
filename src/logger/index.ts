import { insertLog } from '@/sqlite/logger'
import { stringify } from '@/utils'
import { currentThreadId } from './context'

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
