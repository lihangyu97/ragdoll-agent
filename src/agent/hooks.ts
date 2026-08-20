import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"

/* ====== 类型 ====== */

export type HookType = "INPUT" | "TOOL_CALL" | "TOOL_RESULT" | "AGENT_RESULT" | "AGENT_MESSAGE"

// 本次调用输入（agent.stream 之前触发）
type InputHook = (threadId: string, input: string) => void
type ToolCallHook = (threadId: string, msg: AIMessage, node: string) => void
type ToolResultHook = (threadId: string, msg: ToolMessage, node: string) => void
type MessageHook = (threadId: string, msg: BaseMessage, node: string) => void

/** Worker 处理完成，产生一条要发送给用户的消息 */
export type AgentMessagePayload = {
  messageId: string
  text: string
}
type AgentMessageHook = (threadId: string, payload: AgentMessagePayload) => void

type HookMap = {
  INPUT: InputHook
  TOOL_CALL: ToolCallHook
  TOOL_RESULT: ToolResultHook
  AGENT_RESULT: MessageHook
  AGENT_MESSAGE: AgentMessageHook
}

/* ====== 运行时 ====== */

export const Hooks: { [K in HookType]: K } = {
  INPUT: "INPUT",
  TOOL_CALL: "TOOL_CALL",
  TOOL_RESULT: "TOOL_RESULT",
  AGENT_RESULT: "AGENT_RESULT",
  AGENT_MESSAGE: "AGENT_MESSAGE"
}

const hooks: { [K in HookType]: HookMap[K][] } = {
  [Hooks.INPUT]: [],
  [Hooks.TOOL_CALL]: [],
  [Hooks.TOOL_RESULT]: [],
  [Hooks.AGENT_RESULT]: [],
  [Hooks.AGENT_MESSAGE]: []
}

export function trackHook<K extends HookType>(type: K, handler: HookMap[K]) {
  hooks[type].push(handler)
}

export function triggerHooks(type: HookType, threadId: string, input: string): void
export function triggerHooks(node: string, threadId: string, msg: BaseMessage): void
export function triggerHooks(
  type: "AGENT_MESSAGE",
  threadId: string,
  payload: AgentMessagePayload
): void
export function triggerHooks(
  type: HookType | string,
  threadId: string,
  payload: BaseMessage | string | AgentMessagePayload
) {
  if (type === Hooks.AGENT_MESSAGE) {
    for (const handler of hooks[Hooks.AGENT_MESSAGE]) {
      handler(threadId, payload as AgentMessagePayload)
    }
  } else if (type in Hooks) {
    for (const handler of hooks[type as HookType]) {
      ;(handler as InputHook)(threadId, payload as string)
    }
  } else {
    const msg = payload as BaseMessage
    if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
      for (const handler of hooks[Hooks.TOOL_CALL]) {
        handler(threadId, msg, type)
      }
    } else if (ToolMessage.isInstance(msg)) {
      for (const handler of hooks[Hooks.TOOL_RESULT]) {
        handler(threadId, msg, type)
      }
    } else {
      for (const handler of hooks[Hooks.AGENT_RESULT]) {
        handler(threadId, msg, type)
      }
    }
  }
}
