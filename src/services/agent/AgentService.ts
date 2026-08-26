import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Service, type Context } from 'cordis'
import { z } from 'zod'
import { ChatOpenAI } from '@langchain/openai'
import { createAgent } from 'langchain'
import {
  AIMessage,
  ToolMessage,
  BaseMessage,
  SystemMessage,
  HumanMessage
} from '@langchain/core/messages'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { stringify } from '@/utils'
import { threadContext } from '@/utils/context'
import logger from '@/utils/logger'
import type { AgentResultEvent, AgentToolCallEvent, AgentToolResultEvent } from './steps'

declare module 'cordis' {
  interface Context {
    agent: AgentService
  }
  interface Events {
    'agent/input': (threadId: string, input: string) => void
    // 事件载荷为框架无关结构（steps.ts）；langchain 消息在 run 内部转换后再发出
    'agent/tool-call': (threadId: string, node: string, step: AgentToolCallEvent) => void
    'agent/tool-result': (threadId: string, node: string, step: AgentToolResultEvent) => void
    'agent/result': (threadId: string, node: string, step: AgentResultEvent) => void
    'agent/error': (threadId: string, error: string) => void
    'agent/timeout': (threadId: string) => void
  }
}

/** agent 单次执行的整体超时（毫秒）：覆盖多轮 LLM + 工具循环，超时通过 signal abort */
const AGENT_RUN_TIMEOUT_MS = 5 * 60_000

/** 路由识别（identify）的结构化输出 */
const IDENTIFY_SCHEMA = z.object({
  agentId: z.string().nullable().describe('选中的 agent definition id；无法确定时返回 null')
})

export default class AgentService extends Service {
  static inject = ['capability']

  static Config = z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().min(1),
    model: z.string().default('deepseek-v4-flash'),
    dbPath: z.string().default('data/agent.db')
  })

  private readonly model: ChatOpenAI
  private readonly checkpointer: SqliteSaver
  /** 按 agentId 的运行时缓存：capability 注册表 version 变更即全部失效，下次 run 重建 */
  private runtimes = new Map<string, { version: number; agent: ReturnType<typeof createAgent> }>()

  constructor(ctx: Context, config: z.infer<typeof AgentService.Config>) {
    super(ctx, 'agent')

    this.model = new ChatOpenAI({
      model: config.model,
      apiKey: config.apiKey,
      streaming: true,
      timeout: 60_000,
      maxRetries: 2,
      configuration: { baseURL: config.baseUrl }
    })
    this.checkpointer = this.initCheckpointer(config.dbPath)
  }

  initCheckpointer(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })

    const checkpointer = SqliteSaver.fromConnString(dbPath)
    checkpointer.db.pragma('busy_timeout = 5000')

    return checkpointer
  }

  // 能力注入走 capability 注册表：注册变更 → version 递增 → 下次 run 重建 agent
  async run(input: string, threadId: string, agentId = 'default'): Promise<string | null> {
    let answer: string | null = null

    await threadContext.run(threadId, async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
        this.ctx.emit('agent/timeout', threadId)
      }, AGENT_RUN_TIMEOUT_MS)

      try {
        const agent = await this.ensureAgent(agentId)
        this.ctx.emit('agent/input', threadId, input)

        const stream = await agent.stream(
          { messages: [new HumanMessage(input)] },
          {
            streamMode: 'updates',
            signal: controller.signal,
            configurable: { thread_id: threadId }
          }
        )

        for await (const step of stream) {
          for (const [node, update] of Object.entries(step)) {
            for (const msg of update.messages ?? []) {
              if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
                this.ctx.emit('agent/tool-call', threadId, node, {
                  toolCalls: msg.tool_calls.map(call => ({
                    id: call.id ?? '',
                    name: call.name,
                    args: call.args
                  }))
                })
              } else if (ToolMessage.isInstance(msg)) {
                this.ctx.emit('agent/tool-result', threadId, node, {
                  toolCallId: msg.tool_call_id,
                  text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                })
              } else {
                const text = typeof msg.content === 'string' ? msg.content : ''
                this.ctx.emit('agent/result', threadId, node, { text })
                if (text) {
                  answer = text // 最后一次非工具消息即最终答案
                }
              }
            }
          }
        }
      } catch (err) {
        this.ctx.emit('agent/error', threadId, stringify(err))
        throw err
      } finally {
        clearTimeout(timer)
      }
    })
    return answer
  }

  /**
   * 路由识别（agentClient）：判断一条未绑定 thread 的消息该交给哪个 agent。
   * 轻量无状态 router：无 checkpointer、无系统工具，withStructuredOutput 强制 {agentId | null}。
   * 识别失败/超时 → null（调用方降级 default）；agentId 合法性由调用方用 capability.hasDefinition 校验。
   */
  async identify(input: string, chatType = ''): Promise<string | null> {
    const definitions = this.ctx.capability.listDefinitions()
    const catalog = definitions
      .map(d => `- ${d.id}：${d.basePrompt.split('\n')[0]?.slice(0, 80) ?? ''}`)
      .join('\n')

    const system = new SystemMessage(
      `你是 agent 路由器，只输出 JSON。根据用户消息判断该交给哪个助手处理。\n可用助手：\n${catalog}\n` +
        '规则：\n1. 根据用户意图选择最合适的助手 id；\n' +
        '2. 无法确定、或不需要任何助手时返回 null。\n' +
        '输出格式：{"agentId": "助手 id 或 null"}，不要解释。'
    )
    const human = new HumanMessage(
      chatType ? `会话类型：${chatType}\n用户消息：${input}` : `用户消息：${input}`
    )

    try {
      // jsonMode：中转站对 functionCalling 的 tool_choice 支持不稳（thinking 模式报 400），
      // json_object 要求 prompt 里出现 "json" 字样（上面已包含）
      const classifier = this.model.withStructuredOutput(IDENTIFY_SCHEMA, { method: 'jsonMode' })
      const result = await classifier.invoke([system, human])
      return result.agentId
    } catch (err) {
      logger.warn('[agent] 路由识别失败，降级 null: ', stringify(err))
      return null
    }
  }

  private async ensureAgent(agentId: string): Promise<ReturnType<typeof createAgent>> {
    const version = this.ctx.capability.version
    const entry = this.runtimes.get(agentId)
    if (!entry || entry.version !== version) {
      const spec = await this.ctx.capability.assemble(agentId)
      this.runtimes.set(agentId, {
        version,
        agent: createAgent({
          model: this.model,
          tools: spec.tools,
          systemPrompt: spec.systemPrompt,
          checkpointer: this.checkpointer
        })
      })
    }
    return this.runtimes.get(agentId)!.agent
  }
}
