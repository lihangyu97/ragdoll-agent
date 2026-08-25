import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (!db) {
    const DB_PATH = process.env.DB_PATH ?? 'data/agent.db'
    mkdirSync(dirname(DB_PATH), { recursive: true })

    db = new DatabaseSync(DB_PATH)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
  }
  return db
}
