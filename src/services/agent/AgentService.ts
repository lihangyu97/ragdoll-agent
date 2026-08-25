import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Service, type Context } from 'cordis'
import { z } from 'zod'
import { ChatOpenAI } from '@langchain/openai'
import { createAgent } from 'langchain'
import { AIMessage, ToolMessage, BaseMessage } from '@langchain/core/messages'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import type { ClientTool } from '@langchain/core/tools'
import { stringify } from '@/utils'
import { threadContext } from '@/utils/context'

declare module 'cordis' {
  interface Context {
    agent: AgentService
  }
  interface Events {
    'agent/input': (threadId: string, input: string) => void
    'agent/tool-call': (threadId: string, node: string, msg: AIMessage) => void
    'agent/tool-result': (threadId: string, node: string, msg: ToolMessage) => void
    'agent/result': (threadId: string, node: string, msg: BaseMessage) => void
    'agent/error': (threadId: string, error: string) => void
    'agent/timeout': (threadId: string) => void
  }
}

/** agent 单次执行的整体超时（毫秒）：覆盖多轮 LLM + 工具循环，超时通过 signal abort */
const AGENT_RUN_TIMEOUT_MS = 5 * 60_000

export default class AgentService extends Service {
  static Config = z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().min(1),
    model: z.string().default('deepseek-v4-flash'),
    dbPath: z.string().default('data/agent.db')
  })

  private readonly model: ChatOpenAI
  private readonly checkpointer: SqliteSaver
  private agent: ReturnType<typeof createAgent> | undefined
  private tools: ClientTool[] = []
  private systemPrompt: string = ''

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

  // 下次 run 时重建 agent
  registerTools(tools: ClientTool[]) {
    this.tools.push(...tools)
    this.agent = undefined
  }

  // 下次 run 时重建 agent
  setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt
    this.agent = undefined
  }

  async run(input: string, threadId: string): Promise<void> {
    // logger 自动关联 threadId（agent 层自管上下文；worker 外层包裹与之嵌套，值相同无害）
    await threadContext.run(threadId, async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
        this.ctx.emit('agent/timeout', threadId)
      }, AGENT_RUN_TIMEOUT_MS)

      try {
        const agent = this.ensureAgent()
        this.ctx.emit('agent/input', threadId, input)

        const stream = await agent.stream(
          { messages: [{ role: 'user', content: input }] },
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
                this.ctx.emit('agent/tool-call', threadId, node, msg)
              } else if (ToolMessage.isInstance(msg)) {
                this.ctx.emit('agent/tool-result', threadId, node, msg)
              } else {
                this.ctx.emit('agent/result', threadId, node, msg)
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
  }

  private ensureAgent(): ReturnType<typeof createAgent> {
    if (!this.agent) {
      this.agent = createAgent({
        model: this.model,
        tools: this.tools,
        systemPrompt: this.systemPrompt,
        checkpointer: this.checkpointer
      })
    }
    return this.agent
  }
}
