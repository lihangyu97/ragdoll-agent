import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AIMessage, ToolMessage } from '@langchain/core/messages'
import { createHookBus, Hooks } from '../src/agent/hooks'

test('INPUT / AGENT_ERROR：字符串 payload 分发', () => {
  const bus = createHookBus()
  const seen: string[] = []
  bus.track(Hooks.INPUT, (threadId, input) => seen.push(`input:${threadId}:${input}`))
  bus.track(Hooks.AGENT_ERROR, (threadId, error) => seen.push(`error:${threadId}:${error}`))

  bus.trigger(Hooks.INPUT, 't1', '你好')
  bus.trigger(Hooks.AGENT_ERROR, 't1', 'boom')

  assert.deepEqual(seen, ['input:t1:你好', 'error:t1:boom'])
})

test('TOOL_CALL / TOOL_RESULT / AGENT_RESULT：按消息类型分发', () => {
  const bus = createHookBus()
  const seen: string[] = []
  bus.track(Hooks.TOOL_CALL, (threadId, msg, node) =>
    seen.push(`toolCall:${node}:${msg.tool_calls?.[0]?.name}`)
  )
  bus.track(Hooks.TOOL_RESULT, (threadId, msg, node) =>
    seen.push(`toolResult:${node}:${msg.tool_call_id}`)
  )
  bus.track(Hooks.AGENT_RESULT, (threadId, msg, node) => seen.push(`result:${node}:${msg.text}`))

  const toolCallMsg = new AIMessage({
    content: '',
    tool_calls: [{ name: 'getWeather', args: { city: 'hz' }, id: 'call-1' }]
  })
  const toolResultMsg = new ToolMessage({ content: 'sunny', tool_call_id: 'call-1' })
  const finalMsg = new AIMessage({ content: '天气晴朗' })

  bus.trigger('tools', 't1', toolCallMsg)
  bus.trigger('tools', 't1', toolResultMsg)
  bus.trigger('model', 't1', finalMsg)

  assert.deepEqual(seen, [
    'toolCall:tools:getWeather',
    'toolResult:tools:call-1',
    'result:model:天气晴朗'
  ])
})

test('同一类型多个 handler 按注册顺序执行', () => {
  const bus = createHookBus()
  const order: number[] = []
  bus.track(Hooks.INPUT, () => order.push(1))
  bus.track(Hooks.INPUT, () => order.push(2))
  bus.track(Hooks.INPUT, () => order.push(3))
  bus.trigger(Hooks.INPUT, 't1', 'x')
  assert.deepEqual(order, [1, 2, 3])
})

test('独立实例互不污染', () => {
  const a = createHookBus()
  const b = createHookBus()
  let hit = 0
  a.track(Hooks.INPUT, () => hit++)
  b.trigger(Hooks.INPUT, 't1', 'x') // b 上没有注册，不应触发 a 的 handler
  assert.equal(hit, 0)
  a.trigger(Hooks.INPUT, 't1', 'x')
  assert.equal(hit, 1)
})
