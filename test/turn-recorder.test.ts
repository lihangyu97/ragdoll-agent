process.env.DB_PATH = ':memory:'

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { asc, eq, max } from 'drizzle-orm'
import { Context } from 'cordis'
import DatabaseService from '../src/services/data/database/DatabaseService'
import TurnsService from '../src/services/data/turns/TurnsService'
import turnRecorder from '../src/plugins/turn-recorder'
import { agentTurns } from '../src/services/data/database/schema'

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: ':memory:' })
ctx.plugin(TurnsService)
await ctx.plugin(turnRecorder)

beforeEach(() => {
  ctx.database.exec('DELETE FROM agent_turns')
})

function getRows() {
  return ctx.database.db
    .select()
    .from(agentTurns)
    .where(eq(agentTurns.threadId, 't1'))
    .orderBy(asc(agentTurns.id))
    .all()
}

test('agent/input 开启新轮次，同轮事件写同一 turn_no', () => {
  ctx.emit('agent/input', { threadId: 't1', turnNo: 1, input: 'hello' })
  ctx.emit('agent/result', { threadId: 't1', turnNo: 1, node: 'model', text: 'hi' })

  const rows = getRows()
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.turnNo, 1)
  assert.equal(rows[0]?.hookType, 'INPUT')
  assert.equal(rows[0]?.content, 'hello')
  assert.equal(rows[1]?.hookType, 'AGENT_RESULT')
  assert.equal(rows[1]?.content, 'hi')
})

test('连续两轮 turn_no 由载荷决定并递增', () => {
  ctx.emit('agent/input', { threadId: 't1', turnNo: 1, input: 'first' })
  ctx.emit('agent/result', { threadId: 't1', turnNo: 1, node: 'model', text: 'r1' })
  ctx.emit('agent/input', { threadId: 't1', turnNo: 2, input: 'second' })
  ctx.emit('agent/result', { threadId: 't1', turnNo: 2, node: 'model', text: 'r2' })

  const row = ctx.database.db
    .select({ max: max(agentTurns.turnNo) })
    .from(agentTurns)
    .where(eq(agentTurns.threadId, 't1'))
    .get()
  assert.equal(row?.max, 2)
})

test('交错线程各记各的轮次（payload 自带身份，乱序到达也不丢不串）', () => {
  ctx.emit('agent/input', { threadId: 't1', turnNo: 1, input: 'hello' })
  ctx.emit('agent/input', { threadId: 't2', turnNo: 1, input: 'hi' })
  // t1 的事件晚于 t2 的 input 到达：旧实现会被"当前活跃轮次"守卫丢弃，现在不会
  ctx.emit('agent/result', { threadId: 't1', turnNo: 1, node: 'model', text: 'a' })
  ctx.emit('agent/result', { threadId: 't2', turnNo: 1, node: 'model', text: 'b' })

  const rows = ctx.database.db.select().from(agentTurns).orderBy(asc(agentTurns.id)).all()
  assert.equal(rows.length, 4)
  const t1Rows = rows.filter(r => r.threadId === 't1')
  const t2Rows = rows.filter(r => r.threadId === 't2')
  assert.equal(t1Rows.length, 2)
  assert.ok(t1Rows.every(r => r.turnNo === 1))
  assert.equal(t2Rows.length, 2)
  assert.ok(t2Rows.every(r => r.turnNo === 1))
})

test('TOOL_CALL / TOOL_RESULT 记录工具信息', () => {
  ctx.emit('agent/input', { threadId: 't1', turnNo: 1, input: 'hello' })
  ctx.emit('agent/tool-call', {
    threadId: 't1',
    turnNo: 1,
    node: 'model',
    toolCalls: [{ id: 'c1', name: 'getWeather', args: { city: 'hz' } }]
  })
  ctx.emit('agent/tool-result', {
    threadId: 't1',
    turnNo: 1,
    node: 'tools',
    toolCallId: 'c1',
    text: 'sunny'
  })

  const rows = getRows()
  assert.equal(rows.length, 3)
  assert.equal(rows[1]?.hookType, 'TOOL_CALL')
  assert.equal(rows[1]?.turnNo, 1)
  assert.equal(rows[1]?.toolCalls?.includes('getWeather'), true)
  assert.equal(rows[1]?.content, null)
  assert.equal(rows[2]?.hookType, 'TOOL_RESULT')
  assert.equal(rows[2]?.turnNo, 1)
  assert.equal(rows[2]?.toolCallId, 'c1')
  assert.equal(rows[2]?.toolsResult, 'sunny')
  assert.equal(rows[2]?.content, null)
})

test('TurnsService.nextTurnNo 基于现有记录递增（无记录从 1 开始）', () => {
  ctx.emit('agent/input', { threadId: 't1', turnNo: 1, input: 'hello' })
  assert.equal(ctx.turns.nextTurnNo('t1'), 2)
  assert.equal(ctx.turns.nextTurnNo('t2'), 1)
})

test('ERROR / TIMEOUT 也落库（带 turnNo）', () => {
  ctx.emit('agent/input', { threadId: 't1', turnNo: 1, input: 'hello' })
  ctx.emit('agent/error', { threadId: 't1', turnNo: 1, error: 'boom' })
  ctx.emit('agent/timeout', { threadId: 't1', turnNo: 2 })

  const rows = ctx.database.db.select().from(agentTurns).orderBy(asc(agentTurns.id)).all()
  assert.equal(rows.length, 3)
  assert.equal(rows[1]?.hookType, 'ERROR')
  assert.equal(rows[1]?.content, 'boom')
  assert.equal(rows[1]?.turnNo, 1)
  assert.equal(rows[2]?.hookType, 'TIMEOUT')
  assert.equal(rows[2]?.turnNo, 2)
})

test('重复 INPUT（同 thread 同 turn_no）被唯一索引拒绝，不崩溃不重复落库', () => {
  ctx.emit('agent/input', { threadId: 't1', turnNo: 1, input: 'first' })
  // 第二个入口并发开轮算出同 turnNo：INPUT 插入冲突 → 捕获告警，仅保留第一条
  ctx.emit('agent/input', { threadId: 't1', turnNo: 1, input: 'second' })

  const rows = ctx.database.db.select().from(agentTurns).all()
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.content, 'first')
})
