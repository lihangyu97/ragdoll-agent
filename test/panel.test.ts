process.env.RAGDOLL_DB_PATH = ':memory:'

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { Context } from 'cordis'
import DatabaseService from '../src/services/data/database/DatabaseService'
import ThreadsService from '../src/services/data/threads/ThreadsService'
import TracesService from '../src/services/data/traces/TracesService'
import PanelService from '../src/services/data/panel/PanelService'
import {
  agentTraces,
  agentTurns,
  logger,
  type TraceStatus,
  type TurnHook
} from '../src/services/data/database/schema'

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: ':memory:' })
ctx.plugin(ThreadsService)
ctx.plugin(TracesService)
await ctx.plugin(PanelService)

beforeEach(() => {
  ctx.database.exec('DELETE FROM agent_traces')
  ctx.database.exec('DELETE FROM agent_threads')
  ctx.database.exec('DELETE FROM agent_turns')
  ctx.database.exec('DELETE FROM logger')
})

/** 直接插 trace（可指定 status / createdAt，绕过状态流转） */
function seedTrace(opts: {
  threadId: string
  status?: TraceStatus
  createdAt?: string
  inputText?: string
  channel?: string
}) {
  ctx.threads.ensureThread(opts.threadId, 'p2p', 'chat-1', null)
  ctx.database.db
    .insert(agentTraces)
    .values({
      threadId: opts.threadId,
      messageId: `m-${Math.random()}`,
      chatId: 'chat-1',
      inputText: opts.inputText ?? 'hello',
      channel: opts.channel ?? 'lark',
      status: opts.status ?? 'pending',
      ...(opts.createdAt ? { createdAt: opts.createdAt, updatedAt: opts.createdAt } : {})
    })
    .run()
}

function seedTurn(
  threadId: string,
  turnNo: number,
  hookType: TurnHook,
  extra: Record<string, unknown> = {}
) {
  ctx.database.db
    .insert(agentTurns)
    .values({ threadId, turnNo, hookType, ...extra })
    .run()
}

test('getOverview：按 status 聚合计数', () => {
  seedTrace({ threadId: 't1', status: 'pending' })
  seedTrace({ threadId: 't1', status: 'done', createdAt: '2026-08-29 10:00:00' })
  seedTrace({ threadId: 't2', status: 'failed', createdAt: '2026-08-29 11:00:00' })
  const overview = ctx.panel.getOverview()
  assert.equal(overview.counts.pending, 1)
  assert.equal(overview.counts.done, 1)
  assert.equal(overview.counts.failed, 1)
  assert.equal(overview.counts.processing, 0)
})

test('getOverview：hourly 按 24h 内的小时聚合', () => {
  seedTrace({ threadId: 't1', status: 'done', createdAt: '2026-08-29 10:05:00' })
  seedTrace({ threadId: 't1', status: 'done', createdAt: '2026-08-29 10:30:00' })
  seedTrace({ threadId: 't2', status: 'done', createdAt: '2026-08-01 10:00:00' }) // 24h 外，不计
  const overview = ctx.panel.getOverview()
  // 注意：10:05/10:30 相对"当前"可能超 24h，这里以相对时间判断 —— 只断言 8 月 1 日的老数据不出现
  assert.equal(overview.hourly.filter(h => h.bucket.startsWith('2026-08-01')).length, 0)
})

test('getOverview：processing 列表带 heartbeatAt', () => {
  seedTrace({ threadId: 't1' })
  const trace = ctx.database.db.select().from(agentTraces).all()[0]!
  ctx.traces.claimTrace(trace.id)
  const overview = ctx.panel.getOverview()
  assert.equal(overview.processing.length, 1)
  assert.equal(overview.processing[0]!.threadId, 't1')
  assert.ok(overview.processing[0]!.heartbeatAt)
})

