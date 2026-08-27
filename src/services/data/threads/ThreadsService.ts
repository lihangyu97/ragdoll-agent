import { Service, type Context } from 'cordis'
import { agentThreads, THREAD_STATUS } from '@/services/data/database/schema'
import { eq } from 'drizzle-orm'

export { THREAD_STATUS } from '@/services/data/database/schema'
export type { ThreadStatus } from '@/services/data/database/schema'

export type AgentThreadRecord = typeof agentThreads.$inferSelect

declare module 'cordis' {
  interface Context {
    threads: ThreadsService
  }
}

/** threads Service：agent_threads 会话线程 repository */
export default class ThreadsService extends Service {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, 'threads')
  }

  /** 确保 thread 存在（没有则创建）。冲突即忽略，sender_id 只在首次写入（会话发起者） */
  ensureThread(threadId: string, chatType: string, chatId: string, senderId: string | null) {
    this.ctx.database.db
      .insert(agentThreads)
      .values({ threadId, chatType, chatId, senderId, status: THREAD_STATUS.ACTIVE })
      .onConflictDoNothing()
      .run()
  }

  /** 读取 thread 绑定的 agent definition id（null = 未识别） */
  getAgentId(threadId: string): string | null {
    const row = this.ctx.database.db
      .select({ agentId: agentThreads.agentId })
      .from(agentThreads)
      .where(eq(agentThreads.threadId, threadId))
      .get()
    return row?.agentId ?? null
  }

  /** 绑定 thread → agent definition id（worker process 首次消费时调用，一次性定终身） */
  setAgentId(threadId: string, agentId: string) {
    this.ctx.database.db
      .update(agentThreads)
      .set({ agentId })
      .where(eq(agentThreads.threadId, threadId))
      .run()
  }
}
