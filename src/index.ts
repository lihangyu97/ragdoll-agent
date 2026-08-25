import { Context } from 'cordis'
import logger from '@/utils/logger'
import DatabaseService from '@/services/database/DatabaseService'
import TracesService from '@/services/traces/TracesService'
import ThreadsService from '@/services/threads/ThreadsService'
import TurnsService from '@/services/turns/TurnsService'
import ChannelLarkService from '@/services/channel-lark/ChannelLarkService'
import AgentService from '@/services/agent/AgentService'
import LarkService from '@/services/lark/LarkService'
import WorkerService from '@/services/worker/WorkerService'
import channel from '@/plugins/channel'
import agentDemo from '@/plugins/agent-demo'
import worker from '@/plugins/worker'
import turnRecorder from '@/plugins/turn-recorder'
import consoleDemo from '@/plugins/console-demo'

const app = new Context()

// cordis 内置 logger 默认只缓冲不输出，注册 console exporter 让插件错误可见（如缺 env 的 FAILED 原因）
app.logger.exporter({
  export(message) {
    if (message.type === 'error' || message.type === 'warn') {
      console.error(`[cordis/${message.name}]`, ...message.args)
    }
  }
})

// 兜住 database Service 覆盖不到的漏网异常（如 checkpointer 第三方连接），避免进程静默崩溃
process.on('unhandledRejection', reason => {
  logger.error('[app] unhandledRejection: ', reason)
  process.exitCode = 1 // 标记退出码，事件循环清空后自然退出
})

process.on('uncaughtException', err => {
  logger.error('[app] uncaughtException: ', err)
  process.exit(1) // 进程状态已不可信，立即退出（重启后孤儿 trace 有重置兜底）
})

// database Service 构造时建表（initSchema）
app.plugin(DatabaseService)
app.plugin(TracesService)
app.plugin(ThreadsService)
app.plugin(TurnsService)
app.plugin(ChannelLarkService)
app.plugin(AgentService)
app.plugin(agentDemo)
app.plugin(LarkService)
app.plugin(channel)
app.plugin(WorkerService)
app.plugin(worker)
app.plugin(turnRecorder)
app.plugin(consoleDemo)

const close = async () => {
  const fibers = []
  for (const runtime of app.registry.values()) {
    for (const fiber of runtime.fibers) {
      fibers.push(fiber)
    }
  }

  for (const fiber of fibers.reverse()) {
    await fiber.dispose()
  }

  process.exit(0)
}

process.once('SIGINT', close)
process.once('SIGTERM', close)
