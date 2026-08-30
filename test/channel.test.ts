process.env.RAGDOLL_DB_PATH = ':memory:'

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import DatabaseService from '../src/services/data/database/DatabaseService'
import ThreadsService from '../src/services/data/threads/ThreadsService'
import TracesService, { TRACE_STATUS } from '../src/services/data/traces/TracesService'
import ChannelStoreService from '../src/services/data/channels/ChannelStoreService'
import ChannelService from '../src/services/channel/ChannelService'
import { agentTraces, channelMessages } from '../src/services/data/database/schema'
import type { ChannelAdapter, OutboundReply } from '../src/services/channel/types'

/** mock adapter：实现 ChannelAdapter（id='test'），记录出站 send 调用 */
class MockAdapter implements ChannelAdapter {
  readonly id = 'test'
  static sends: OutboundReply[] = []

  async start() {}
  async stop() {}
  async send(reply: OutboundReply) {
    MockAdapter.sends.push(reply)
    return true
  }
}

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: ':memory:' })
ctx.plugin(ThreadsService)
ctx.plugin(TracesService)
await ctx.plugin(ChannelStoreService)
await ctx.plugin(ChannelService, { thinkingReply: '🤔 处理中…' })
ctx.channel.register(new MockAdapter())

beforeEach(() => {
  MockAdapter.sends = []
  ctx.database.exec('DELETE FROM agent_traces')
  ctx.database.exec('DELETE FROM agent_threads')
  ctx.database.exec('DELETE FROM channel_messages')
})

test('dispatch：落库 channel_messages + 建 thread + 入队（带 channel）+ 回执 + 广播', async () => {
  const received: string[][] = []
  ctx.on('message/received', ({ channel, threadId, text }) =>
    received.push([channel, threadId, text])
  )

  await ctx.channel.dispatch({
    channel: 'test',
    threadId: 'test:p2p:123',
    chatId: '123',
    chatType: 'p2p',
    messageId: 'm-1',
    senderId: 'u-1',
    senderName: 'Alice',
    text: 'hello'
  })

  // channel_messages 落库
  const msg = ctx.database.db.select().from(channelMessages).get()
  assert.ok(msg)
  assert.equal(msg.channel, 'test')
  assert.equal(msg.messageId, 'm-1')
  assert.equal(msg.senderId, 'u-1')
  assert.equal(msg.senderName, 'Alice')
  assert.equal(msg.text, 'hello')

  // thread 建立
  assert.equal(ctx.threads.getAgentId('test:p2p:123'), null)

  // trace 入队且带 channel（worker 出站路由依据）
  const trace = ctx.database.db.select().from(agentTraces).get()
  assert.equal(trace?.channel, 'test')
  assert.equal(trace?.status, TRACE_STATUS.PENDING)

  // 回执经 send 发给 adapter
  assert.deepEqual(MockAdapter.sends, [{ channel: 'test', messageId: 'm-1', text: '🤔 处理中…' }])

  // message/received 广播
  assert.deepEqual(received, [['test', 'test:p2p:123', 'hello']])
})

test('dispatch：重复 message_id 幂等跳过（不重复落库/入队/回执）', async () => {
  const first = {
    channel: 'test',
    threadId: 'test:p2p:123',
    chatId: '123',
    chatType: 'p2p',
    messageId: 'm-1',
    text: 'hello'
  }
  await ctx.channel.dispatch(first)
  MockAdapter.sends = []
  // at-least-once 重推：同 channel + message_id 的事件整体跳过
  await ctx.channel.dispatch({ ...first, text: 'hello again' })

  const msgs = ctx.database.db.select().from(channelMessages).all()
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0]?.text, 'hello') // 首次内容保留
  assert.equal(ctx.database.db.select().from(agentTraces).all().length, 1) // 不重复入队
  assert.deepEqual(MockAdapter.sends, []) // 不重复回执
})

test('send 路由到对应 adapter；未知 channel 返回 false 不抛错', async () => {
  assert.equal(await ctx.channel.send({ channel: 'test', messageId: 'm-1', text: 'hi' }), true)
  assert.deepEqual(MockAdapter.sends, [{ channel: 'test', messageId: 'm-1', text: 'hi' }])

  assert.equal(await ctx.channel.send({ channel: 'nope', messageId: 'm-1', text: 'hi' }), false)
  assert.equal(MockAdapter.sends.length, 1) // 未知渠道不转发
})

test('register：重复 id 抛错', () => {
  assert.throws(() => ctx.channel.register(new MockAdapter()), /adapter 已注册: test/)
})
