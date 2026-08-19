import { agent } from "./agent"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"

// streamMode: "updates" 逐个节点输出，可以看到 agent 每一步的决策与工具调用
try {
  const stream = await agent.stream(
    { messages: [{ role: "user", content: "What's the weather in Shanghai?" }] },
    { streamMode: "updates" }
  )
  for await (const step of stream) {
    for (const [node, update] of Object.entries(step)) {
      const last = (update as { messages?: BaseMessage[] }).messages?.at(-1)
      if (!last) continue
      const content =
        typeof last.content === "string" ? last.content : JSON.stringify(last.content)
      const toolCalls =
        last instanceof AIMessage && last.tool_calls?.length
          ? `\n${JSON.stringify(last.tool_calls, null, 2)}`
          : ""
      console.log(`[${node}] ${last.type}: ${content}${toolCalls}`)
    }
  }
} catch (err) {
  console.error("Agent 执行失败：", err)
  if (err instanceof TypeError && /reading 'message'/.test(err.message)) {
    console.error(
      "模型调用返回了空结果，常见原因：\n" +
        "  1. OPENAI_BASE_URL 未以 /v1 结尾（应为 https://xxx.com/v1）\n" +
        "  2. OPENAI_MODEL 在中转站上不存在或名称不对\n" +
        "  3. OPENAI_API_KEY 无效或额度不足（部分中转站会返回 200 + error）"
    )
  }
}
