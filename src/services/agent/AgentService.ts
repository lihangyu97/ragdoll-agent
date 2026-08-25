import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import 'dotenv/config'
import { Service, type Context } from 'cordis'
import { ChatOpenAI } from '@langchain/openai'
import { createAgent } from 'langchain'
import { AIMessage, ToolMessage } from '@langchain/core/messages'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { modelConfig } from '@/config/agent'
import { DB_PATH } from '@/config/sqlite'
import type { ClientTool } from '@langchain/core/tools'
import { stringify } from '@/logger'
import { threadContext } from '@/logger/context'

/** agent 单次执行的整体超时（毫秒）：覆盖多轮 LLM + 工具循环，超时通过 signal abort */
const AGENT_RUN_TIMEOUT_MS = 5 * 60_000

export default class AgentService extends Service {
  private readonly model: ChatOpenAI
  private readonly checkpointer: SqliteSaver
  private agent: ReturnType<typeof createAgent> | undefined
  private tools: ClientTool[] = []
  private systemPrompt: string = ''

  constructor(ctx: Context) {
    super(ctx, 'agent')

    if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_BASE_URL) {
      throw new Error('缺少 LLM 配置：请在 .env 设置 OPENAI_API_KEY / OPENAI_BASE_URL')
    }

    this.model = new ChatOpenAI(modelConfig)
    this.checkpointer = this.initCheckpointer()
  }

  initCheckpointer() {
    mkdirSync(dirname(DB_PATH), { recursive: true })

    const checkpointer = SqliteSaver.fromConnString(DB_PATH)
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
