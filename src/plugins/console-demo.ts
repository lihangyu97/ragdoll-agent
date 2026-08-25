import type { Context } from 'cordis'

/** demo console 插件：订阅 agent/* 事件打印到控制台（原 toy/loggerHooks） */
export default {
  name: 'console-demo',
  apply(ctx: Context) {
    ctx.on('agent/input', (threadId, input) => {
      console.log(`[input] thread=${threadId}: ${input}`)
    })

    ctx.on('agent/tool-call', (threadId, node, msg) => {
      console.log(`[${node}] ${msg.type} toolCalls: ${JSON.stringify(msg.tool_calls)}`)
    })

    ctx.on('agent/tool-result', (threadId, node, msg) => {
      console.log(`[${node}] ${msg.type}(${msg.tool_call_id}): ${msg.text}`)
    })

    ctx.on('agent/result', (threadId, node, msg) => {
      console.log(`[${node}] ${msg.type}: ${msg.text}`)
    })
  }
}
