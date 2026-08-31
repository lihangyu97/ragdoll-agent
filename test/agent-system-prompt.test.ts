process.env.RAGDOLL_DB_PATH = ':memory:'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from 'cordis'
import {
  AIMessage,
  AIMessageChunk,
  SystemMessage,
  type BaseMessage
} from '@langchain/core/messages'
import { BaseChatModel, type BindToolsInput } from '@langchain/core/language_models/chat_models'
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs'
import type { Runnable } from '@langchain/core/runnables'
import DatabaseService from '../src/services/data/database/DatabaseService'
import TurnsService from '../src/services/data/turns/TurnsService'
import CapabilityService from '../src/services/agent/capability/CapabilityService'
import AgentService from '../src/services/agent/AgentService'

/** 记录每次调用收到的 messages 的假模型，固定返回 'ok'（不触网） */
class RecordingChatModel extends BaseChatModel {
  static received: BaseMessage[][] = []

  override _llmType(): string {
    return 'recording'
  }

  override bindTools(_tools: BindToolsInput[]): Runnable {
    return this as unknown as Runnable
  }

  override async _generate(
    messages: BaseMessage[],
    _options?: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    RecordingChatModel.received.push(messages)
    return { generations: [{ message: new AIMessage('ok'), text: 'ok' }] }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    _options?: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    RecordingChatModel.received.push(messages)
    yield new ChatGenerationChunk({ message: new AIMessageChunk('ok'), text: 'ok' })
  }
}

/** mock provider：getModel 返回可记录 messages 的假模型 */
class MockProviderService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'provider')
  }

  getModel(): RecordingChatModel {
    return new RecordingChatModel({})
  }
}

async function setup() {
  RecordingChatModel.received = []
  const ctx = new Context()
  await ctx.plugin(DatabaseService, { dbPath: ':memory:' })
  await ctx.plugin(TurnsService)
  await ctx.plugin(CapabilityService)
  await ctx.plugin(MockProviderService)
  await ctx.plugin(AgentService, { dbPath: ':memory:' })
  return ctx
}

function systemMessage(): string {
  const msg = RecordingChatModel.received[0]!.find(m => m instanceof SystemMessage)
  assert.ok(msg, '模型应收到 SystemMessage')
  // langchain 规范化后 content 可能是文本块数组（message structure v2）
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter(b => b.type === 'text')
    .map(b => b.text as string)
    .join('\n')
}

test('无钩子：基础 systemPrompt 原样传给模型', async () => {
  const ctx = await setup()

  const answer = await ctx.agent.run('你好', 't1', 'default')

  assert.equal(answer, 'ok')
  assert.ok(systemMessage().includes('You are a helpful assistant'))
})

test('agent/system-prompt 钩子改写：next() 拿下游结果后追加，事件上下文正确', async () => {
  const ctx = await setup()
  const seen: Array<Record<string, unknown>> = []
  ctx.on('agent/system-prompt', (prompt, info, next) => {
    seen.push({ prompt, ...info })
    const base = next() as string
    return `${base}\n\n[测试后缀]`
  })

  const answer = await ctx.agent.run('hello', 't2', 'default')

  assert.equal(answer, 'ok')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.threadId, 't2')
  assert.equal(seen[0]!.turnNo, 1)
  assert.equal(seen[0]!.agentId, 'default')
  assert.equal(seen[0]!.input, 'hello')
  assert.ok((seen[0]!.prompt as string).includes('You are a helpful assistant'))
  // 改写后的 prompt 生效：模型收到的 SystemMessage 带后缀
  assert.ok(systemMessage().endsWith('[测试后缀]'))
})

test('钩子不修改：直接返回 next() 结果，prompt 保持不变', async () => {
  const ctx = await setup()
  ctx.on('agent/system-prompt', (_prompt, _info, next) => next())

  await ctx.agent.run('hello', 't3', 'default')

  assert.ok(!systemMessage().includes('[测试后缀]'))
  assert.ok(systemMessage().includes('You are a helpful assistant'))
})
