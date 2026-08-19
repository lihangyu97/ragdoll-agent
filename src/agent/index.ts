import { ChatOpenAI } from "@langchain/openai"
import { createAgent } from "langchain"
import { API_KEY, BASE_URL, MODEL } from "@config/agent"
import { triggerHooks, triggerInputHooks } from "./hooks"
import SqliteCheckpointer from "./SqliteCheckpointer"
import SqliteAgentTurn from "./SqliteAgentTurn"
import _tools from "@toy/tools"
import _systemPrompt from "@toy/systemPrompt"

const model = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  streaming: true,
  maxRetries: 5,
  configuration: { baseURL: BASE_URL }
})

const checkpointer = new SqliteCheckpointer()
const agentTurn = new SqliteAgentTurn()

export const agent = createAgent({
  model,
  tools: _tools,
  systemPrompt: _systemPrompt,
  checkpointer: checkpointer.getCheckpointer()
})

// 运行 agent：thread_id 隔离会话，同一 thread 连续调用会延续历史对话
export async function run(
  input = "当前天气怎么样？",
  options?: { threadId?: string }
) {
  const threadId = options?.threadId ?? `${Date.now()}`
  // 开始一轮 turn（先于 INPUT hook），stream 结束关闭
  agentTurn.beginTurn(threadId)
  try {
    // 收集本次输入（stream 之前）
    triggerInputHooks(input, threadId)
    const stream = await agent.stream(
      { messages: [{ role: "user", content: input }] },
      { streamMode: "updates", ...checkpointer.buildConfig(threadId) }
    )
    for await (const step of stream) {
      for (const [node, update] of Object.entries(step)) {
        for (const msg of update.messages ?? []) {
          triggerHooks(msg, node)
        }
      }
    }
  } finally {
    agentTurn.endTurn()
  }
}
