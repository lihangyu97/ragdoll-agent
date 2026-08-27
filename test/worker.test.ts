process.env.DB_PATH = ':memory:'

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { Service } from 'cordis'
import DatabaseService from '../src/services/data/database/DatabaseService'
import ThreadsService from '../src/services/data/threads/ThreadsService'
import TracesService, {
  TRACE_STATUS,
  type TraceStatus
} from '../src/services/data/traces/TracesService'
import { agentTraces } from '../src/services/data/database/schema'
import { eq, sql } from 'drizzle-orm'
import WorkerService from '../src/services/worker/WorkerService'
import CapabilityService from '../src/services/agent/capability/CapabilityService'
import type { OutboundReply } from '../src/services/channel/types'

/** mock agent：记录调用（含 agentId），可配置 identify 结果 / 失败 / 挂起等待放行 */
class MockAgentService extends Service {
  static calls: { input: string; threadId: string; agentId: string }[] = []
  static identifyResult: string | null = null
  static identifyCalls = 0
  static failNext = false
  static gate: Promise<void> | null = null

  constructor(ctx: Context) {
    super(ctx, 'agent')
  }

  async run(input: string, threadId: string, agentId = 'default'): Promise<string | null> {
    if (MockAgentService.failNext) {
      MockAgentService.failNext = false
      throw new Error('mock agent fail')
    }
    if (MockAgentService.gate) await MockAgentService.gate
    MockAgentService.calls.push({ input, threadId, agentId })
    this.ctx.emit('agent/input', { threadId, turnNo: 1, input })
    this.ctx.emit('agent/result', { threadId, turnNo: 1, node: 'mock-node', text: 'mock reply' })
    return 'mock reply'
  }

  async identify(_input: string): Promise<string | null> {
    MockAgentService.identifyCalls++
    return MockAgentService.identifyResult
  }
}

/** mock channel：记录出站回复调用（worker 完成路径经 ctx.channel.send 路由） */
class MockChannelService extends Service {
  static sends: OutboundReply[] = []

  constructor(ctx: Context) {
    super(ctx, 'channel')
  }

  async send(reply: OutboundReply) {
    MockChannelService.sends.push(reply)
    return true
  }
}

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: ':memory:' })
ctx.plugin(ThreadsService)
ctx.plugin(TracesService)
await ctx.plugin(CapabilityService)
ctx.plugin(MockAgentService)
ctx.plugin(MockChannelService)
await ctx.plugin(WorkerService)

beforeEach(() => {
  MockAgentService.calls = []
  MockAgentService.identifyResult = null
  MockAgentService.identifyCalls = 0
  MockAgentService.failNext = false
  MockAgentService.gate = null
  MockChannelService.sends = []
  ctx.database.exec('DELETE FROM agent_traces')
  ctx.database.exec('DELETE FROM agent_threads')
  ctx.worker.stop()
})

