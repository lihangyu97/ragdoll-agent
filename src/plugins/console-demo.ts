import type { Context } from 'cordis'

/** demo console 插件：订阅 agent/* 事件打印到控制台（原 toy/loggerHooks） */
export default {
  name: 'console-demo',
  apply(ctx: Context) {
    ctx.on('agent/input', (threadId, input) => {
      console.log(`[input] thread=${threadId}: ${input}`)
    })

    ctx.on('agent/tool-call', (threadId, node, step) => {
      console.log(`[${node}] toolCalls: ${JSON.stringify(step.toolCalls)}`)
    })

    ctx.on('agent/tool-result', (threadId, node, step) => {
      console.log(`[${node}] tool(${step.toolCallId}): ${step.text}`)
    })

    ctx.on('agent/result', (threadId, node, step) => {
      console.log(`[${node}] ${step.text}`)
    })
  }
}