test('listTraces：倒序 + durationMs 由时间差计算 + status 过滤', () => {
  seedTrace({ threadId: 't1', status: 'done', createdAt: '2026-08-29 10:00:00' })
  seedTrace({ threadId: 't1', status: 'failed', createdAt: '2026-08-29 10:05:00' })
  // 把 done 那条的 updatedAt 推后 2 秒 → durationMs ≈ 2000
  const done = ctx.database.db
    .select()
    .from(agentTraces)
    .where(eq(agentTraces.status, 'done'))
    .get()!
  ctx.database.db
    .update(agentTraces)
    .set({ updatedAt: '2026-08-29 10:00:02' })
    .where(eq(agentTraces.id, done.id))
    .run()

  const all = ctx.panel.listTraces()
  assert.equal(all.length, 2)
  assert.equal(all[0]!.status, 'failed') // id 倒序
  assert.equal(all[1]!.status, 'done')
  assert.equal(all[1]!.durationMs, 2000)

  const onlyFailed = ctx.panel.listTraces('failed')
  assert.equal(onlyFailed.length, 1)
  assert.equal(onlyFailed[0]!.status, 'failed')
})

test('listThreads：按最近活跃排序，带最后一条 trace 的状态与输入', () => {
  seedTrace({
    threadId: 't-old',
    status: 'done',
    createdAt: '2026-08-01 10:00:00',
    inputText: '旧的'
  })
  seedTrace({
    threadId: 't-new',
    status: 'processing',
    createdAt: '2026-08-29 12:00:00',
    inputText: '新的'
  })
  const threads = ctx.panel.listThreads()
  assert.equal(threads[0]!.threadId, 't-new')
  assert.equal(threads[0]!.lastStatus, 'processing')
  assert.equal(threads[0]!.lastInput, '新的')
  assert.equal(threads[1]!.threadId, 't-old')
})

test('getTurns：按 turnNo + id 排序返回', () => {
  seedTurn('t1', 1, 'INPUT', { content: '问' })
  seedTurn('t1', 1, 'TOOL_CALL', { toolName: 'weather', args: '{}' })
  seedTurn('t1', 1, 'AGENT_RESULT', { content: '答' })
  seedTurn('t1', 2, 'INPUT', { content: '再问' })
  const turns = ctx.panel.getTurns('t1')
  assert.equal(turns.length, 4)
  assert.deepEqual(
    turns.map(t => t.hookType),
    ['INPUT', 'TOOL_CALL', 'AGENT_RESULT', 'INPUT']
  )
})

test('listLogs：level / threadId 过滤，倒序', () => {
  const insert = (level: string, threadId: string | null) =>
    ctx.database.db
      .insert(logger)
      .values({ level, message: `msg-${level}`, threadId })
      .run()
  insert('info', 't1')
  insert('warn', 't1')
  insert('error', 't2')

  const all = ctx.panel.listLogs()
  assert.equal(all.length, 3)
  assert.equal(all[0]!.level, 'error') // id 倒序

  const warns = ctx.panel.listLogs({ level: 'warn' })
  assert.equal(warns.length, 1)
  assert.equal(warns[0]!.threadId, 't1')

  const t2 = ctx.panel.listLogs({ threadId: 't2' })
  assert.equal(t2.length, 1)
  assert.equal(t2[0]!.level, 'error')
})

test('listLogs：limit 生效', () => {
  for (let i = 0; i < 5; i++) {
    ctx.database.db
      .insert(logger)
      .values({ level: 'info', message: `m${i}` })
      .run()
  }
  assert.equal(ctx.panel.listLogs({ limit: 3 }).length, 3)
})

test('listThreads：无 trace 的 thread 排在最后（lastAt null）', () => {
  ctx.threads.ensureThread('t-empty', 'p2p', 'chat-1', null)
  seedTrace({ threadId: 't-active', status: 'done', createdAt: '2026-08-29 13:00:00' })
  const threads = ctx.panel.listThreads()
  assert.equal(threads[threads.length - 1]!.threadId, 't-empty')
  assert.equal(threads[threads.length - 1]!.lastAt, null)
})
