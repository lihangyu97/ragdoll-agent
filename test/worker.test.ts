process.env.DB_PATH = ':memory:'

import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { Service } from 'cordis'
import { AIMessage } from '@langchain/core/messages'
import DatabaseService from '../src/services/data/database/DatabaseService'
import ThreadsService from '../src/services/data/threads/ThreadsService'
import TracesService, {
  TRACE_STATUS,
  type TraceStatus
} from '../src/services/data/traces/TracesService'
import { agentTraces } from '../src/services/data/database/schema'
import { eq } from 'drizzle-orm'
import WorkerService from '../src/services/worker/WorkerService'

/** mock agent：记录调用，正常时 emit agent/* 事件，可配置失败 / 可配置挂起等待放行 */
class MockAgentService extends Service {
  static calls: { input: string; threadId: string }[] = []
  static failNext = false
  static gate: Promise<void> | null = null

  constructor(ctx: Context) {
    super(ctx, 'agent')
  }

  async run(input: string, threadId: string) {
    if (MockAgentService.failNext) {
      MockAgentService.failNext = false
      throw new Error('mock agent fail')
    }
    if (MockAgentService.gate) await MockAgentService.gate
    MockAgentService.calls.push({ input, threadId })
    this.ctx.emit('agent/input', threadId, input)
    this.ctx.emit('agent/result', threadId, 'mock-node', new AIMessage('mock reply'))
  }
}

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: ':memory:' })
ctx.plugin(ThreadsService)
ctx.plugin(TracesService)
ctx.plugin(MockAgentService)
await ctx.plugin(WorkerService)

beforeEach(() => {
  MockAgentService.calls = []
  MockAgentService.failNext = false
  MockAgentService.gate = null
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
  return ctx.traces.insertTrace(threadId, 'm-1', 'chat-1', text)
}

test('worker 消费 pending trace → done，且广播 trace/status', async () => {
  const traceId = seedTrace('t1', 'hello')

  const statuses: TraceStatus[] = []
  ctx.on('trace/status', (_threadId, status) => statuses.push(status))

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
})

test('worker run 失败 → trace failed，且广播 trace/status', async () => {
  MockAgentService.failNext = true
  const traceId = seedTrace('t1', 'hello')

  const statuses: TraceStatus[] = []
  ctx.on('trace/status', (_threadId, status) => statuses.push(status))

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
