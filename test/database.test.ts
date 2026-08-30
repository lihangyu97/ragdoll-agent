process.env.RAGDOLL_DB_PATH = ':memory:'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import DatabaseService from '../src/services/data/database/DatabaseService'
import { channelMessages } from '../src/services/data/database/schema'
import { getDb } from '../src/utils/sqlite'

const ctx = new Context()
await ctx.plugin(DatabaseService, { dbPath: ':memory:' })

test('migrate 应用 schema 迁移建出全部表', () => {
  const tables = [
    'channel_messages',
    'channel_users',
    'agent_turns',
    'agent_threads',
    'agent_traces',
    'logger'
  ]
  for (const name of tables) {
    const row = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name)
    assert.ok(row, `表 ${name} 应存在`)
  }
})

test('drizzle 实例可用（空表 select）', () => {
  const rows = ctx.database.db.select().from(channelMessages).all()
  assert.deepEqual(rows, [])
})

test('exec 可执行 DDL / 清表', () => {
  ctx.database.exec('CREATE TABLE IF NOT EXISTS t (a TEXT)')
  ctx.database.exec('DROP TABLE t')
  assert.ok(true)
})
