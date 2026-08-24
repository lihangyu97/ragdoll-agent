import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_PATH } from '@/config/sqlite'

let db: DatabaseSync | null = null

/** 获取单例数据库连接 */
export function getDb(): DatabaseSync {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true })
    db = new DatabaseSync(DB_PATH)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
  }
  return db
}
