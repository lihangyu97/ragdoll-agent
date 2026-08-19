import { run } from "./agent"
import { trackHook, Hooks } from "./agent/hooks"

// 注册打印 hooks：同一类型可注册多个，按注册顺序执行
trackHook(Hooks.TOOL_CALL, (msg, node) => {
  console.log(
    `[${node}] ${msg.type}: ${msg.text} toolCalls: ${JSON.stringify(
      msg.tool_calls
    )}`
  )
})
trackHook(Hooks.TOOL_RESULT, (msg, node) => {
  console.log(`[${node}] ${msg.type}(${msg.tool_call_id}): ${msg.text}`)
})
trackHook(Hooks.AGENT_RESULT, (msg, node) => {
  console.log(`[${node}] ${msg.type}: ${msg.text}`)
})

await run()
