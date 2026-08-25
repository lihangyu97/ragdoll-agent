process.env.DB_PATH = ':memory:'

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { Context } from 'cordis'
import DatabaseService from '../src/services/data/database/DatabaseService'
import ThreadsService from '../src/services/data/threads/ThreadsService'
import TracesService, { TRACE_STATUS } from '../src/services/data/traces/TracesService'
import { agentTraces } from '../src/services/data/database/schema'

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: ':memory:' })
ctx.plugin(ThreadsService)
await ctx.plugin(TracesService)

// 每个用例前清空数据（先删子表 agent_traces，再删父表 agent_threads，避免 FK 拦截）
beforeEach(() => {
  ctx.database.exec('DELETE FROM agent_traces')
  ctx.database.exec('DELETE FROM agent_threads')
})

function seedTrace(threadId: string, text: string, messageId = 'm-1') {
  ctx.threads.ensureThread(threadId, 'p2p', 'chat-1', null)
  ctx.traces.insertTrace(threadId, messageId, 'chat-1', text)
}

function getStatus(traceId: number): string | undefined {
  return ctx.database.db
    .select({ status: agentTraces.status })
    .from(agentTraces)
    .where(eq(agentTraces.id, traceId))
    .get()?.status
}

test('insertTrace 后 getPendingTrace 能取到，status=pending', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()
  assert.ok(trace)
  assert.equal(trace.threadId, 't1')
  assert.equal(trace.status, TRACE_STATUS.PENDING)
})

test('getPendingTrace 取最早一条（按 created_at）', () => {
  seedTrace('t1', 'first')
  seedTrace('t2', 'second')
  const trace = ctx.traces.getPendingTrace()
  assert.equal(trace?.inputText, 'first')
})

test('getPendingTrace 空队列返回 null', () => {
  assert.equal(ctx.traces.getPendingTrace(), null)
})

test('updateTraceStatus CAS 匹配成功 → true 且状态变化', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()!
  const ok = ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  assert.equal(ok, true)
  assert.equal(ctx.traces.getPendingTrace(), null) // 不再是 pending
  assert.equal(ctx.traces.getLatestProcessingTrace('t1')?.status, TRACE_STATUS.PROCESSING)
})

test('updateTraceStatus CAS 不匹配 → false 且状态不变', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()!
  const ok = ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE) // 当前是 pending
  assert.equal(ok, false)
  assert.equal(ctx.traces.getPendingTrace()?.id, trace.id) // 仍是 pending
})

test('完整流转：pending → processing → done', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()!
  ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE)
  assert.equal(getStatus(trace.id), TRACE_STATUS.DONE)
})

test('失败路径：processing → failed', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()!
  ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.FAILED)
  assert.equal(getStatus(trace.id), TRACE_STATUS.FAILED)
})

test('getLatestProcessingTrace 返回 processing 状态的那条', () => {
  seedTrace('t1', 'first')
  seedTrace('t1', 'second')
  const first = ctx.traces.getPendingTrace()!
  ctx.traces.updateTraceStatus(first.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  const second = ctx.traces.getPendingTrace()!
  ctx.traces.updateTraceStatus(second.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  const latest = ctx.traces.getLatestProcessingTrace('t1')!
  // created_at 秒级精度，同秒插入无法区分先后，只断言返回的是 processing 记录
  assert.equal(latest.status, TRACE_STATUS.PROCESSING)
  assert.ok([first.id, second.id].includes(latest.id))
})

test('resetStaleProcessingTraces 把 processing 重置回 pending', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()!
  ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  const reset = ctx.traces.resetStaleProcessingTraces()
  assert.equal(reset, 1)
  assert.equal(ctx.traces.getPendingTrace()?.id, trace.id) // 又能被领取
})

test('FK：插入不存在的 thread_id 抛约束错误', () => {
  assert.throws(() => ctx.traces.insertTrace('no-such-thread', 'm-x', 'chat-1', 'hello'))
})
