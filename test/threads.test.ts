process.env.RAGDOLL_DB_PATH = ':memory:'

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, count } from 'drizzle-orm'
import { Context } from 'cordis'
import DatabaseService from '../src/services/data/database/DatabaseService'
import ThreadsService, { THREAD_STATUS } from '../src/services/data/threads/ThreadsService'
import { agentThreads } from '../src/services/data/database/schema'

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: ':memory:' })
await ctx.plugin(ThreadsService)

beforeEach(() => {
  ctx.database.exec('DELETE FROM agent_threads')
})

test('ensureThread 创建记录，status 默认 active', () => {
  ctx.threads.ensureThread('t1', 'p2p', 'chat-1', 'ou-1')
  const row = ctx.database.db
    .select()
    .from(agentThreads)
    .where(eq(agentThreads.threadId, 't1'))
    .get()
  assert.ok(row)
  assert.equal(row.threadId, 't1')
  assert.equal(row.chatType, 'p2p')
  assert.equal(row.senderId, 'ou-1')
  assert.equal(row.status, THREAD_STATUS.ACTIVE)
})

test('ensureThread 幂等：重复调用不报错、不重复插入', () => {
  ctx.threads.ensureThread('t1', 'p2p', 'chat-1', 'ou-1')
  ctx.threads.ensureThread('t1', 'group', 'chat-2', 'ou-2') // 已存在则忽略
  const { c } = ctx.database.db
    .select({ c: count() })
    .from(agentThreads)
    .where(eq(agentThreads.threadId, 't1'))
    .get() ?? { c: 0 }
  assert.equal(c, 1)
})

test('getAgentId：新建 thread 默认 null；setAgentId 绑定后可读回', () => {
  ctx.threads.ensureThread('t1', 'p2p', 'chat-1', 'ou-1')
  assert.equal(ctx.threads.getAgentId('t1'), null)

  ctx.threads.setAgentId('t1', 'kb-bot')
  assert.equal(ctx.threads.getAgentId('t1'), 'kb-bot')

  ctx.threads.setAgentId('t1', 'default') // 可覆盖（绑定动作幂等）
  assert.equal(ctx.threads.getAgentId('t1'), 'default')
})
