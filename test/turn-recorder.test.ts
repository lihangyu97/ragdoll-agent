process.env.DB_PATH = ':memory:'

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { asc, count, eq, max } from 'drizzle-orm'
import { Context } from 'cordis'
import { AIMessage, ToolMessage } from '@langchain/core/messages'
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
  ctx.emit('agent/input', 't1', 'hello')
  ctx.emit('agent/result', 't1', 'model', new AIMessage('hi'))

  const rows = getRows()
  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.turnNo, 1)
  assert.equal(rows[0]?.hookType, 'INPUT')
  assert.equal(rows[0]?.content, 'hello')
  assert.equal(rows[1]?.hookType, 'AGENT_RESULT')
  assert.equal(rows[1]?.content, 'hi')
})

test('连续两轮 turn_no 递增', () => {
  ctx.emit('agent/input', 't1', 'first')
  ctx.emit('agent/result', 't1', 'model', new AIMessage('r1'))
  ctx.emit('agent/input', 't1', 'second')
  ctx.emit('agent/result', 't1', 'model', new AIMessage('r2'))

  const row = ctx.database.db
    .select({ max: max(agentTurns.turnNo) })
    .from(agentTurns)
    .where(eq(agentTurns.threadId, 't1'))
    .get()
  assert.equal(row?.max, 2)
})

test('非当前 thread 的事件被忽略（worker 串行假设）', () => {
  ctx.emit('agent/input', 't1', 'hello')
  ctx.emit('agent/result', 't2', 'model', new AIMessage('x')) // 不同 thread 忽略

  const { c } = ctx.database.db.select({ c: count() }).from(agentTurns).get() ?? { c: 0 }
  assert.equal(c, 1)
})

test('TOOL_CALL / TOOL_RESULT 记录工具信息', () => {
  ctx.emit('agent/input', 't1', 'hello')
  ctx.emit(
    'agent/tool-call',
    't1',
    'model',
    new AIMessage({
      content: '',
      tool_calls: [{ name: 'getWeather', args: { city: 'hz' }, id: 'c1', type: 'tool_call' }]
    })
  )
  ctx.emit(
    'agent/tool-result',
    't1',
    'tools',
    new ToolMessage({ content: 'sunny', tool_call_id: 'c1' })
  )

  const rows = getRows()
  assert.equal(rows.length, 3)
  assert.equal(rows[1]?.hookType, 'TOOL_CALL')
  assert.equal(rows[1]?.toolCalls?.includes('getWeather'), true)
  assert.equal(rows[1]?.content, null)
  assert.equal(rows[2]?.hookType, 'TOOL_RESULT')
  assert.equal(rows[2]?.toolCallId, 'c1')
  assert.equal(rows[2]?.toolsResult, 'sunny')
  assert.equal(rows[2]?.content, null)
})
