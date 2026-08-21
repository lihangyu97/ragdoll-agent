import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { initSchema } from '../src/sqlite/base/schema'
import { getDb } from '../src/sqlite/base/db'
import { ensureThread, THREAD_STATUS } from '../src/sqlite/agentThreads'

initSchema()

beforeEach(() => {
  getDb().exec('DELETE FROM agent_threads;')
})

test('ensureThread 创建记录，status 默认 active', () => {
  ensureThread('t1', 'p2p', 'chat-1', 'ou-1')
  const row = getDb().prepare(`SELECT * FROM agent_threads WHERE thread_id = ?`).get('t1') as {
    thread_id: string
    chat_type: string
    chat_id: string
    sender_open_id: string | null
    status: string
  }
  assert.equal(row.thread_id, 't1')
  assert.equal(row.chat_type, 'p2p')
  assert.equal(row.sender_open_id, 'ou-1')
  assert.equal(row.status, THREAD_STATUS.ACTIVE)
})

test('ensureThread 幂等：重复调用不报错、不重复插入', () => {
  ensureThread('t1', 'p2p', 'chat-1', 'ou-1')
  ensureThread('t1', 'group', 'chat-2', 'ou-2') // 已存在则忽略
  const count = getDb()
    .prepare(`SELECT COUNT(*) as c FROM agent_threads WHERE thread_id = ?`)
    .get('t1') as { c: number }
  assert.equal(count.c, 1)
})
