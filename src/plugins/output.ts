import type { Context } from 'cordis'

/** demo console 插件：订阅 agent/* 事件打印到控制台（原 toy/loggerHooks） */
export default {
  name: 'console-demo',
  apply(ctx: Context) {
    ctx.on('agent/input', ({ threadId, turnNo, input }) => {
      console.log(`[input] thread=${threadId} turn=${turnNo}: ${input}`)
    })

    ctx.on('agent/tool-call', ({ node, turnNo, toolCalls }) => {
      console.log(`[${node}] turn=${turnNo} toolCalls: ${JSON.stringify(toolCalls)}`)
    })

    ctx.on('agent/tool-result', ({ node, turnNo, toolCallId, text }) => {
      console.log(`[${node}] turn=${turnNo} tool(${toolCallId}): ${text}`)
    })

    ctx.on('agent/result', ({ node, turnNo, text }) => {
      console.log(`[${node}] turn=${turnNo} ${text}`)
    })

    ctx.on('agent/error', ({ threadId, turnNo, error }) => {
      console.log(`[error] thread=${threadId} turn=${turnNo}: ${error}`)
    })
  }
}
