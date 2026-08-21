import { getDb } from './db'
import { THREAD_STATUS } from '../agentThreads'
import { TRACE_STATUS } from '../agentTraces'

/** 启动时统一执行一次，初始化所有表 */
export function initSchema() {
  const db = getDb()

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_lark (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      app_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      thread_id TEXT,
      sender_open_id TEXT,
      sender_type TEXT NOT NULL,
      sender_name TEXT,
      content TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_lark_user (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      open_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      hook_type TEXT NOT NULL,
      node TEXT,
      msg_type TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      content TEXT,
      tools_result TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_threads (
      thread_id       TEXT PRIMARY KEY,
      chat_type       TEXT NOT NULL,
      chat_id         TEXT NOT NULL,
      sender_open_id  TEXT,
      status          TEXT NOT NULL DEFAULT '${THREAD_STATUS.ACTIVE}',
      created_at      TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at      TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_traces (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id   TEXT NOT NULL REFERENCES agent_threads(thread_id),
      message_id  TEXT NOT NULL,
      chat_id     TEXT NOT NULL,
      input_text  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT '${TRACE_STATUS.PENDING}',
      created_at  TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS logger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      level       TEXT NOT NULL,
      message     TEXT NOT NULL,
      data        TEXT,
      thread_id   TEXT,
      created_at  TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `)
}
