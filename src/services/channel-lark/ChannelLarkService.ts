import { Service, type Context } from 'cordis'
import type DatabaseService from '@/services/database/DatabaseService'

export type ChannelLarkRecord = {
  event_type: string
  app_id: string
  chat_id: string
  chat_type: string
  message_id: string
  message_type: string
  thread_id: string | null
  sender_open_id: string | null
  sender_type: string
  sender_name: string
  content: string
}

/** channelLark Service：飞书消息与用户缓存 repository */
export default class ChannelLarkService extends Service {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, 'channelLark')
  }

  /** 写入一条飞书消息记录 */
  insertLarkMessage(record: ChannelLarkRecord) {
    this.ctx.database.run(
      `INSERT INTO channel_lark
       (event_type, app_id, chat_id, chat_type, message_id, message_type,
        thread_id, sender_open_id, sender_type, sender_name, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.event_type,
        record.app_id,
        record.chat_id,
        record.chat_type,
        record.message_id,
        record.message_type,
        record.thread_id,
        record.sender_open_id,
        record.sender_type,
        record.sender_name,
        record.content
      ]
    )
  }

  /** 按 open_id 查用户名，找不到返回 null */
  getUserName(openId: string): string | null {
    const row = this.ctx.database.get<{ name: string }>(
      `SELECT name FROM channel_lark_user WHERE open_id = ?`,
      [openId]
    )
    return row?.name ?? null
  }

  /** 写入/更新用户信息（open_id 已存在则刷新名字和 updated_at） */
  upsertUser(openId: string, name: string) {
    this.ctx.database.run(
      `INSERT INTO channel_lark_user (open_id, name)
       VALUES (?, ?)
       ON CONFLICT(open_id) DO UPDATE SET
         name = excluded.name,
         updated_at = datetime('now', 'localtime')`,
      [openId, name]
    )
  }
}
