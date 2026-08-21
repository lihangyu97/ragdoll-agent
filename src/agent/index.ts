import { ChatOpenAI } from '@langchain/openai'
import { createAgent } from 'langchain'
import { API_KEY, BASE_URL, MODEL } from '@config/agent'
import { Hooks, triggerHooks } from './hooks'
import Checkpointer from '@sqlite/checkpointer'
import AgentTurn from '@sqlite/agentTurn'
import logger from '@logger'
import _tools from '@toy/tools'
import _systemPrompt from '@toy/systemPrompt'

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

export async function run(input: string, threadId: string): Promise<void> {
  try {
    agentTurn.beginTurn(threadId)
    triggerHooks(Hooks.INPUT, threadId, input)

    const stream = await agent.stream(
      { messages: [{ role: 'user', content: input }] },
      { streamMode: 'updates', ...checkpointer.buildConfig(threadId) }
    )
    for await (const step of stream) {
      for (const [node, update] of Object.entries(step)) {
        for (const msg of update.messages ?? []) {
          triggerHooks(node, threadId, msg)
        }
      }
    }
  } finally {
    agentTurn.endTurn()
  }
}
