import { Service, type Context } from 'cordis'
import { eq, sql } from 'drizzle-orm'
import { channelLark, channelLarkUser } from '@/services/data/database/schema'

export type ChannelLarkRecord = typeof channelLark.$inferInsert

/** channelLark Service：飞书消息与用户缓存 repository */
export default class ChannelLarkService extends Service {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, 'channelLark')
  }

  /** 写入一条飞书消息记录 */
  insertLarkMessage(record: ChannelLarkRecord) {
    this.ctx.database.db.insert(channelLark).values(record).run()
  }

  /** 按 open_id 查用户名，找不到返回 null */
  getUserName(openId: string): string | null {
    const row = this.ctx.database.db
      .select({ name: channelLarkUser.name })
      .from(channelLarkUser)
      .where(eq(channelLarkUser.openId, openId))
      .limit(1)
      .get()
    return row?.name ?? null
  }

  /** 写入/更新用户信息（open_id 已存在则刷新名字和 updated_at） */
  upsertUser(openId: string, name: string) {
    this.ctx.database.db
      .insert(channelLarkUser)
      .values({ openId, name })
      .onConflictDoUpdate({
        target: channelLarkUser.openId,
        set: { name, updatedAt: sql`datetime('now', 'localtime')` }
      })
      .run()
  }
}
