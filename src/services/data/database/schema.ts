import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core'

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

/** 渠道消息（通用，所有渠道共用；渠道专属字段进 extra JSON） */
export const channelMessages = sqliteTable(
  'channel_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channel: text('channel').notNull(),
    messageId: text('message_id').notNull(),
    chatId: text('chat_id').notNull(),
    chatType: text('chat_type').notNull(),
    threadId: text('thread_id'),
    senderId: text('sender_id'),
    senderName: text('sender_name'),
    text: text('text'),
    /** 渠道专属字段 JSON（如 lark 的 event_type/app_id），仅 debug 用 */
    extra: text('extra'),
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`)
  },
  // 平台事件多为 at-least-once（断线重连会重推）：(channel, message_id) 唯一，dispatch 幂等去重
  t => [uniqueIndex('channel_messages_channel_message_id').on(t.channel, t.messageId)]
)

/** 渠道用户缓存（用户名等展示信息，按 channel + userId 唯一） */
export const channelUsers = sqliteTable(
  'channel_users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channel: text('channel').notNull(),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`)
  },
  t => [uniqueIndex('channel_users_channel_user_id').on(t.channel, t.userId)]
)

export const agentTurns = sqliteTable(
  'agent_turns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    threadId: text('thread_id').notNull(),
    turnNo: integer('turn_no').notNull(),
    hookType: text('hook_type').notNull(),
    node: text('node'),
    toolCallId: text('tool_call_id'),
    toolCalls: text('tool_calls'),
    content: text('content'),
    toolsResult: text('tools_result'),
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`)
  },
  // 每 thread 每轮只允许一条 INPUT（turnNo 并发分配竞态的兜底：重复开轮直接冲突报错）
  t => [
    uniqueIndex('agent_turns_thread_turn_input')
      .on(t.threadId, t.turnNo)
      .where(sql`hook_type = 'INPUT'`)
  ]
)

export const agentThreads = sqliteTable('agent_threads', {
  threadId: text('thread_id').primaryKey(),
  chatType: text('chat_type').notNull(),
  chatId: text('chat_id').notNull(),
  senderId: text('sender_id'),
  /** 绑定的 agent definition id（null = 未识别，worker process 首次消费时路由并标记） */
  agentId: text('agent_id'),
  status: text('status').notNull().default(THREAD_STATUS.ACTIVE),
  createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`)
})

export const agentTraces = sqliteTable(
  'agent_traces',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    threadId: text('thread_id')
      .notNull()
      .references(() => agentThreads.threadId),
    messageId: text('message_id').notNull(),
    chatId: text('chat_id').notNull(),
    /** 来源渠道 id（'lark' | 'telegram'…）：worker 出站回复路由依据 */
    channel: text('channel'),
    inputText: text('input_text').notNull(),
    status: text('status').notNull().default(TRACE_STATUS.PENDING).$type<TraceStatus>(),
    /** 心跳租约时间戳：claim（pending→processing）时写入，处理期间 worker 每 30s 刷新；超 90s 未刷新判死回收 */
    heartbeatAt: text('heartbeat_at'),
    createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`),
    updatedAt: text('updated_at').default(sql`(datetime('now', 'localtime'))`)
  },
  // worker poll 热点查询（每 3s + while 循环内连续调）：WHERE status='pending' ORDER BY created_at
  t => [index('agent_traces_status_created_at').on(t.status, t.createdAt)]
)

export const logger = sqliteTable('logger', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  level: text('level').notNull(),
  message: text('message').notNull(),
  data: text('data'),
  threadId: text('thread_id'),
  createdAt: text('created_at').default(sql`(datetime('now', 'localtime'))`)
})
