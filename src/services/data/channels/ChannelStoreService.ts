import { Service, type Context } from 'cordis'
import { and, eq, sql } from 'drizzle-orm'
import { channelMessages, channelUsers } from '@/services/data/database/schema'

export type ChannelMessageRecord = typeof channelMessages.$inferInsert

declare module 'cordis' {
  interface Context {
    channelStore: ChannelStoreService
  }
}

/** channelStore Service：渠道消息与用户缓存 repository（通用，所有渠道共用） */
export default class ChannelStoreService extends Service {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, 'channelStore')
  }

  /** 写入一条渠道消息记录 */
  insertMessage(record: ChannelMessageRecord) {
    this.ctx.database.db.insert(channelMessages).values(record).run()
  }

  /** 按 channel + userId 查用户名，找不到返回 null */
  getUserName(channel: string, userId: string): string | null {
    const row = this.ctx.database.db
      .select({ name: channelUsers.name })
      .from(channelUsers)
      .where(and(eq(channelUsers.channel, channel), eq(channelUsers.userId, userId)))
      .limit(1)
      .get()
    return row?.name ?? null
  }

  /** 写入/更新用户信息（channel + userId 已存在则刷新名字和 updated_at） */
  upsertUser(channel: string, userId: string, name: string) {
    this.ctx.database.db
      .insert(channelUsers)
      .values({ channel, userId, name })
      .onConflictDoUpdate({
        target: [channelUsers.channel, channelUsers.userId],
        set: { name, updatedAt: sql`datetime('now', 'localtime')` }
      })
      .run()
  }
}
