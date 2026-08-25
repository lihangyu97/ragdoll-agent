process.env.DB_PATH = ':memory:'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import DatabaseService from '../src/services/database/DatabaseService'

const ctx = new Context()
await ctx.plugin(DatabaseService)

function fakeError(errcode: number) {
  return Object.assign(new Error(`err ${errcode}`), { errcode })
}

test('errcode=1 → schema（语法/表不存在）', () => {
  assert.equal(DatabaseService.classifySqliteError(fakeError(1)).kind, 'schema')
})

test('约束类：787 FK / 1299 NOT NULL / 2067 UNIQUE / 275 CHECK → constraint', () => {
  for (const code of [787, 1299, 2067, 275]) {
    assert.equal(
      DatabaseService.classifySqliteError(fakeError(code)).kind,
      'constraint',
      `errcode=${code}`
    )
  }
})

test('资源类：5 BUSY / 13 FULL / 10 IOERR → resource', () => {
  for (const code of [5, 13, 10]) {
    assert.equal(
      DatabaseService.classifySqliteError(fakeError(code)).kind,
      'resource',
      `errcode=${code}`
    )
  }
})

test('无 errcode → unknown', () => {
  assert.equal(DatabaseService.classifySqliteError(new Error('plain')).kind, 'unknown')
})

test('保留 message 与 errcode', () => {
  const info = DatabaseService.classifySqliteError(fakeError(1299))
  assert.equal(info.errcode, 1299)
  assert.match(info.message, /1299/)
})

test('run 正常写返回受影响行数', () => {
  ctx.database.run(`CREATE TABLE t (a TEXT NOT NULL)`)
  assert.equal(ctx.database.run(`INSERT INTO t (a) VALUES (?)`, ['x']), 1)
  assert.equal(ctx.database.run(`INSERT INTO t (a) VALUES (?)`, ['y']), 1)
})

test('get 正常读返回行 / 无结果 undefined', () => {
  const row = ctx.database.get<{ a: string }>(`SELECT a FROM t WHERE a = ?`, ['x'])
  assert.equal(row?.a, 'x')
  assert.equal(ctx.database.get<{ a: string }>(`SELECT a FROM t WHERE a = ?`, ['nope']), undefined)
})

test('错误 SQL：rethrow 且 logger 表有记录', () => {
  assert.throws(() => ctx.database.get(`SELECT * FROM no_such_table`, []))
  const logs = ctx.database.get<{ message: string }>(
    `SELECT message FROM logger WHERE level = 'error' ORDER BY id DESC LIMIT 1`
  )
  assert.ok(logs, '应有一条 error 日志')
  assert.match(logs.message, /\[sqlite\] 执行失败/)
})
