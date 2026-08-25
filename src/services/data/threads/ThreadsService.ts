import { Service, type Context } from 'cordis'
import { agentThreads, THREAD_STATUS } from '@/services/data/database/schema'

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

  /** 确保 thread 存在（没有则创建）。冲突即忽略，sender_open_id 只在首次写入（会话发起者） */
  ensureThread(threadId: string, chatType: string, chatId: string, senderOpenId: string | null) {
    this.ctx.database.db
      .insert(agentThreads)
      .values({ threadId, chatType, chatId, senderOpenId, status: THREAD_STATUS.ACTIVE })
      .onConflictDoNothing()
      .run()
  }
}
