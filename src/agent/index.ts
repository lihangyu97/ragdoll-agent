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

const getLocation = tool(async () => `hangzhou`, {
  name: "getLocation",
  description:
    "Get the user's current city. Call this first before any weather query.",
  schema: z.object({})
})

const getWeather = tool(
  async ({ city }: { city: string }) =>
    `The weather in ${city} is sunny with clear skies.`,
  {
    name: "getWeather",
    description: "Get the current weather condition for a city.",
    schema: z.object({ city: z.string().describe("City name") })
  }
)

const getTemperature = tool(
  async ({ city }: { city: string }) => `The temperature in ${city} is 25°C.`,
  {
    name: "getTemperature",
    description: "Get the current temperature for a city.",
    schema: z.object({ city: z.string().describe("City name") })
  }
)

// createAgent：模型 + 工具，自动编排「思考 → 调工具 → 再思考」的循环
export const agent = createAgent({
  model,
  tools: [getLocation, getWeather, getTemperature],
  systemPrompt: `You are a helpful weather assistant. When the user asks about the current weather, follow this workflow:
1. Call getLocation first to determine the user's current city.
2. After you get the city, call getWeather and getTemperature TOGETHER in the same response (parallel tool calls), passing the city from step 1.
3. Combine both tool results into a final answer.

Always reply in Chinese (中文).`
})
