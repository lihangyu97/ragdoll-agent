import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import AgentService from './AgentService'

declare module 'cordis' {
  interface Context {
    agent: AgentService
  }
  interface Events {
    'agent/input'(threadId: string, input: string): void
    'agent/tool-call'(threadId: string, node: string, msg: AIMessage): void
    'agent/tool-result'(threadId: string, node: string, msg: ToolMessage): void
    'agent/result'(threadId: string, node: string, msg: BaseMessage): void
    'agent/error'(threadId: string, error: string): void
  }
}
