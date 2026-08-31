import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Service, type Context } from 'cordis'
import { z } from 'zod'
import { createAgent } from 'langchain'
import {
  AIMessage,
  ToolMessage,
  SystemMessage,
  HumanMessage,
  type BaseMessage
} from '@langchain/core/messages'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { stringify } from '@/utils'
import { threadContext } from '@/utils/context'
import logger from '@/utils/logger'
import type {
  AgentErrorEvent,
  AgentInputEvent,
  AgentResultEvent,
  AgentSystemPromptInfo,
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
    // 运行期改写点（waterfall）：每轮 run 广播基础 systemPrompt，插件可选择改写；
    // 监听器签名 (prompt, info, next)，调用 next() 取下游结果后再改写，直接返回则短路
    'agent/system-prompt': (
      systemPrompt: string,
      info: AgentSystemPromptInfo,
      next: () => unknown
    ) => unknown
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

  // 每轮组装 + createAgent：systemPrompt 每轮经 agent/system-prompt 钩子改写，不做缓存
  async run(input: string, threadId: string, agentId = 'default'): Promise<string | null> {
    let answer: string | null = null

    await threadContext.run(threadId, async () => {
      // 轮次号在 run 入口算一次，同一轮内所有事件共用（含 error/timeout）
      const turnNo = this.ctx.turns.nextTurnNo(threadId)

      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
        this.ctx.emit('agent/timeout', { threadId, turnNo })
      }, AGENT_RUN_TIMEOUT_MS)

      try {
        this.ctx.emit('agent/input', { threadId, turnNo, input })

        const { agent, streamInput } = await this.prepare(input, threadId, agentId, turnNo)
        const stream = await agent.stream(streamInput, {
          streamMode: 'updates',
          signal: controller.signal,
          configurable: { thread_id: threadId }
        })

        for await (const { node, msg } of this.iterMessages(stream)) {
          const text = this.handleMessage(msg, { threadId, turnNo, node })
          if (text) answer = text // 最后一次非工具消息即最终答案
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
   * 一轮 stream 的准备：组装基础 prompt（含组装期 agent/prompt-build 改写）→ agent/system-prompt
   * waterfall 运行期改写 → 按最终 prompt 构建 agent（langchain systemPrompt 构建期定死，每轮
   * 改写后必须重建；checkpointer 共享，thread 历史不丢）。返回 stream 所需的一切。
   */
  private async prepare(
    input: string,
    threadId: string,
    agentId: string,
    turnNo: number
  ): Promise<{
    agent: ReturnType<typeof createAgent>
    streamInput: { messages: [HumanMessage] }
  }> {
    const spec = await this.ctx.capability.assemble(agentId)
    const systemPrompt = this.ctx.waterfall(
      'agent/system-prompt',
      spec.systemPrompt,
      { threadId, turnNo, agentId, input },
      () => spec.systemPrompt
    ) as string
    const agent = createAgent({
      model: this.ctx.provider.getModel(),
      tools: spec.tools,
      systemPrompt,
      checkpointer: this.checkpointer
    })

    return {
      agent,
      streamInput: { messages: [new HumanMessage(input)] }
    }
  }

  /** 展平 LangGraph updates 流为 (node, msg) 消息流：三层嵌套收敛成单层遍历 */
  private async *iterMessages(
    stream: AsyncIterable<Record<string, { messages?: BaseMessage[] }>>
  ): AsyncGenerator<{ node: string; msg: BaseMessage }> {
    for await (const step of stream) {
      for (const [node, update] of Object.entries(step)) {
        for (const msg of update.messages ?? []) {
          yield { node, msg }
        }
      }
    }
  }

  /** 单条消息分发：工具调用 → agent/tool-call（content 过程话另发 agent/result），
   *  工具结果 → agent/tool-result，非工具文本 → agent/result 并返回文本（最终答案覆盖用） */
  private handleMessage(
    msg: BaseMessage,
    { threadId, turnNo, node }: { threadId: string; turnNo: number; node: string }
  ): string {
    if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
      // “边说边做”的过程话：content 里的文本也广播 agent/result 落库，但不作为最终答案
      const talk = typeof msg.content === 'string' ? msg.content : ''
      if (talk) {
        this.ctx.emit('agent/result', { threadId, turnNo, node, text: talk })
      }
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
      return ''
    }
    if (ToolMessage.isInstance(msg)) {
      this.ctx.emit('agent/tool-result', {
        threadId,
        turnNo,
        node,
        toolCallId: msg.tool_call_id,
        text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      })
      return ''
    }
    const text = typeof msg.content === 'string' ? msg.content : ''
    this.ctx.emit('agent/result', { threadId, turnNo, node, text })
    return text
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
}
