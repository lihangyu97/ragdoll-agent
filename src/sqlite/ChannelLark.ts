import SqliteBase from "@sqlite/SqliteBase"

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

// 飞书消息落库（channel_lark 表 + channel_lark_user 表）
export default class SqliteChannelLark extends SqliteBase {
  protected override createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_lark (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        app_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        message_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        thread_id TEXT,
        sender_open_id TEXT,
        sender_type TEXT NOT NULL,
        sender_name TEXT,
        content TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_lark_user (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        open_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `)
  }

  /** 写入一条飞书消息记录 */
  insert(record: ChannelLarkRecord) {
    this.db
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
  }

  /** 按 open_id 查用户名，找不到返回 null */
  getUserName(openId: string): string | null {
    const row = this.db
      .prepare(`SELECT name FROM channel_lark_user WHERE open_id = ?`)
      .get(openId) as { name: string } | undefined
    return row?.name ?? null
  }

  /** 写入/更新用户信息（open_id 已存在则刷新名字和 updated_at） */
  upsertUser(openId: string, name: string) {
    this.db
      .prepare(
        `INSERT INTO channel_lark_user (open_id, name)
         VALUES (?, ?)
         ON CONFLICT(open_id) DO UPDATE SET
           name = excluded.name,
           updated_at = datetime('now', 'localtime')`
      )
      .run(openId, name)
  }
}
