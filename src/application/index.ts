import { LarkClient } from "@channels/lark"
import { Worker } from "@worker/index"

export default class Application {
  private readonly lark = new LarkClient()
  private readonly worker: Worker

  constructor() {
    this.worker = new Worker({
      replyToMessage: async (messageId, text) => {
        await this.lark.replyToMessage(messageId, text)
      }
    })
  }

  /** 启动飞书长连接 + Worker */
  async start(): Promise<void> {
    this.bindProcessSignals()

    this.worker.start()
    await this.lark.start()
  }

  /** 关闭长连接和 Worker */
  close(): void {
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

    process.once("SIGINT", close)
    process.once("SIGTERM", close)
  }
}
