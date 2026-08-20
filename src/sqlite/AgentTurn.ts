import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { trackHook, Hooks } from "@agent/hooks"
import SqliteBase from "@sqlite/SqliteBase"

export default class SqliteAgentTurn extends SqliteBase {
  private turnNo: number | null = null

  protected override createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        turn_no INTEGER NOT NULL,
        hook_type TEXT NOT NULL,
        node TEXT,
        msg_type TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        content TEXT,
        tools_result TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `)
  }

  // 注册 hook 收集本轮所有输入/决策/结果/回复（基类建表后自动调用）
  protected override init() {
    trackHook(Hooks.INPUT, (threadId, input) => {
      this.record(Hooks.INPUT, threadId, undefined, input)
    })
    trackHook(Hooks.TOOL_CALL, (threadId, msg, node) => {
      this.record(Hooks.TOOL_CALL, threadId, node, msg.text, msg)
    })
    trackHook(Hooks.TOOL_RESULT, (threadId, msg, node) => {
      this.record(Hooks.TOOL_RESULT, threadId, node, msg.text, msg)
    })
    trackHook(Hooks.AGENT_RESULT, (threadId, msg, node) => {
      this.record(Hooks.AGENT_RESULT, threadId, node, msg.text, msg)
    })
  }

  // 开始一轮 turn：查该 thread 当前最大轮次，本轮 +1
  beginTurn(threadId: string) {
    const row = this.db
      .prepare(`SELECT MAX(turn_no) as max_turn FROM agent_turns WHERE thread_id = ?`)
      .get(threadId) as { max_turn: number | null }
    this.turnNo = (row.max_turn ?? 0) + 1
  }

  // 结束本轮 turn，防止后续无关消息误写入
  endTurn() {
    this.turnNo = null
  }

  // 写入一行 turn 记录（无活跃 turn 时忽略）
  private record(
    hookType: string,
    threadId: string,
    node: string | undefined,
    content: string,
    msg?: BaseMessage
  ) {
    if (this.turnNo == null) return
    const isToolResult = hookType === Hooks.TOOL_RESULT
    this.db
      .prepare(
        `INSERT INTO agent_turns (thread_id, turn_no, hook_type, node, msg_type, tool_call_id, tool_calls, content, tools_result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        threadId,
        this.turnNo,
        hookType,
        node ?? null,
        msg?.type ?? null,
        this.extractToolCallId(msg),
        AIMessage.isInstance(msg) && msg.tool_calls?.length ? JSON.stringify(msg.tool_calls) : null,
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
}
