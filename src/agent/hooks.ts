import {
  AIMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"

/* ====== 类型 ====== */

export type HookType = "INPUT" | "TOOL_CALL" | "TOOL_RESULT" | "AGENT_RESULT"

// 本次调用输入（agent.stream 之前触发）
type InputHook = (input: string, threadId: string) => void
type ToolCallHook = (msg: AIMessage, node: string) => void
type ToolResultHook = (msg: ToolMessage, node: string) => void
type MessageHook = (msg: BaseMessage, node: string) => void

type HookMap = {
  INPUT: InputHook
  TOOL_CALL: ToolCallHook
  TOOL_RESULT: ToolResultHook
  AGENT_RESULT: MessageHook
}

/* ====== 运行时 ====== */

export const Hooks: { [K in HookType]: K } = {
  INPUT: "INPUT",
  TOOL_CALL: "TOOL_CALL",
  TOOL_RESULT: "TOOL_RESULT",
  AGENT_RESULT: "AGENT_RESULT"
}

const hooks: { [K in HookType]: HookMap[K][] } = {
  [Hooks.INPUT]: [],
  [Hooks.TOOL_CALL]: [],
  [Hooks.TOOL_RESULT]: [],
  [Hooks.AGENT_RESULT]: []
}

export function trackHook<K extends HookType>(type: K, handler: HookMap[K]) {
  hooks[type].push(handler)
}

// 分发本次调用输入（agent.stream 之前调用）
export function triggerInputHooks(input: string, threadId: string) {
  for (const handler of hooks[Hooks.INPUT]) handler(input, threadId)
}

// 按消息类型分发到对应 hook 列表（3 个 case）
export function triggerHooks(msg: BaseMessage, node: string) {
  if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
    for (const handler of hooks[Hooks.TOOL_CALL]) handler(msg, node)
  } else if (ToolMessage.isInstance(msg)) {
    for (const handler of hooks[Hooks.TOOL_RESULT]) handler(msg, node)
  } else {
    for (const handler of hooks[Hooks.AGENT_RESULT]) handler(msg, node)
  }
}
