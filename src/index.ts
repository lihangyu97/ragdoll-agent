import { Context } from 'cordis'
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
