process.env.DB_PATH = ':memory:'

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import DatabaseService from '../src/services/data/database/DatabaseService'
import ThreadsService, { THREAD_STATUS } from '../src/services/data/threads/ThreadsService'

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: ':memory:' })
await ctx.plugin(ThreadsService)

beforeEach(() => {
  ctx.database.run('DELETE FROM agent_threads')
})

test('ensureThread 创建记录，status 默认 active', () => {
  ctx.threads.ensureThread('t1', 'p2p', 'chat-1', 'ou-1')
  const row = ctx.database.get<{
    thread_id: string
    chat_type: string
    chat_id: string
    sender_open_id: string | null
    status: string
  }>(`SELECT * FROM agent_threads WHERE thread_id = ?`, ['t1'])
  assert.ok(row)
  assert.equal(row.thread_id, 't1')
  assert.equal(row.chat_type, 'p2p')
  assert.equal(row.sender_open_id, 'ou-1')
  assert.equal(row.status, THREAD_STATUS.ACTIVE)
})

test('ensureThread 幂等：重复调用不报错、不重复插入', () => {
  ctx.threads.ensureThread('t1', 'p2p', 'chat-1', 'ou-1')
  ctx.threads.ensureThread('t1', 'group', 'chat-2', 'ou-2') // 已存在则忽略
  const count = ctx.database.get<{ c: number }>(
    `SELECT COUNT(*) as c FROM agent_threads WHERE thread_id = ?`,
    ['t1']
  )
  assert.equal(count?.c, 1)
})
