import { AsyncLocalStorage } from 'node:async_hooks'

/** 当前正在处理的 threadId 上下文，agent.run / worker 处理期间设置，logger 自动读取 */
export const threadContext = new AsyncLocalStorage<string>()
