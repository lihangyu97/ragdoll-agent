import { run } from '@/agent'

import loggerHooks from '@/toy/loggerHooks'

loggerHooks.track()

const threadId = `thread-${Date.now()}`

console.log('=== 第一轮（thread: default） ===')
await run('我的名字是：李航宇，当前天气怎么样？', threadId)
console.log('=== 第二轮（同一 thread，应记得上一轮） ===')
await run('我叫什么名字来着？', threadId)
