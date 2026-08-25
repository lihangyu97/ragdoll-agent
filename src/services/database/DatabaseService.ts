import { Service, type Context } from 'cordis'
import { getDb } from '@/sqlite/base/db'
import { THREAD_STATUS } from '@/services/threads/ThreadsService'
import { TRACE_STATUS } from '@/services/traces/TracesService'
import logger from '@/logger'
import { currentThreadId } from '@/logger/context'
import type { SQLInputValue, StatementSync } from 'node:sqlite'

export type SqliteErrorKind = 'schema' | 'constraint' | 'resource' | 'unknown'

export type SqliteErrorInfo = {
  kind: SqliteErrorKind
  errcode: number | null
  message: string
}

/**
 * database Service：单例连接 + 建表 + safe 执行 + 错误分级，所有数据模块的公共能力。
 * 底层连接用 getDb() 单例（双连接问题：agent checkpointer 另持有连接，见文档 §8）。
 */
export default class DatabaseService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'database')
    this.initSchema()
  }

  /** 错误分级：errcode 见 node:sqlite 抛出的 SQLite 扩展错误码 */
  static classifySqliteError(err: unknown): SqliteErrorInfo {
    const { errcode, message } = err as { errcode?: unknown; message?: unknown }
    const code = typeof errcode === 'number' ? errcode : null
    const msg = typeof message === 'string' ? message : String(err)

    let kind: SqliteErrorKind
    if (code == null) kind = 'unknown'
    // 低 8 位是主错误码：1 = SQLITE_ERROR（语法/表不存在等结构问题）
    else if ((code & 0xff) === 1) kind = 'schema'
    // 19 = SQLITE_CONSTRAINT 主码（扩展码低 8 位，如 787 FK / 1299 NOT NULL / 2067 UNIQUE / 275 CHECK）
    else if ((code & 0xff) === 19) kind = 'constraint'
    // 资源类主码：5 BUSY / 6 LOCKED / 13 FULL / 10 IOERR / 14 CANTOPEN / 8 READONLY / 11 CORRUPT
    else if ([5, 6, 8, 10, 11, 13, 14].includes(code & 0xff)) kind = 'resource'
    else kind = 'unknown'

    return { kind, errcode: code, message: msg }
  }

  /** 执行 DDL / 建表等（initSchema 与测试用） */
  exec(sql: string) {
    getDb().exec(sql)
  }

  /** 写操作（INSERT/UPDATE/DELETE），返回受影响行数 */
  run(sql: string, params: SQLInputValue[] = []): number {
    return this.runSafe(sql, params, stmt => Number(stmt.run(...params).changes))
  }

  /** 读单行 */
  get<T>(sql: string, params: SQLInputValue[] = []): T | undefined {
    return this.runSafe(sql, params, stmt => stmt.get(...params) as T | undefined)
  }

  /** 读多行 */
  all<T>(sql: string, params: SQLInputValue[] = []): T[] {
    return this.runSafe(sql, params, stmt => stmt.all(...params) as T[])
  }

  /** 统一执行：prepare + 执行，出错记完整日志后 rethrow，由调用方决定中断流程，不做静默降级 */
  private runSafe<T>(sql: string, params: SQLInputValue[], exec: (stmt: StatementSync) => T): T {
    try {
      const stmt = getDb().prepare(sql)
      return exec(stmt)
    } catch (err) {
      const info = DatabaseService.classifySqliteError(err)
      logger.error(`[sqlite] 执行失败: ${info.message}`, {
        kind: info.kind,
        errcode: info.errcode,
        sql: sql.replace(/\s+/g, ' ').trim().slice(0, 200),
        params,
        threadId: currentThreadId()
      })
      throw err
    }
  }

  /** 启动时统一建表（幂等） */
  private initSchema() {
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
}
