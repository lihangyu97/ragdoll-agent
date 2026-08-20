import { ChatOpenAI } from "@langchain/openai"
import { createAgent } from "langchain"
import { API_KEY, BASE_URL, MODEL } from "@config/agent"
import { Hooks, triggerHooks } from "./hooks"
import Checkpointer from "@sqlite/Checkpointer"
import AgentTurn from "@sqlite/AgentTurn"
import _tools from "@toy/tools"
import _systemPrompt from "@toy/systemPrompt"

const model = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  streaming: true,
  maxRetries: 5,
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

// 运行 agent：thread_id 隔离会话，同一 thread 连续调用会延续历史对话
export async function run(input: string, options?: { threadId?: string }) {
  const threadId = options?.threadId ?? `${Date.now()}`
  // 开始一轮 turn（先于 INPUT hook），stream 结束关闭
  agentTurn.beginTurn(threadId)
  try {
    // 收集本次输入（stream 之前）
    triggerHooks(Hooks.INPUT, input, threadId)
    const stream = await agent.stream(
      { messages: [{ role: "user", content: input }] },
      { streamMode: "updates", ...checkpointer.buildConfig(threadId) }
    )
    for await (const step of stream) {
      for (const [node, update] of Object.entries(step)) {
        for (const msg of update.messages ?? []) {
          triggerHooks(node, msg, threadId)
        }
      }
    }
  } finally {
    agentTurn.endTurn()
  }
}
