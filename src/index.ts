import { AIMessage } from "@langchain/core/messages"
import { agent } from "./agent"

// streamMode: "updates" 逐个节点输出，可以看到 agent 每一步的决策与工具调用
const stream = await agent.stream(
  {
    messages: [{ role: "user", content: "What's the weather in Shanghai?" }]
  },
  { streamMode: "updates" }
)
for await (const step of stream) {
  for (const [node, update] of Object.entries(step)) {
    for (const msg of update.messages ?? []) {
      const toolCalls =
        AIMessage.isInstance(msg) && msg.tool_calls?.length
          ? `\n${JSON.stringify(msg.tool_calls, null, 2)}`
          : ""
      const now = new Date().toLocaleString()
      console.log(`now:${now} [${node}] ${msg.type}: ${msg.text}${toolCalls}`)
    }
  }
}
