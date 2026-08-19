import { LarkClient } from "@channels/lark"

export default class Application {
  private readonly lark = new LarkClient()

  /** 启动飞书长连接（消息处理在 lark 客户端内部） */
  async start(): Promise<void> {
    this.bindProcessSignals()

    await this.lark.start()
  }

  /** 关闭长连接 */
  close(): void {
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
