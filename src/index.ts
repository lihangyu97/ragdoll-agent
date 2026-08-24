import { Context } from 'cordis'
import LarkService from '@/services/lark/LarkService'
import channel from '@/plugins/channel'

const app = new Context()

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
