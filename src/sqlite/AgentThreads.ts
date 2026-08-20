import SqliteBase from "@sqlite/SqliteBase"

export type AgentThreadRecord = {
  thread_id: string
  chat_type: string
  chat_id: string
  status: string
}

export type AgentTraceRecord = {
  id: number
  thread_id: string
  message_id: string
  chat_id: string
  input_text: string
  status: string
  created_at: string
}

// agent_threads（会话元信息）+ agent_traces（消息队列）
export default class SqliteAgentThreads extends SqliteBase {
  protected override createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_threads (
        thread_id   TEXT PRIMARY KEY,
        chat_type   TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'active',
        created_at  TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_traces (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id   TEXT NOT NULL REFERENCES agent_threads(thread_id),
        message_id  TEXT NOT NULL,
        chat_id     TEXT NOT NULL,
        input_text  TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        created_at  TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `)
  }

  // 确保 thread 存在（没有则创建）
  ensureThread(threadId: string, chatType: string, chatId: string) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_threads (thread_id, chat_type, chat_id)
         VALUES (?, ?, ?)`
      )
      .run(threadId, chatType, chatId)
  }

  // 插入一条消息 trace（pending）
  insertTrace(threadId: string, messageId: string, chatId: string, inputText: string) {
    this.db
      .prepare(
        `INSERT INTO agent_traces (thread_id, message_id, chat_id, input_text)
         VALUES (?, ?, ?, ?)`
      )
      .run(threadId, messageId, chatId, inputText)
  }

  // 取最早一条 pending 的 trace
  getPendingTrace(): AgentTraceRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_traces
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get() as AgentTraceRecord | undefined
    return row ?? null
  }

  // 原子更新状态（仅当当前状态匹配时）
  updateTraceStatus(id: number, fromStatus: string, toStatus: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE agent_traces
         SET status = ?, updated_at = datetime('now', 'localtime')
         WHERE id = ? AND status = ?`
      )
      .run(toStatus, id, fromStatus)
    return result.changes > 0
  }
}
