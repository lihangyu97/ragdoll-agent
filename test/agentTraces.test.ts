import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { initSchema } from '../src/sqlite/base/schema'
import { getDb } from '../src/sqlite/base/db'
import { ensureThread } from '../src/sqlite/agentThreads'
import {
  insertTrace,
  getPendingTrace,
  getLatestProcessingTrace,
  updateTraceStatus,
  resetStaleProcessingTraces,
  TRACE_STATUS
} from '../src/sqlite/agentTraces'

initSchema()

// 每个用例前清空数据（先删子表 agent_traces，再删父表 agent_threads，避免 FK 拦截）
beforeEach(() => {
  getDb().exec('DELETE FROM agent_traces; DELETE FROM agent_threads;')
})

function seedTrace(threadId: string, text: string, messageId = 'm-1') {
  ensureThread(threadId, 'p2p', 'chat-1', null)
  insertTrace(threadId, messageId, 'chat-1', text)
}

test('insertTrace 后 getPendingTrace 能取到，status=pending', () => {
  seedTrace('t1', 'hello')
  const trace = getPendingTrace()
  assert.ok(trace)
  assert.equal(trace.thread_id, 't1')
  assert.equal(trace.status, TRACE_STATUS.PENDING)
})

test('getPendingTrace 取最早一条（按 created_at）', () => {
  seedTrace('t1', 'first')
  seedTrace('t2', 'second')
  const trace = getPendingTrace()
  assert.equal(trace?.input_text, 'first')
})

test('getPendingTrace 空队列返回 null', () => {
  assert.equal(getPendingTrace(), null)
})

test('updateTraceStatus CAS 匹配成功 → true 且状态变化', () => {
  seedTrace('t1', 'hello')
  const trace = getPendingTrace()!
  const ok = updateTraceStatus(trace.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  assert.equal(ok, true)
  assert.equal(getPendingTrace(), null) // 不再是 pending
  assert.equal(getLatestProcessingTrace('t1')?.status, TRACE_STATUS.PROCESSING)
})

test('updateTraceStatus CAS 不匹配 → false 且状态不变', () => {
  seedTrace('t1', 'hello')
  const trace = getPendingTrace()!
  const ok = updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE) // 当前是 pending
  assert.equal(ok, false)
  assert.equal(getPendingTrace()?.id, trace.id) // 仍是 pending
})

test('完整流转：pending → processing → done', () => {
  seedTrace('t1', 'hello')
  const trace = getPendingTrace()!
  updateTraceStatus(trace.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE)
  const row = getDb().prepare(`SELECT status FROM agent_traces WHERE id = ?`).get(trace.id) as {
    status: string
  }
  assert.equal(row.status, TRACE_STATUS.DONE)
})

test('失败路径：processing → failed', () => {
  seedTrace('t1', 'hello')
  const trace = getPendingTrace()!
  updateTraceStatus(trace.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.FAILED)
  const row = getDb().prepare(`SELECT status FROM agent_traces WHERE id = ?`).get(trace.id) as {
    status: string
  }
  assert.equal(row.status, TRACE_STATUS.FAILED)
})

test('getLatestProcessingTrace 返回 processing 状态的那条', () => {
  seedTrace('t1', 'first')
  seedTrace('t1', 'second')
  const first = getPendingTrace()!
  updateTraceStatus(first.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  const second = getPendingTrace()!
  updateTraceStatus(second.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  const latest = getLatestProcessingTrace('t1')!
  // created_at 秒级精度，同秒插入无法区分先后，只断言返回的是 processing 记录
  assert.equal(latest.status, TRACE_STATUS.PROCESSING)
  assert.ok([first.id, second.id].includes(latest.id))
})

test('resetStaleProcessingTraces 把 processing 重置回 pending', () => {
  seedTrace('t1', 'hello')
  const trace = getPendingTrace()!
  updateTraceStatus(trace.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  const reset = resetStaleProcessingTraces()
  assert.equal(reset, 1)
  assert.equal(getPendingTrace()?.id, trace.id) // 又能被领取
})

test('FK：插入不存在的 thread_id 抛 errcode=787', () => {
  assert.throws(
    () => insertTrace('no-such-thread', 'm-x', 'chat-1', 'hello'),
    (err: unknown) => (err as { errcode?: number }).errcode === 787
  )
})
