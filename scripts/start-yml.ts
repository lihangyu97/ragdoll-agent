import 'dotenv/config'
import { Context } from 'cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@cordisjs/plugin-loader'
import logger from '@/utils/logger'

/**
 * yml 启动入口：`pnpm start:yml`
 *
 * 等价于 cordis 自带 bin.js（`new Context()` → 挂 plugin-loader → 用 plugin-include 读 cordis.yml），
 * 但放在 tsx 下运行并补了三件事：
 * 1. dotenv：加载 .env（bin.js 不读 env 文件）
 * 2. console exporter：cordis 内置 logger 默认只缓冲不输出，先注册才能看到插件 FAILED 原因（同 src/index.ts）
 * 3. 优雅退出：Ctrl-C / SIGTERM 按加载逆序 dispose 所有条目 fiber 后退出（同 src/index.ts 的 close）
 *
 * 为什么不用 `node --import tsx node_modules/cordis/bin.js`：bin.js 用纯 node 动态 import，
 * 无法解析本项目 TS 源码里的 `@/*` 路径别名；本脚本经 tsx 运行，loader 加载 ./src 下的 TS 插件时别名可用。
 */
const app = new Context()
app.baseUrl = pathToFileURL(process.cwd()).href + '/'

// cordis 内置 logger 默认只缓冲不输出，注册 console exporter 让插件错误可见（如缺 env 的 FAILED 原因）
app.logger.exporter({
  export(message) {
    if (message.type === 'error' || message.type === 'warn') {
      console.error(`[cordis/${message.name}]`, ...message.args)
    }
  }
})

// 兜住插件层漏网异常（如 checkpointer 第三方连接），避免进程静默崩溃（同 src/index.ts）
process.on('unhandledRejection', reason => {
  logger.error('[app] unhandledRejection: ', reason)
  process.exitCode = 1 // 标记退出码，事件循环清空后自然退出
})

process.on('uncaughtException', err => {
  logger.error('[app] uncaughtException: ', err)
  process.exit(1) // 进程状态已不可信，立即退出（重启后孤儿 trace 有重置兜底）
})

// 挂 loader，再由 plugin-include 读取 cordis.yml 装配插件树（插件名=本地 TS 模块，config 从 yml 传入）
await app.plugin(Loader)
await app.loader.create({
  name: '@cordisjs/plugin-include',
  config: { path: './cordis.yml', enableLogs: true }
})

// 优雅退出：dispose 所有条目 fiber（逆序），然后退出
const close = async () => {
  const fibers = []
  for (const entry of app.loader.entries()) {
    if (entry.fiber) fibers.push(entry.fiber)
  }

  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }

  process.exit(0)
}

process.once('SIGINT', close)
process.once('SIGTERM', close)
