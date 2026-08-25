import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync | null = null
let dbPath: string | null = null

/**
 * 获取单例数据库连接。
 * 首次调用（或路径变化）时建连接；database Service 在构造时以配置的 dbPath 初始化，
 * 其余调用复用连接。无参且未建时兜底环境变量（logger 早期落库场景）。
 */
export function getDb(path?: string): DatabaseSync {
  if (!db || (path && path !== dbPath)) {
    const resolved = path ?? process.env.DB_PATH ?? 'data/agent.db'
    dbPath = resolved
    mkdirSync(dirname(resolved), { recursive: true })
    db = new DatabaseSync(resolved)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
  }
  return db
}
