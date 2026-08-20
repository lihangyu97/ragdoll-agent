import { run } from "@agent"
import { Hooks, triggerHooks } from "@agent/hooks"
import { getPendingTrace, updateTraceStatus } from "@sqlite/agentTraces"

/**
 * Agent Worker：每隔 3s 轮询 agent_traces 表，取最早一条 pending 记录，
 * 调用 agent.run() 处理，完成后标记 done，并通过 AGENT_MESSAGE hook 广播回复。
 */
export class Worker {
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private wakeSleep: (() => void) | null = null

  start() {
    if (this.running) return
    this.running = true
    console.log("[worker] 启动")
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
    console.log("[worker] 停止")
  }

  private async poll() {
    while (this.running) {
      const trace = getPendingTrace()

      if (!trace) {
        // 没有待处理消息，等 3s 再查
        await this.sleep(3000)
        continue
      }

      // 原子抢锁：pending → processing，失败说明被其他进程抢走了
      const locked = updateTraceStatus(trace.id, "pending", "processing")
      if (!locked) continue

      console.log(`[worker] 处理 trace#${trace.id} thread=${trace.thread_id}`)

      try {
        const result = await run(trace.input_text, { threadId: trace.thread_id })
        updateTraceStatus(trace.id, "processing", "done")
        console.log(`[worker] trace#${trace.id} 完成`)

        if (result) {
          triggerHooks(Hooks.AGENT_MESSAGE, trace.thread_id, {
            messageId: trace.message_id,
            text: result
          })
        }
      } catch (err) {
        updateTraceStatus(trace.id, "processing", "failed")
        console.error(`[worker] trace#${trace.id} 失败:`, err)
      }
      // 处理完立即查下一条，不等待
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
