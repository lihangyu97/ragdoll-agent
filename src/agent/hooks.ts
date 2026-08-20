import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"

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

export function triggerHooks(type: HookType, msgOrInput: string, threadId: string): void
export function triggerHooks(node: string, msg: BaseMessage, threadId: string): void
export function triggerHooks(
  typeOrNode: HookType | string,
  msgOrInput: BaseMessage | string,
  threadId: string
) {
  if (typeOrNode in Hooks) {
    // 显式 HookType 分发
    const type = typeOrNode as HookType
    for (const handler of hooks[type]) (handler as InputHook)(msgOrInput as string, threadId)
  } else {
    // 自动检测消息类型分发
    const msg = msgOrInput as BaseMessage
    const node = typeOrNode
    if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
      for (const handler of hooks[Hooks.TOOL_CALL]) handler(msg, node)
    } else if (ToolMessage.isInstance(msg)) {
      for (const handler of hooks[Hooks.TOOL_RESULT]) handler(msg, node)
    } else {
      for (const handler of hooks[Hooks.AGENT_RESULT]) handler(msg, node)
    }
  }
}
