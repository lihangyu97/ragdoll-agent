import { LarkClient } from '@/channels/lark'
import { Worker } from '@/worker/index'
import { initSchema } from '@/sqlite/base/schema'
import logger from '@/logger'

export default class Application {
  private readonly lark = new LarkClient()
  private readonly worker = new Worker()

  public async start(): Promise<void> {
    this.bindProcessSignals()
    this.bindUncaughtHandlers()

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

  private bindUncaughtHandlers() {
    // 兜住 safe 层覆盖不到的漏网异常（如 checkpointer 第三方连接），避免进程静默崩溃
    process.on('unhandledRejection', reason => {
      logger.error('[app] unhandledRejection: ', reason)
      process.exitCode = 1 // 标记退出码，事件循环清空后自然退出
    })

    process.on('uncaughtException', err => {
      logger.error('[app] uncaughtException: ', err)
      process.exit(1) // 进程状态已不可信，立即退出（重启后孤儿 trace 有重置兜底）
    })
  }
}
