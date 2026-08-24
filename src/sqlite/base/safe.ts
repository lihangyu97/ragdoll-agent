import { getDb } from './db'
import type { SQLInputValue, StatementSync } from 'node:sqlite'
import logger from '@/logger'
import { currentThreadId } from '@/logger/context'

/**
 * SQLite 访问统一封装：所有数据模块的 prepare/run/get/all 都走这里。
 * 策略：出错 → 记录完整日志（SQL 摘要/参数/errcode/threadId）→ rethrow，
 * 由调用方决定中断流程（如飞书回传错误），不做静默降级。
 */

export type SqliteErrorKind = 'schema' | 'constraint' | 'resource' | 'unknown'

export type SqliteErrorInfo = {
  kind: SqliteErrorKind
  errcode: number | null
  message: string
}

/** 错误分级：errcode 见 node:sqlite 抛出的 SQLite 扩展错误码 */
export function classifySqliteError(err: unknown): SqliteErrorInfo {
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

/** 统一执行：prepare + 执行，出错记日志后 rethrow */
function runSafe<T>(sql: string, params: SQLInputValue[], exec: (stmt: StatementSync) => T): T {
  try {
    const stmt = getDb().prepare(sql)
    return exec(stmt)
  } catch (err) {
    const info = classifySqliteError(err)
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

/** 写操作（INSERT/UPDATE/DELETE），返回受影响行数 */
export function safeRun(sql: string, params: SQLInputValue[] = []): number {
  return runSafe(sql, params, stmt => Number(stmt.run(...params).changes))
}

/** 读单行 */
export function safeGet<T>(sql: string, params: SQLInputValue[] = []): T | undefined {
  return runSafe(sql, params, stmt => stmt.get(...params) as T | undefined)
}

/** 读多行 */
export function safeAll<T>(sql: string, params: SQLInputValue[] = []): T[] {
  return runSafe(sql, params, stmt => stmt.all(...params) as T[])
}
