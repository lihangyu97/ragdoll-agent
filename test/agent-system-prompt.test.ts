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
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import DatabaseService from '../src/services/data/database/DatabaseService'
import TurnsService from '../src/services/data/turns/TurnsService'
import CapabilityService from '../src/services/agent/capability/CapabilityService'
import AgentService from '../src/services/agent/AgentService'

/** 记录每次调用收到的 messages 的假模型（不触网）。
 *  responses 按调用顺序轮询返回（为空时固定返回 'ok'）。 */
class RecordingChatModel extends BaseChatModel {
  static received: BaseMessage[][] = []
  static responses: BaseMessage[] = []
  static callIndex = 0

  override _llmType(): string {
    return 'recording'
  }

  override bindTools(_tools: BindToolsInput[]): Runnable {
    return this as unknown as Runnable
  }

  private nextResponse(): AIMessage {
    const msg = RecordingChatModel.responses.length
      ? RecordingChatModel.responses[
          RecordingChatModel.callIndex % RecordingChatModel.responses.length
        ]!
      : new AIMessage('ok')
    RecordingChatModel.callIndex++
    return msg instanceof AIMessage ? msg : new AIMessage(msg.content as string)
  }

  override async _generate(
    messages: BaseMessage[],
    _options?: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    RecordingChatModel.received.push(messages)
    const message = this.nextResponse()
    return {
      generations: [{ message, text: typeof message.content === 'string' ? message.content : '' }]
    }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    _options?: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    // AgentNode 走 invoke（_generate），此方法不会被调用，仅保留实现
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
  RecordingChatModel.responses = []
  RecordingChatModel.callIndex = 0
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

test('带 tool_calls 的消息里的过程话也广播 agent/result，但不作为最终答案', async () => {
  const ctx = await setup()
  // default 是 chatOnly 零工具，注册一个带工具的 demo definition
  ctx.capability.registerTool(
    tool(async () => 'tool result', {
      name: 'demoTool',
      description: 'demo tool',
      schema: z.object({})
    })
  )
  ctx.capability.registerDefinition({
    id: 'demo',
    basePrompt: 'demo prompt',
    tools: ['demoTool']
  })
  // 第 1 次调用：边说边做（content 文本 + tool_calls）；第 2 次调用：最终答案
  RecordingChatModel.responses = [
    new AIMessage({
      content: '好的，先看看文件',
      tool_calls: [{ name: 'demoTool', args: {}, id: 'call-1' }]
    }),
    new AIMessage('完成')
  ]

  const results: string[] = []
  ctx.on('agent/result', ({ text }) => results.push(text))

  const answer = await ctx.agent.run('hi', 't4', 'demo')

  assert.equal(answer, '完成')
  assert.ok(results.includes('好的，先看看文件'), '过程话应广播 agent/result')
  assert.ok(results.includes('完成'), '最终答案应广播 agent/result')
})
