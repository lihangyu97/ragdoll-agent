import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Service, type Context } from 'cordis'
import { z } from 'zod'
import { createAgent } from 'langchain'
import { AIMessage, ToolMessage, SystemMessage, HumanMessage } from '@langchain/core/messages'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { stringify } from '@/utils'
import { threadContext } from '@/utils/context'
import logger from '@/utils/logger'
import type {
  AgentErrorEvent,
  AgentInputEvent,
  AgentResultEvent,
  AgentTimeoutEvent,
  AgentToolCallEvent,
  AgentToolResultEvent
} from './steps'

declare module 'cordis' {
  interface Context {
    agent: AgentService
  }
  interface Events {
    // 所有 agent 事件统一为单个 payload（steps.ts）：事件名即判别符，身份字段在 AgentEventBase
    'agent/input': (payload: AgentInputEvent) => void
    'agent/tool-call': (payload: AgentToolCallEvent) => void
    'agent/tool-result': (payload: AgentToolResultEvent) => void
    'agent/result': (payload: AgentResultEvent) => void
    'agent/error': (payload: AgentErrorEvent) => void
    'agent/timeout': (payload: AgentTimeoutEvent) => void
  }
}

/** agent 单次执行的整体超时（毫秒）：覆盖多轮 LLM + 工具循环，超时通过 signal abort */
const AGENT_RUN_TIMEOUT_MS = 5 * 60_000

/** 路由识别（identify）的结构化输出 */
const IDENTIFY_SCHEMA = z.object({
  agentId: z.string().nullable().describe('选中的 agent definition id；无法确定时返回 null'),
  reason: z.string().describe('一句话说明选择该助手（或无法判断）的原因')
})

export default class AgentService extends Service {
  static inject = ['capability', 'turns', 'provider']

  static Config = z.object({
    dbPath: z.string().default('data/agent.db')
  })

  private readonly checkpointer: SqliteSaver
  /** 按 agentId 的运行时缓存：capability 注册表 version 变更即全部失效，下次 run 重建 */
  private runtimes = new Map<string, { version: number; agent: ReturnType<typeof createAgent> }>()

  constructor(ctx: Context, config: z.infer<typeof AgentService.Config>) {
    super(ctx, 'agent')
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
      // 轮次号在 run 入口算一次，同一轮内所有事件共用（含 error/timeout）
      const turnNo = this.ctx.turns.nextTurnNo(threadId)
      const timer = setTimeout(() => {
        controller.abort()
        this.ctx.emit('agent/timeout', { threadId, turnNo })
      }, AGENT_RUN_TIMEOUT_MS)

      try {
        const agent = await this.ensureAgent(agentId)
        this.ctx.emit('agent/input', { threadId, turnNo, input })

        // todo thread 新增个 system_prompt 字段 这里看看怎么拿到然后写进去

        const stream = await agent.stream(
          { messages: [new HumanMessage(input)] },
          {
            streamMode: 'updates',
            signal: controller.signal,
            configurable: { thread_id: threadId }
          }
        )

        // stream 不是"只有 LLM 输出"——它是 LangGraph 整张图的逐步更新（streamMode:'updates'）。
        // createAgent 的图 = agent 节点（调 LLM）+ tools 节点（执行工具）交替循环：
        // 模型决定调工具 → agent 节点产出含 tool_calls 的 AIMessage → 图内部自动执行工具
        // （tools 节点产出 ToolMessage）→ 循环回 agent → 直到模型不再调工具，最后的非工具
        // AIMessage 即最终答案。所以工具调用发生在图内部（createAgent 已把 tools 绑进图），
        // 这里只负责观察记录流经的步骤（发事件给 turn-recorder/output），不执行工具。
        for await (const step of stream) {
          for (const [node, update] of Object.entries(step)) {
            for (const msg of update.messages ?? []) {
              if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
                this.ctx.emit('agent/tool-call', {
                  threadId,
                  turnNo,
                  node,
                  toolCalls: msg.tool_calls.map(call => ({
                    id: call.id ?? '',
                    name: call.name,
                    args: call.args
                  }))
                })
              } else if (ToolMessage.isInstance(msg)) {
                this.ctx.emit('agent/tool-result', {
                  threadId,
                  turnNo,
                  node,
                  toolCallId: msg.tool_call_id,
                  text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
                })
              } else {
                const text = typeof msg.content === 'string' ? msg.content : ''
                this.ctx.emit('agent/result', { threadId, turnNo, node, text })
                if (text) {
                  answer = text // 最后一次非工具消息即最终答案
                }
              }
            }
          }
        }
      } catch (err) {
        this.ctx.emit('agent/error', { threadId, turnNo, error: stringify(err) })
        throw err
      } finally {
        clearTimeout(timer)
      }
    })
    return answer
  }

  /**
   * 路由识别（agentClient）：判断一条未绑定 thread 的消息该交给哪个 agent。
   * 轻量无状态 router：无 checkpointer、无系统工具，withStructuredOutput 强制 {agentId, reason}。
   * 识别失败/超时 → null（调用方降级 default）；agentId 合法性由调用方用 capability.hasDefinition 校验。
   */
  /** 路由识别结果：agentId + 模型给出的选择原因（agentId 为 null 时 reason 说明无法判断的原因） */
  async identify(input: string): Promise<{ agentId: string | null; reason: string } | null> {
    const definitions = this.ctx.capability.listDefinitions()
    const catalog = definitions
      .map(d => `- ${d.id}：${d.basePrompt.split('\n')[0]?.slice(0, 80) ?? ''}`)
      .join('\n')

    const system = new SystemMessage(
      `你是 agent 路由器，只输出 JSON。根据用户消息判断该交给哪个助手处理。\n可用助手：\n${catalog}\n` +
        '规则：\n1. 根据用户意图选择最合适的助手 id；\n' +
        '2. 无法确定、或不需要任何助手时返回 null；\n' +
        '3. 同时用一句话说明你的判断原因（reason 字段）。\n' +
        '输出格式：{"agentId": "助手 id 或 null", "reason": "原因"}，不要其它解释。'
    )
    const human = new HumanMessage(`用户消息：${input}`)

    try {
      // jsonMode：中转站对 functionCalling 的 tool_choice 支持不稳（thinking 模式报 400），
      // json_object 要求 prompt 里出现 "json" 字样（上面已包含）
      const classifier = this.ctx.provider
        .getModel()
        .withStructuredOutput(IDENTIFY_SCHEMA, { method: 'jsonMode' })
      const result = await classifier.invoke([system, human])
      return result
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
      // 打一条构建日志便于检查最终生效的 systemPrompt（每个 agent 每版本一次，非每轮）
      logger.info(
        `[agent] 构建运行时 systemPrompt（agent=${agentId} version=${version}）:\n${spec.systemPrompt}`
      )
      this.runtimes.set(agentId, {
        version,
        agent: createAgent({
          model: this.ctx.provider.getModel(),
          tools: spec.tools,
          systemPrompt: spec.systemPrompt,
          checkpointer: this.checkpointer
        })
      })
    }
    return this.runtimes.get(agentId)!.agent
  }
}
