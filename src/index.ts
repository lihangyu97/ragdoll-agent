import { AIMessage, ToolMessage } from "@langchain/core/messages"
import { agent } from "./agent"

// streamMode: "updates" 逐个节点输出，可以看到 agent 每一步的决策与工具调用
const stream = await agent.stream(
  {
    messages: [{ role: "user", content: "当前天气怎么样？" }]
  },
  { streamMode: "updates" }
)
for await (const step of stream) {
  for (const [node, update] of Object.entries(step)) {
    for (const msg of update.messages ?? []) {
      // ToolMessage.tool_call_id 与 AIMessage.tool_calls 里的 id 是同一个值，即关联键
      if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
        console.log(
          `[${node}] ${msg.type}: ${msg.text} toolCalls: ${JSON.stringify(
            msg.tool_calls,
            null,
            2
          )}`
        )
      } else if (ToolMessage.isInstance(msg)) {
        console.log(`[${node}] ${msg.type}(${msg.tool_call_id}): ${msg.text}`)
      } else {
        console.log(`[${node}] ${msg.type}: ${msg.text}`)
      }
    }
  }
}
