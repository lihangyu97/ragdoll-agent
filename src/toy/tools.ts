import { z } from "zod"
import { tool } from "@langchain/core/tools"

const getLocation = tool(async () => `hangzhou`, {
  name: "getLocation",
  description: "Get the user's current city. Call this first before any weather query.",
  schema: z.object({})
})

const getWeather = tool(
  async ({ city }: { city: string }) => `The weather in ${city} is sunny with clear skies.`,
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

export default [getLocation, getWeather, getTemperature]
