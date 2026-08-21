process.env.DB_PATH = ':memory:' // 必须在 import 被测模块之前

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifySqliteError, safeRun, safeGet } from '../src/sqlite/base/safe'
import { initSchema } from '../src/sqlite/base/schema'
import { getDb } from '../src/sqlite/base/db'

initSchema()

function fakeError(errcode: number) {
  return Object.assign(new Error(`err ${errcode}`), { errcode })
}

test('errcode=1 → schema（语法/表不存在）', () => {
  assert.equal(classifySqliteError(fakeError(1)).kind, 'schema')
})

test('约束类：787 FK / 1299 NOT NULL / 2067 UNIQUE / 275 CHECK → constraint', () => {
  for (const code of [787, 1299, 2067, 275]) {
    assert.equal(classifySqliteError(fakeError(code)).kind, 'constraint', `errcode=${code}`)
  }
})

test('资源类：5 BUSY / 13 FULL / 10 IOERR → resource', () => {
  for (const code of [5, 13, 10]) {
    assert.equal(classifySqliteError(fakeError(code)).kind, 'resource', `errcode=${code}`)
  }
})

test('无 errcode → unknown', () => {
  assert.equal(classifySqliteError(new Error('plain')).kind, 'unknown')
})

test('保留 message 与 errcode', () => {
  const info = classifySqliteError(fakeError(1299))
  assert.equal(info.errcode, 1299)
  assert.match(info.message, /1299/)
})

test('safeRun 正常写返回受影响行数', () => {
  safeRun(`CREATE TABLE t (a TEXT NOT NULL)`)
  assert.equal(safeRun(`INSERT INTO t (a) VALUES (?)`, ['x']), 1)
  assert.equal(safeRun(`INSERT INTO t (a) VALUES (?)`, ['y']), 1)
})

test('safeGet 正常读返回行 / 无结果 undefined', () => {
  const row = safeGet<{ a: string }>(`SELECT a FROM t WHERE a = ?`, ['x'])
  assert.equal(row?.a, 'x')
  assert.equal(safeGet<{ a: string }>(`SELECT a FROM t WHERE a = ?`, ['nope']), undefined)
})

test('错误 SQL：rethrow 且 logger 表有记录', () => {
  assert.throws(() => safeGet(`SELECT * FROM no_such_table`, []))
  const logs = getDb()
    .prepare(`SELECT message FROM logger WHERE level = 'error' ORDER BY id DESC LIMIT 1`)
    .get() as { message: string } | undefined
  assert.ok(logs, '应有一条 error 日志')
  assert.match(logs.message, /\[sqlite\] 执行失败/)
})
