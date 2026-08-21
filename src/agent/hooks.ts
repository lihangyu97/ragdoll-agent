import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'

/* ====== 类型 ====== */

export type HookType = 'INPUT' | 'TOOL_CALL' | 'TOOL_RESULT' | 'AGENT_RESULT' | 'AGENT_ERROR'

type InputHook = (threadId: string, input: string) => void
type ToolCallHook = (threadId: string, msg: AIMessage, node: string) => void
type ToolResultHook = (threadId: string, msg: ToolMessage, node: string) => void
type MessageHook = (threadId: string, msg: BaseMessage, node: string) => void
type ErrorHook = (threadId: string, error: string) => void

type HookMap = {
  INPUT: InputHook
  TOOL_CALL: ToolCallHook
  TOOL_RESULT: ToolResultHook
  AGENT_RESULT: MessageHook
  AGENT_ERROR: ErrorHook
}

/* ====== 运行时 ====== */

export const Hooks: { [K in HookType]: K } = {
  INPUT: 'INPUT',
  TOOL_CALL: 'TOOL_CALL',
  TOOL_RESULT: 'TOOL_RESULT',
  AGENT_RESULT: 'AGENT_RESULT',
  AGENT_ERROR: 'AGENT_ERROR'
}

/**
 * 事件总线：track 注册 / trigger 分发。
 * 可实例化（测试用 createHookBus 拿独立实例，互不污染）；生产所有模块共享默认实例。
 */
export class HookBus {
  private readonly handlers: { [K in HookType]: HookMap[K][] } = {
    [Hooks.INPUT]: [],
    [Hooks.TOOL_CALL]: [],
    [Hooks.TOOL_RESULT]: [],
    [Hooks.AGENT_RESULT]: [],
    [Hooks.AGENT_ERROR]: []
  }

  track<K extends HookType>(type: K, handler: HookMap[K]) {
    this.handlers[type].push(handler)
  }

  /** 单签名实现（精确类型重载见外层 triggerHooks） */
  trigger(type: HookType | string, threadId: string, payload: BaseMessage | string) {
    if (type in Hooks) {
      for (const handler of this.handlers[type as HookType]) {
        ;(handler as InputHook)(threadId, payload as string)
      }
    } else {
      const msg = payload as BaseMessage
      if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
        for (const handler of this.handlers[Hooks.TOOL_CALL]) {
          handler(threadId, msg, type)
        }
      } else if (ToolMessage.isInstance(msg)) {
        for (const handler of this.handlers[Hooks.TOOL_RESULT]) {
          handler(threadId, msg, type)
        }
      } else {
        for (const handler of this.handlers[Hooks.AGENT_RESULT]) {
          handler(threadId, msg, type)
        }
      }
    }
  }
}

export function createHookBus(): HookBus {
  return new HookBus()
}

/* ====== 生产默认实例：turn / worker / lark / toy 都注册到这里 ====== */

const defaultBus = createHookBus()

export function trackHook<K extends HookType>(type: K, handler: HookMap[K]) {
  defaultBus.track(type, handler)
}

export function triggerHooks(type: HookType, threadId: string, input: string): void
export function triggerHooks(node: string, threadId: string, msg: BaseMessage): void
export function triggerHooks(
  type: HookType | string,
  threadId: string,
  payload: BaseMessage | string
) {
  defaultBus.trigger(type, threadId, payload)
}
