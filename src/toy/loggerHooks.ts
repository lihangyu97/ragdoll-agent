import { trackHook, Hooks } from '@/agent/hooks'

export default {
  track() {
    // 注册打印 hooks：同一类型可注册多个，按注册顺序执行
    trackHook(Hooks.INPUT, (threadId, input) => {
      console.log(`[input] thread=${threadId}: ${input}`)
    })
    trackHook(Hooks.TOOL_CALL, (threadId, msg, node) => {
      console.log(`[${node}] ${msg.type} toolCalls: ${JSON.stringify(msg.tool_calls)}`)
    })
    trackHook(Hooks.TOOL_RESULT, (threadId, msg, node) => {
      console.log(`[${node}] ${msg.type}(${msg.tool_call_id}): ${msg.text}`)
    })
    trackHook(Hooks.AGENT_RESULT, (threadId, msg, node) => {
      console.log(`[${node}] ${msg.type}: ${msg.text}`)
    })
  }
}
