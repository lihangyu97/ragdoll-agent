/**
 * agent 事件载荷（框架无关）：langchain backend 负责把 BaseMessage 等框架类型转换成这里的中立结构。
 * 观测层（turn-recorder / console-demo / 未来 guardrails）只消费这些类型，不感知底层框架。
 *
 * 所有 agent/* 事件统一为单个 payload 对象：事件名本身即判别符（无需 type 字段），
 * 公共身份字段（threadId / turnNo）放在 AgentEventBase 里。turnNo 由 AgentService
 * 在 run() 入口计算一次并随每个事件下发，观测方直接读载荷归组，无需推断"当前活跃轮次"。
 * payload 化让事件参数演进（增删字段）对订阅方是兼容变更，而不是破坏性签名改动。
 */

/** 工具调用信息（框架无关） */
export interface ToolCallInfo {
  id: string
  name: string
  args: unknown
}

/** 所有 agent 事件的公共身份字段 */
export interface AgentEventBase {
  threadId: string
  turnNo: number
}

/** agent/input 事件载荷：一轮执行的用户输入 */
export interface AgentInputEvent extends AgentEventBase {
  input: string
}

/** agent/tool-call 事件载荷：模型决定调用哪些工具 */
export interface AgentToolCallEvent extends AgentEventBase {
  node: string
  toolCalls: ToolCallInfo[]
}

/** agent/tool-result 事件载荷：某个工具的执行结果 */
export interface AgentToolResultEvent extends AgentEventBase {
  node: string
  toolCallId: string
  text: string
}

/** agent/result 事件载荷：一轮非工具消息（最终答案取最后一次非空 text） */
export interface AgentResultEvent extends AgentEventBase {
  node: string
  text: string
}

/** agent/error 事件载荷：本轮执行失败 */
export interface AgentErrorEvent extends AgentEventBase {
  error: string
}

/** agent/timeout 事件载荷：本轮执行超时被 abort */
export interface AgentTimeoutEvent extends AgentEventBase {}
