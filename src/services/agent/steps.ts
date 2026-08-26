/**
 * agent 事件载荷（框架无关）：langchain backend 负责把 BaseMessage 等框架类型转换成这里的中立结构。
 * 观测层（turn-recorder / console-demo / 未来 guardrails）只消费这些类型，不感知底层框架。
 */

/** 工具调用信息（框架无关） */
export interface ToolCallInfo {
  id: string
  name: string
  args: unknown
}

/** agent/tool-call 事件载荷：模型决定调用哪些工具 */
export interface AgentToolCallEvent {
  toolCalls: ToolCallInfo[]
}

/** agent/tool-result 事件载荷：某个工具的执行结果 */
export interface AgentToolResultEvent {
  toolCallId: string
  text: string
}

/** agent/result 事件载荷：一轮非工具消息（最终答案取最后一次非空 text） */
export interface AgentResultEvent {
  text: string
}
