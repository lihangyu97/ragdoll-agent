import type { Context } from 'cordis'

/**
 * turn-recorder 插件：订阅 agent/* 事件，把每轮执行的输入/决策/结果/回复写入 agent_turns。
 * 以 agent/input 为轮次边界（worker 串行消费，同一时刻只有一个 thread 在跑），
 * 事件到达即当前活跃轮次；无活跃轮次（非 INPUT 开头）的记录被忽略。
 * 事件载荷为框架无关结构（src/services/agent/steps.ts），本插件不依赖任何 agent 框架类型。
 */
export default {
  name: 'turn-recorder',
  inject: ['turns'],
  apply(ctx: Context) {
    let turn: { threadId: string; turnNo: number } | null = null

    ctx.on('agent/input', (threadId, input) => {
      turn = { threadId, turnNo: ctx.turns.getMaxTurnNo(threadId) + 1 }
      ctx.turns.insertTurn({
        threadId,
        turnNo: turn.turnNo,
        hookType: 'INPUT',
        content: input
      })
    })

    ctx.on('agent/tool-call', (threadId, node, step) => {
      if (!turn || turn.threadId !== threadId) return
      ctx.turns.insertTurn({
        threadId,
        turnNo: turn.turnNo,
        hookType: 'TOOL_CALL',
        node: node ?? null,
        toolCalls: JSON.stringify(step.toolCalls)
      })
    })

    ctx.on('agent/tool-result', (threadId, node, step) => {
      if (!turn || turn.threadId !== threadId) return
      ctx.turns.insertTurn({
        threadId,
        turnNo: turn.turnNo,
        hookType: 'TOOL_RESULT',
        node: node ?? null,
        toolCallId: step.toolCallId,
        toolsResult: step.text
      })
    })

    ctx.on('agent/result', (threadId, node, step) => {
      if (!turn || turn.threadId !== threadId) return
      ctx.turns.insertTurn({
        threadId,
        turnNo: turn.turnNo,
        hookType: 'AGENT_RESULT',
        node: node ?? null,
        content: step.text
      })
    })
  }
}
