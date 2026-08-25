import { Context } from 'cordis'
import { initSchema } from '@/sqlite/base/schema'
import AgentService from '@/services/agent/AgentService'
import LarkService from '@/services/lark/LarkService'
import channel from '@/plugins/channel'
import agentDemo from '@/plugins/agent-demo'

const app = new Context()

// TODO: initSchema 应随 database Service 落地收编，当前先在根上初始化
initSchema()

app.plugin(AgentService)
app.plugin(agentDemo)
app.plugin(LarkService)
app.plugin(channel)

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
