import 'dotenv/config'
import { Context } from 'cordis'
import logger from '@/utils/logger'
import DatabaseService from '@/services/data/database/DatabaseService'
import TracesService from '@/services/data/traces/TracesService'
import ThreadsService from '@/services/data/threads/ThreadsService'
import TurnsService from '@/services/data/turns/TurnsService'
import PanelService from '@/services/data/panel/PanelService'
import ChannelStoreService from '@/services/data/channels/ChannelStoreService'
import CapabilityService from '@/services/agent/capability/CapabilityService'
import ProviderService from '@/services/agent/provider/ProviderService'
import AgentService from '@/services/agent/AgentService'
import ChannelService from '@/services/channel/ChannelService'
import LarkAdapter from '@/services/channel/adapters/lark/LarkAdapter'
import WorkerService from '@/services/worker/WorkerService'
// 目录约定：
// - src/agents/*：子 agent，只通过 ctx.capability 注册工具/skill/definition，不 import core 的 Service 实现（type 除外）
// - src/plugins/*：基础设施插件（channel、panel、worker 等与具体 agent 无关的胶水）
import channelLark from '@/plugins/channel-lark'
import weatherAssistant from '@/agents/weather'
import larkImage from '@/plugins/lark-image'
import skillLoader from '@/plugins/skill-loader'
import worker from '@/plugins/worker'
import panel from '@/plugins/panel'
import turnRecorder from '@/plugins/turn-recorder'
// import output from '@/plugins/output'

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

// 配置统一从环境变量读入，经 cordis Config（zod schema）校验后传给插件；缺配置 → 插件 FAILED
app.plugin(DatabaseService, { dbPath: process.env.RAGDOLL_DB_PATH ?? 'data/agent.db' })
app.plugin(TracesService)
app.plugin(ThreadsService)
app.plugin(TurnsService)
app.plugin(PanelService)
app.plugin(ChannelStoreService)
app.plugin(CapabilityService, {
  root: process.env.RAGDOLL_SYSTEM_TOOLS_ROOT ?? 'data/workspace',
  commands: (process.env.RAGDOLL_SYSTEM_TOOLS_COMMANDS ?? '').split(',').filter(Boolean),
  enableSkillScripts: process.env.RAGDOLL_ENABLE_SKILL_SCRIPTS === 'true'
})
app.plugin(ProviderService, {
  apiKey: process.env.RAGDOLL_OPENAI_API_KEY!,
  baseUrl: process.env.RAGDOLL_OPENAI_BASE_URL!,
  model: process.env.RAGDOLL_OPENAI_MODEL ?? 'deepseek-v4-flash'
})
app.plugin(AgentService, {
  dbPath: process.env.RAGDOLL_DB_PATH ?? 'data/agent.db'
})
app.plugin(weatherAssistant)
app.plugin(larkImage)
app.plugin(skillLoader, { skillsRoot: process.env.RAGDOLL_SKILLS_ROOT ?? 'skills' })
app.plugin(ChannelService, { thinkingReply: '🤔 正在思考中…' })
app.plugin(LarkAdapter, {
  appId: process.env.RAGDOLL_LARK_APP_ID!,
  appSecret: process.env.RAGDOLL_LARK_APP_SECRET!,
  domain: process.env.RAGDOLL_LARK_DOMAIN === 'lark' ? 'lark' : 'feishu'
})
app.plugin(channelLark)
app.plugin(WorkerService)
app.plugin(worker)
app.plugin(turnRecorder)
app.plugin(panel, { port: Number(process.env.RAGDOLL_PANEL_PORT ?? 3111) })
// app.plugin(output)

// 启动时打印挂载的 agent 目录。skill-loader 的 apply 是异步的，但 definition 注册
// （weather 插件）是同步 apply，退一个 macrotask 打印即可保证收齐
setTimeout(() => {
  const defs = app.capability.listDefinitions()
  const lines = defs
    .map(d => `  - ${d.id.padEnd(12)} ${d.basePrompt.split('\n')[0]?.slice(0, 60) ?? ''}`)
    .join('\n')
  console.log(`[app] 已挂载 ${defs.length} 个 agent definition：\n${lines}`)
}, 0)

let closing = false
const close = async () => {
  if (closing) process.exit(1) // 第二次信号：优雅退出被卡住时强制退出
  closing = true
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

process.on('SIGINT', close)
process.on('SIGTERM', close)
