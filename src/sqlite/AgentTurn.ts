import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import {
  AIMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"
import { DB_PATH } from "@config/agent"
import { trackHook, Hooks } from "@agent/hooks"

export default class SqliteAgentTurn {
  private readonly db: DatabaseSync
  private turnId: string | null = null
  private threadId: string | null = null

  constructor() {
    mkdirSync(dirname(DB_PATH), { recursive: true })
    this.db = new DatabaseSync(DB_PATH)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        hook_type TEXT NOT NULL,
        node TEXT,
        msg_type TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        content TEXT,
        tools_result TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `)
    this.registerHooks()
  }

  // 开始一轮 turn：调用模型前生成 turnId，之后 hook 收集的动作都归入本轮
  beginTurn(threadId: string) {
    this.threadId = threadId
    this.turnId = randomUUID()
  }

  // 结束本轮 turn，防止后续无关消息误写入
  endTurn() {
    this.turnId = null
    this.threadId = null
  }

  // 写入一行 turn 记录（无活跃 turn 时忽略）
  private record(
    hookType: string,
    node: string | undefined,
    content: string,
    msg?: BaseMessage
  ) {
    if (!this.turnId || !this.threadId) return
    const isToolResult = hookType === Hooks.TOOL_RESULT
    this.db
      .prepare(
        `INSERT INTO agent_turns (thread_id, turn_id, hook_type, node, msg_type, tool_call_id, tool_calls, content, tools_result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.threadId,
        this.turnId,
        hookType,
        node ?? null,
        msg?.type ?? null,
        this.extractToolCallId(msg),
        AIMessage.isInstance(msg) && msg.tool_calls?.length
          ? JSON.stringify(msg.tool_calls)
          : null,
        isToolResult ? null : content || null,
        isToolResult ? content || null : null
      )
  }

  // 提取工具调用 id：ToolMessage 直接取；AIMessage（TOOL_CALL 决策）取全部调用 id（并行时多个，逗号拼接）
  private extractToolCallId(msg?: BaseMessage): string | null {
    if (!msg) return null
    if (ToolMessage.isInstance(msg)) return msg.tool_call_id
    if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
      return msg.tool_calls.map(call => call.id).join(",")
    }
    return null
  }

  // 注册 hook 收集本轮所有输入/决策/结果/回复
  private registerHooks() {
    trackHook(Hooks.INPUT, input => {
      this.record(Hooks.INPUT, undefined, input)
    })
    trackHook(Hooks.TOOL_CALL, (msg, node) => {
      this.record(Hooks.TOOL_CALL, node, msg.text, msg)
    })
    trackHook(Hooks.TOOL_RESULT, (msg, node) => {
      this.record(Hooks.TOOL_RESULT, node, msg.text, msg)
    })
    trackHook(Hooks.AGENT_RESULT, (msg, node) => {
      this.record(Hooks.AGENT_RESULT, node, msg.text, msg)
    })
  }
}
