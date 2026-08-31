process.env.RAGDOLL_DB_PATH = ':memory:'

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, sql } from 'drizzle-orm'
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
  ctx.traces.insertTrace(threadId, messageId, 'chat-1', text, 'lark')
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
  const row = ctx.database.db
    .select({ status: agentTraces.status })
    .from(agentTraces)
    .where(eq(agentTraces.id, trace.id))
    .get()
  assert.equal(row?.status, TRACE_STATUS.PROCESSING)
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

test('claimTrace：抢锁成功（pending → processing）并领取心跳租约', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()!
  assert.equal(ctx.traces.claimTrace(trace.id), true)
  const row = ctx.database.db
    .select({ status: agentTraces.status, heartbeatAt: agentTraces.heartbeatAt })
    .from(agentTraces)
    .where(eq(agentTraces.id, trace.id))
    .get()
  assert.equal(row?.status, TRACE_STATUS.PROCESSING)
  assert.ok(row?.heartbeatAt) // 租约已写
})

test('claimTrace：已被抢走（非 pending）→ false', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()!
  assert.equal(ctx.traces.claimTrace(trace.id), true)
  assert.equal(ctx.traces.claimTrace(trace.id), false) // 已是 processing
})

test('heartbeat：processing 时刷新租约；done 后不刷（状态条件不匹配）', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()!
  ctx.traces.claimTrace(trace.id)
  ctx.database.db
    .update(agentTraces)
    .set({ heartbeatAt: sql`datetime('now', 'localtime', '-2 minutes')` })
    .where(eq(agentTraces.id, trace.id))
    .run()
  const stale = ctx.database.db
    .select({ heartbeatAt: agentTraces.heartbeatAt })
    .from(agentTraces)
    .where(eq(agentTraces.id, trace.id))
    .get()?.heartbeatAt
  ctx.traces.heartbeat(trace.id)
  const row = ctx.database.db
    .select({ status: agentTraces.status, heartbeatAt: agentTraces.heartbeatAt })
    .from(agentTraces)
    .where(eq(agentTraces.id, trace.id))
    .get()
  assert.notEqual(row?.heartbeatAt, stale) // 已刷新回当前时间

  ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE)
  ctx.database.db
    .update(agentTraces)
    .set({ heartbeatAt: sql`datetime('now', 'localtime', '-2 minutes')` })
    .where(eq(agentTraces.id, trace.id))
    .run()
  const doneStale = ctx.database.db
    .select({ heartbeatAt: agentTraces.heartbeatAt })
    .from(agentTraces)
    .where(eq(agentTraces.id, trace.id))
    .get()?.heartbeatAt
  ctx.traces.heartbeat(trace.id)
  const doneRow = ctx.database.db
    .select({ heartbeatAt: agentTraces.heartbeatAt })
    .from(agentTraces)
    .where(eq(agentTraces.id, trace.id))
    .get()
  assert.equal(doneRow?.heartbeatAt, doneStale) // done 状态下不刷新
})

test('resetStaleProcessingTraces：租约过期（heartbeat_at >90s 未刷新）的重置回 pending', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()!
  ctx.traces.updateTraceStatus(trace.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  // 把 heartbeat_at 改到 2 分钟前，模拟进程崩溃/卡死后遗留的无主 processing
  ctx.database.db
    .update(agentTraces)
    .set({ heartbeatAt: sql`datetime('now', 'localtime', '-2 minutes')` })
    .where(eq(agentTraces.id, trace.id))
    .run()
  const reset = ctx.traces.resetStaleProcessingTraces()
  assert.equal(reset, 1)
  assert.equal(ctx.traces.getPendingTrace()?.id, trace.id) // 又能被领取
})

test('resetStaleProcessingTraces：租约新鲜的 processing 不重置（多实例安全，不误伤正在跑的）', () => {
  seedTrace('t1', 'hello')
  const trace = ctx.traces.getPendingTrace()!
  ctx.traces.claimTrace(trace.id) // 正常领取：租约是新鲜的
  const reset = ctx.traces.resetStaleProcessingTraces()
  assert.equal(reset, 0)
  const row = ctx.database.db
    .select({ status: agentTraces.status })
    .from(agentTraces)
    .where(eq(agentTraces.id, trace.id))
    .get()
  assert.equal(row?.status, TRACE_STATUS.PROCESSING) // 仍是 processing，未被误重置
})

test('FK：插入不存在的 thread_id 抛约束错误', () => {
  assert.throws(() => ctx.traces.insertTrace('no-such-thread', 'm-x', 'chat-1', 'hello', 'lark'))
})
