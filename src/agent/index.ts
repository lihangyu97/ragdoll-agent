import { z } from "zod"
import { ChatOpenAI } from "@langchain/openai"
import { createAgent } from "langchain"
import { tool } from "@langchain/core/tools"
import { API_KEY, BASE_URL, MODEL } from "@config/agent"

const model = new ChatOpenAI({
  model: MODEL,
  apiKey: API_KEY,
  streaming: true,
  maxRetries: 5,
  configuration: { baseURL: BASE_URL }
})

const getWeather = tool(
  async ({ city }: { city: string }) =>
    `The weather in ${city} is sunny, 25°C.`,
  {
    name: "get_weather",
    description: "Get the current weather for a given city.",
    schema: z.object({ city: z.string().describe("City name") })
  }
)

// createAgent：模型 + 工具，自动编排「思考 → 调工具 → 再思考」的循环
export const agent = createAgent({
  model,
  tools: [getWeather]
})