async function waitUntil(fn: () => boolean, timeoutMs = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function seedTrace(threadId: string, text: string): number {
  ctx.threads.ensureThread(threadId, 'p2p', 'chat-1', null)
  return ctx.traces.insertTrace(threadId, 'm-1', 'chat-1', text, 'lark')
}

test('worker 消费 pending trace → done，且广播 trace/status', async () => {
  const traceId = seedTrace('t1', 'hello')

  const statuses: TraceStatus[] = []
  ctx.on('trace/status', ({ status }) => statuses.push(status))

  ctx.worker.start()
  await waitUntil(() => {
    const row = ctx.database.db
      .select({ status: agentTraces.status })
      .from(agentTraces)
      .where(eq(agentTraces.id, traceId))
      .get()
    return row?.status === TRACE_STATUS.DONE
  })

  assert.equal(MockAgentService.calls.length, 1)
  assert.equal(MockAgentService.calls[0]?.input, 'hello')
  assert.equal(MockAgentService.calls[0]?.threadId, 't1')
  assert.deepEqual(statuses, [TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE])
  // 完成路径经 channel 路由出站回复（worker 不感知具体渠道）
  assert.deepEqual(MockChannelService.sends, [
    { channel: 'lark', messageId: 'm-1', text: 'mock reply' }
  ])
})

test('worker run 失败 → trace failed，且广播 trace/status', async () => {
  MockAgentService.failNext = true
  const traceId = seedTrace('t1', 'hello')

  const statuses: TraceStatus[] = []
  ctx.on('trace/status', ({ status }) => statuses.push(status))

  ctx.worker.start()
  await waitUntil(() => {
    const row = ctx.database.db
      .select({ status: agentTraces.status })
      .from(agentTraces)
      .where(eq(agentTraces.id, traceId))
      .get()
    return row?.status === TRACE_STATUS.FAILED
  })

  assert.deepEqual(statuses, [TRACE_STATUS.PROCESSING, TRACE_STATUS.FAILED])
  // 失败也经 channel 路由出站回复错误信息
  assert.equal(MockChannelService.sends.length, 1)
  assert.equal(MockChannelService.sends[0]?.messageId, 'm-1')
  assert.ok(MockChannelService.sends[0]!.text.startsWith('Agent 处理失败：mock agent fail'))
})

test('队列空时不消费（无 pending 记录，start/stop 正常）', async () => {
  ctx.worker.start()
  await new Promise(resolve => setTimeout(resolve, 50))
  ctx.worker.stop()
  assert.equal(MockAgentService.calls.length, 0)
})

test('防重入：上一轮未完成时再次 start 不重复消费', async t => {
  // 测试结束前停掉 interval，否则挂起的 timer 让 node --test 永不退出
  t.after(() => ctx.worker.stop())

  let release: () => void = () => {}
  MockAgentService.gate = new Promise<void>(resolve => {
    release = resolve
  })
  const traceId = seedTrace('t1', 'hello')

  ctx.worker.start()
  // 旧 poll 已抢锁（processing 状态）并挂在 gate 上
  await waitUntil(() => {
    const row = ctx.database.db
      .select({ status: agentTraces.status })
      .from(agentTraces)
      .where(eq(agentTraces.id, traceId))
      .get()
    return row?.status === TRACE_STATUS.PROCESSING
  })

  ctx.worker.stop()
  ctx.worker.start() // 新 poll 被 processing 标志挡住，不重复消费

  release() // 放行旧 run
  await waitUntil(() => {
    const row = ctx.database.db
      .select({ status: agentTraces.status })
      .from(agentTraces)
      .where(eq(agentTraces.id, traceId))
      .get()
    return row?.status === TRACE_STATUS.DONE
  })

  assert.equal(MockAgentService.calls.length, 1)
})

test('启动恢复：进程崩溃遗留的超时 processing trace 被重置并重新消费', async t => {
  // 测试结束前停掉 interval，否则挂起的 timer 让 node --test 永不退出
  t.after(() => ctx.worker.stop())

  const traceId = seedTrace('t1', 'hello')
  // 模拟崩溃残留：processing 状态 + updated_at 已是 20 分钟前（超过 STALE_PROCESSING_MINUTES）
  ctx.traces.updateTraceStatus(traceId, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
  ctx.database.db
    .update(agentTraces)
    .set({ updatedAt: sql`datetime('now', 'localtime', '-20 minutes')` })
    .where(eq(agentTraces.id, traceId))
    .run()

  ctx.worker.start() // 启动时恢复 → 重新领取消费
  await waitUntil(() => {
    const row = ctx.database.db
      .select({ status: agentTraces.status })
      .from(agentTraces)
      .where(eq(agentTraces.id, traceId))
      .get()
    return row?.status === TRACE_STATUS.DONE
  })

  assert.equal(MockAgentService.calls.length, 1)
  assert.deepEqual(MockChannelService.sends, [
    { channel: 'lark', messageId: 'm-1', text: 'mock reply' }
  ])
})

test('启动恢复：新鲜的 processing（其他实例正在跑）不被误伤', async t => {
  // 测试结束前停掉 interval，否则挂起的 timer 让 node --test 永不退出
  t.after(() => ctx.worker.stop())

  const traceId = seedTrace('t1', 'hello')
  ctx.traces.updateTraceStatus(traceId, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING) // 新鲜 processing

  ctx.worker.start()
  await new Promise(resolve => setTimeout(resolve, 100)) // 给 poll 一轮时间

  assert.equal(MockAgentService.calls.length, 0) // 未被恢复、未被消费
  const row = ctx.database.db
    .select({ status: agentTraces.status })
    .from(agentTraces)
    .where(eq(agentTraces.id, traceId))
    .get()
  assert.equal(row?.status, TRACE_STATUS.PROCESSING) // 仍是 processing
})

test('未绑定 thread：识别 null → 绑定 default 后运行', async t => {
  t.after(() => ctx.worker.stop())
  const traceId = seedTrace('t1', 'hello')

  ctx.worker.start()
  await waitUntil(() => {
    const row = ctx.database.db
      .select({ status: agentTraces.status })
      .from(agentTraces)
      .where(eq(agentTraces.id, traceId))
      .get()
    return row?.status === TRACE_STATUS.DONE
  })

  assert.equal(MockAgentService.calls.length, 1)
  assert.equal(MockAgentService.calls[0]?.agentId, 'default')
  assert.equal(ctx.threads.getAgentId('t1'), 'default') // 已标记
})

test('已绑定 thread：直接用绑定 agent，不再识别', async t => {
  t.after(() => ctx.worker.stop())
  ctx.threads.ensureThread('t2', 'p2p', 'chat-1', null)
  ctx.threads.setAgentId('t2', 'kb-bot')
  const traceId = ctx.traces.insertTrace('t2', 'm-1', 'chat-1', 'hi', 'lark')
  MockAgentService.identifyResult = 'kb-bot'

  ctx.worker.start()
  await waitUntil(() => {
    const row = ctx.database.db
      .select({ status: agentTraces.status })
      .from(agentTraces)
      .where(eq(agentTraces.id, traceId))
      .get()
    return row?.status === TRACE_STATUS.DONE
  })

  assert.equal(MockAgentService.calls[0]?.agentId, 'kb-bot')
  assert.equal(MockAgentService.identifyCalls, 0) // 走绑定，不走 LLM 识别
})

test('规则事件命中：agent/resolve 返回 id → 绑定并运行，不走识别', async t => {
  t.after(() => ctx.worker.stop())
  ctx.capability.registerDefinition({ id: 'kb-bot', basePrompt: 'You are kb assistant.' })
  const off = ctx.on('agent/resolve', () => 'kb-bot')
  t.after(() => off()) // 共享 ctx，用完即注销，避免污染后续用例
  const traceId = seedTrace('t1', '查知识库')

  ctx.worker.start()
  await waitUntil(() => {
    const row = ctx.database.db
      .select({ status: agentTraces.status })
      .from(agentTraces)
      .where(eq(agentTraces.id, traceId))
      .get()
    return row?.status === TRACE_STATUS.DONE
  })

  assert.equal(MockAgentService.calls[0]?.agentId, 'kb-bot')
  assert.equal(ctx.threads.getAgentId('t1'), 'kb-bot')
  assert.equal(MockAgentService.identifyCalls, 0)
})

test('识别返回存在的 agent → 绑定并运行', async t => {
  t.after(() => ctx.worker.stop())
  ctx.capability.registerDefinition({ id: 'kb-bot', basePrompt: 'You are kb assistant.' })
  MockAgentService.identifyResult = 'kb-bot'
  const traceId = seedTrace('t1', '帮我查知识库')

  ctx.worker.start()
  await waitUntil(() => {
    const row = ctx.database.db
      .select({ status: agentTraces.status })
      .from(agentTraces)
      .where(eq(agentTraces.id, traceId))
      .get()
    return row?.status === TRACE_STATUS.DONE
  })

  assert.equal(MockAgentService.calls[0]?.agentId, 'kb-bot')
  assert.equal(ctx.threads.getAgentId('t1'), 'kb-bot')
})

test('识别返回不存在的 agent → 降级 default', async t => {
  t.after(() => ctx.worker.stop())
  MockAgentService.identifyResult = 'ghost' // 未注册的 definition
  const traceId = seedTrace('t1', 'hi')

  ctx.worker.start()
  await waitUntil(() => {
    const row = ctx.database.db
      .select({ status: agentTraces.status })
      .from(agentTraces)
      .where(eq(agentTraces.id, traceId))
      .get()
    return row?.status === TRACE_STATUS.DONE
  })

  assert.equal(MockAgentService.calls[0]?.agentId, 'default')
  assert.equal(ctx.threads.getAgentId('t1'), 'default')
})
