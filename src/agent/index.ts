import { ChatOpenAI } from '@langchain/openai'
import { createAgent } from 'langchain'
import { API_KEY, BASE_URL, MODEL } from '@/config/agent'
import { Hooks, triggerHooks } from './hooks'
import Checkpointer from './checkpointer'
import AgentTurn from './turn'
import logger from '@/logger'
import _tools from '@/toy/tools'
import _systemPrompt from '@/toy/systemPrompt'

/** agent 单次执行的整体超时（毫秒）：覆盖多轮 LLM + 工具循环，超时通过 signal abort */
const AGENT_RUN_TIMEOUT_MS = 5 * 60_000

const model = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  streaming: true,
  // 单次请求 60s 超时 + 最多重试 2 次：避免 API 慢响应被 maxRetries 放大成 5+ 分钟
  timeout: 60_000,
  maxRetries: 2,
  configuration: { baseURL: BASE_URL }
})

const checkpointer = new Checkpointer()
const agentTurn = new AgentTurn()

export const agent = createAgent({
  model,
  tools: _tools,
  systemPrompt: _systemPrompt,
  checkpointer: checkpointer.getCheckpointer()
})

export async function run(input: string, threadId: string): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    logger.warn(`[agent] 执行超时中断（>${AGENT_RUN_TIMEOUT_MS / 1000}s）: ${threadId}`)
    controller.abort()
  }, AGENT_RUN_TIMEOUT_MS)

  try {
    agentTurn.beginTurn(threadId)
    triggerHooks(Hooks.INPUT, threadId, input)

    const stream = await agent.stream(
      { messages: [{ role: 'user', content: input }] },
      {
        streamMode: 'updates',
        signal: controller.signal,
        ...checkpointer.buildConfig(threadId)
      }
    )
    for await (const step of stream) {
      for (const [node, update] of Object.entries(step)) {
        for (const msg of update.messages ?? []) {
          triggerHooks(node, threadId, msg)
        }
      }
    }
  } finally {
    clearTimeout(timer)
    agentTurn.endTurn()
  }
}
