import { run } from '@agent'
import { Hooks, triggerHooks } from '@agent/hooks'
import { getPendingTrace, updateTraceStatus, TRACE_STATUS } from '@sqlite/agentTraces'
import logger, { stringify } from '@logger'
import { threadContext } from '@logger/context'

/**
 * Agent Worker：每隔 3s 轮询 agent_traces 表，取最早一条 pending 记录，
 * 调用 agent.run() 处理并标记状态。最终回复由 run() 内部通过 AGENT_RESULT hook 广播。
 */
export class Worker {
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private wakeSleep: (() => void) | null = null

  start() {
    if (this.running) return
    this.running = true
    this.poll()
  }

  stop() {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // 唤醒可能正在 sleep 的 poll 循环，让它回到 while 顶部检查 running 后退出
    this.wakeSleep?.()
    this.wakeSleep = null
  }

  private async poll() {
    while (this.running) {
      const trace = getPendingTrace()

      if (!trace) {
        await this.sleep(3000)
        continue
      }

      // 原子抢锁：pending → processing，失败说明被其他进程抢走了
      const locked = updateTraceStatus(trace.id, TRACE_STATUS.PENDING, TRACE_STATUS.PROCESSING)
      if (!locked) continue

      logger.info(`[worker] 开始处理: ${trace.thread_id}`)

      // logger 自动关联 threadId
      await threadContext.run(trace.thread_id, async () => {
        try {
          await run(trace.input_text, trace.thread_id)

          updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.DONE)
          logger.info(`[worker] agent run done: ${trace.thread_id}`)
        } catch (err) {
          // 先广播错误（此时 trace 仍是 processing，订阅方可反查 message_id 回传），再标记失败
          triggerHooks(Hooks.AGENT_ERROR, trace.thread_id, stringify(err))
          updateTraceStatus(trace.id, TRACE_STATUS.PROCESSING, TRACE_STATUS.FAILED)
          logger.error(`[worker] agent run fail: ${trace.thread_id}`, err)
        }
      })
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.wakeSleep = resolve
      this.timer = setTimeout(() => {
        this.timer = null
        this.wakeSleep = null
        resolve()
      }, ms)
    })
  }
}
