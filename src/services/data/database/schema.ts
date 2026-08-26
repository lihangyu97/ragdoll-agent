import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

/* ===== 状态常量（唯一事实来源，禁止魔法字符串） ===== */

export const TRACE_STATUS = {
  /** 已入队，等待 worker 领取 */
  PENDING: 'pending',
  /** worker 已抢锁，处理中 */
  PROCESSING: 'processing',
  /** 处理成功 */
  DONE: 'done',
  /** 处理失败 */
  FAILED: 'failed'
} as const

export type TraceStatus = (typeof TRACE_STATUS)[keyof typeof TRACE_STATUS]

export const THREAD_STATUS = {
  /** 活跃（当前唯一在用的取值） */
  ACTIVE: 'active',
  /** 停用/上下文已重置（docs 设计预留，暂无代码写入） */
  INACTIVE: 'inactive'
} as const

export type ThreadStatus = (typeof THREAD_STATUS)[keyof typeof THREAD_STATUS]

/* ===== 表定义（唯一事实来源；drizzle-kit generate 生成迁移） ===== */

export const channelLark = sqliteTable('channel_lark', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventType: text('event_type').notNull(),
  appId: text('app_id').notNull(),
  chatId: text('chat_id').notNull(),
  chatType: text('chat_type').notNull(),
  messageId: text('message_id').notNull(),
  messageType: text('message_type').notNull(),
  threadId: text('thread_id'),
  senderOpenId: text('sender_open_id'),
  senderType: text('sender_type').notNull(),
  senderName: text('sender_name'),
  content: text('content'),
  createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`)
})

export const channelLarkUser = sqliteTable('channel_lark_user', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  openId: text('open_id').notNull().unique(),
  name: text('name').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`)
})

export const agentTurns = sqliteTable('agent_turns', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  threadId: text('thread_id').notNull(),
  turnNo: integer('turn_no').notNull(),
  hookType: text('hook_type').notNull(),
  node: text('node'),
  msgType: text('msg_type'),
  toolCallId: text('tool_call_id'),
  toolCalls: text('tool_calls'),
  content: text('content'),
  toolsResult: text('tools_result'),
  createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`)
})

export const agentThreads = sqliteTable('agent_threads', {
  threadId: text('thread_id').primaryKey(),
  chatType: text('chat_type').notNull(),
  chatId: text('chat_id').notNull(),
  senderOpenId: text('sender_open_id'),
  /** 绑定的 agent definition id（null = 未识别，worker process 首次消费时路由并标记） */
  agentId: text('agent_id'),
  status: text('status').notNull().default(THREAD_STATUS.ACTIVE),
  createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`)
})

export const agentTraces = sqliteTable('agent_traces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  threadId: text('thread_id')
    .notNull()
    .references(() => agentThreads.threadId),
  messageId: text('message_id').notNull(),
  chatId: text('chat_id').notNull(),
  inputText: text('input_text').notNull(),
  status: text('status').notNull().default(TRACE_STATUS.PENDING).$type<TraceStatus>(),
  createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`)
})

export const logger = sqliteTable('logger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  level: text('level').notNull(),
  message: text('message').notNull(),
  data: text('data'),
  threadId: text('thread_id'),
  createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`)
})
