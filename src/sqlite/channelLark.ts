import { getDb } from './db'

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

/** 写入一条飞书消息记录 */
export function insertLarkMessage(record: ChannelLarkRecord) {
  try {
    getDb()
      .prepare(
        `INSERT INTO channel_lark
       (event_type, app_id, chat_id, chat_type, message_id, message_type,
        thread_id, sender_open_id, sender_type, sender_name, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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
      )
  } catch (error) {
    console.log(`🔥 error ===>`, error, `<=== 🔥`)
  }
}

/** 按 open_id 查用户名，找不到返回 null */
export function getUserName(openId: string): string | null {
  const row = getDb()
    .prepare(`SELECT name FROM channel_lark_user WHERE open_id = ?`)
    .get(openId) as { name: string } | undefined
  return row?.name ?? null
}

/** 写入/更新用户信息（open_id 已存在则刷新名字和 updated_at） */
export function upsertUser(openId: string, name: string) {
  getDb()
    .prepare(
      `INSERT INTO channel_lark_user (open_id, name)
       VALUES (?, ?)
       ON CONFLICT(open_id) DO UPDATE SET
         name = excluded.name,
         updated_at = datetime('now', 'localtime')`
    )
    .run(openId, name)
}
