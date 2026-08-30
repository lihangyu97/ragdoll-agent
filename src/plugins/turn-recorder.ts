import type { Context } from 'cordis'
import logger from '@/utils/logger'
import { TURN_HOOK } from '@/services/data/database/schema'

/**
 * turn-recorder 插件：订阅 agent/* 事件，把每轮执行的输入/决策/结果/回复/失败/超时写入 agent_turns。
 * 轮次身份（threadId + turnNo）在事件 payload 的公共字段里（steps.ts AgentEventBase），
 * 本插件只做归组落库，不维护"当前活跃轮次"的内存状态——因此并发/交错线程、事件乱序
 * 都不会丢记录或错记轮次。
 * agent_turns 有 UNIQUE(thread_id, turn_no) WHERE hook_type='INPUT' 的部分索引：
 * 并发下重复开轮（turnNo 分配竞态）会让 INPUT 插入冲突，这里捕获并告警，不崩溃。
 */
export default {
  name: 'turn-recorder',
  inject: ['turns'],
  apply(ctx: Context) {
    ctx.on('agent/input', ({ threadId, turnNo, input }) => {
      try {
        ctx.turns.insertTurn({
          threadId,
          turnNo,
          hookType: TURN_HOOK.INPUT,
          content: input
        })
      } catch (err) {
        // UNIQUE(thread_id, turn_no) WHERE INPUT 冲突：另一个入口已用同 turnNo 开了轮，本轮记录放弃
        logger.warn(
          `[turn-recorder] INPUT 写入冲突已忽略（thread=${threadId} turn=${turnNo}，疑似 turnNo 并发分配）: `,
          err
        )
      }
    })

    ctx.on('agent/tool-call', ({ threadId, turnNo, node, toolCalls }) => {
      // 一次响应可含多个并行调用：一次调用一行（带 toolCallId），与 TOOL_RESULT 行等值关联
      ctx.turns.insertTurns(
        toolCalls.map(call => ({
          threadId,
          turnNo,
          hookType: TURN_HOOK.TOOL_CALL,
          node,
          toolCallId: call.id,
          toolName: call.name,
          args: JSON.stringify(call.args)
        }))
      )
    })

    ctx.on('agent/tool-result', ({ threadId, turnNo, node, toolCallId, text }) => {
      ctx.turns.insertTurn({
        threadId,
        turnNo,
        hookType: TURN_HOOK.TOOL_RESULT,
        node,
        toolCallId,
        toolsResult: text
      })
    })

    ctx.on('agent/result', ({ threadId, turnNo, node, text }) => {
      ctx.turns.insertTurn({
        threadId,
        turnNo,
        hookType: TURN_HOOK.AGENT_RESULT,
        node,
        content: text
      })
    })

    ctx.on('agent/error', ({ threadId, turnNo, error }) => {
      ctx.turns.insertTurn({
        threadId,
        turnNo,
        hookType: TURN_HOOK.ERROR,
        content: error
      })
    })

    ctx.on('agent/timeout', ({ threadId, turnNo }) => {
      ctx.turns.insertTurn({
        threadId,
        turnNo,
        hookType: TURN_HOOK.TIMEOUT
      })
    })
  }
}
