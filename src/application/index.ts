import { LarkClient } from '@channels/lark'
import { Worker } from '@worker/index'
import { initSchema } from '@sqlite/base/schema'

export default class Application {
  private readonly lark = new LarkClient()
  private readonly worker = new Worker()

  public async start(): Promise<void> {
    this.bindProcessSignals()

    initSchema()
    this.worker.start()
    await this.lark.start()
  }

  private close(): void {
    this.worker.stop()
    this.lark.close()
  }

  public handleStartupError(error: unknown) {
    console.error(error)
    process.exitCode = 1
  }

  private bindProcessSignals() {
    const close = () => {
      this.close()
      process.exit(0)
    }

    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  }
}
