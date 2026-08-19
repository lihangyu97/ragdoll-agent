import { ChatOpenAI } from "@langchain/openai"
import { createAgent } from "langchain"
import { API_KEY, BASE_URL, MODEL } from "@config/agent"
import { triggerHooks } from "./hooks"
import _tools from "./_tools"
import _systemPrompt from "./_systemPrompt"

const model = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  streaming: true,
  maxRetries: 5,
  configuration: { baseURL: BASE_URL }
})

export const agent = createAgent({
  model,
  tools: _tools,
  systemPrompt: _systemPrompt
})

export async function run(input = "当前天气怎么样？") {
  const stream = await agent.stream(
    { messages: [{ role: "user", content: input }] },
    { streamMode: "updates" }
  )
  for await (const step of stream) {
    for (const [node, update] of Object.entries(step)) {
      for (const msg of update.messages ?? []) {
        triggerHooks(msg, node)
      }
    }
  }
}
