import type { Context } from 'cordis'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'

/**
 * turn-recorder 插件：订阅 agent/* 事件，把每轮执行的输入/决策/结果/回复写入 agent_turns。
 * 以 agent/input 为轮次边界（worker 串行消费，同一时刻只有一个 thread 在跑），
 * 事件到达即当前活跃轮次；无活跃轮次（非 INPUT 开头）的记录被忽略。
 */
export default {
  name: 'turn-recorder',
  inject: ['turns'],
  apply(ctx: Context) {
    let turn: { threadId: string; turnNo: number } | null = null

    ctx.on('agent/input', (threadId, input) => {
      turn = { threadId, turnNo: ctx.turns.getMaxTurnNo(threadId) + 1 }
      record(ctx, turn, 'INPUT', threadId, undefined, input)
    })

    ctx.on('agent/tool-call', (threadId, node, msg) =>
      record(ctx, turn, 'TOOL_CALL', threadId, node, msg.text, msg)
    )

    ctx.on('agent/tool-result', (threadId, node, msg) =>
      record(ctx, turn, 'TOOL_RESULT', threadId, node, msg.text, msg)
    )

    ctx.on('agent/result', (threadId, node, msg) =>
      record(ctx, turn, 'AGENT_RESULT', threadId, node, msg.text, msg)
    )
  }
}

function record(
  ctx: Context,
  turn: { threadId: string; turnNo: number } | null,
  hookType: string,
  threadId: string,
  node: string | undefined,
  content: string,
  msg?: BaseMessage
) {
  if (!turn || turn.threadId !== threadId) return
  const isToolResult = hookType === 'TOOL_RESULT'
  ctx.turns.insertTurn({
    threadId,
    turnNo: turn.turnNo,
    hookType,
    node: node ?? null,
    msgType: msg?.type ?? null,
    toolCallId: extractToolCallId(msg),
    toolCalls:
      AIMessage.isInstance(msg) && msg.tool_calls?.length ? JSON.stringify(msg.tool_calls) : null,
    content: isToolResult ? null : content || null,
    toolsResult: isToolResult ? content || null : null
  })
}

/** 提取工具调用 id：ToolMessage 直接取；AIMessage（TOOL_CALL 决策）取全部调用 id（并行时多个，逗号拼接） */
function extractToolCallId(msg?: BaseMessage): string | null {
  if (!msg) return null
  if (ToolMessage.isInstance(msg)) return msg.tool_call_id
  if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
    return msg.tool_calls.map(call => call.id).join(',')
  }
  return null
}
