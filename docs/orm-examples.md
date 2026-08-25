# ORM 选型示例：Drizzle vs minato

> 用项目里最有代表性的 `agent_traces` 表（入队 → 取最早 pending → CAS 抢锁 → 标记状态）做同一段逻辑的两种写法。
> 示例代码未在本仓库安装运行，API 以官方文档为准（[Drizzle SQLite](https://orm.drizzle.team/docs/sqlite/get-started-sqlite)、[minato](https://koishi.chat/en-US/guide/database/model.html)）。
> **已定（2025-08）**：选用 Drizzle + better-sqlite3（drizzle-orm 0.45 无 node:sqlite 驱动，better-sqlite3 是官方 SQLite 首选）。

## Drizzle（TS 代码定义 schema，SQL 风格查询，better-sqlite3 驱动）

```ts
// schema.ts —— 表定义（TS 代码，无 DSL）
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const agentTraces = sqliteTable('agent_traces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  threadId: text('thread_id').notNull(),
  messageId: text('message_id').notNull(),
  chatId: text('chat_id').notNull(),
  inputText: text('input_text').notNull(),
  status: text('status').notNull().$type<'pending' | 'processing' | 'done' | 'failed'>(),
  createdAt: text('created_at')
})

// db.ts —— 连接（better-sqlite3；drizzle-orm 0.45 不支持 node:sqlite）
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

export const db = drizzle(new Database('data/agent.db'))
```

```ts
// 使用示例
import { eq, and, asc } from 'drizzle-orm'
import { agentTraces } from './schema'
import { db } from './db'

// 1. 入队（返回自增 id）
const [trace] = await db
  .insert(agentTraces)
  .values({ threadId, messageId, chatId, inputText, status: 'pending' })
  .returning({ id: agentTraces.id })

// 2. 取最早一条 pending
const pending = await db
  .select()
  .from(agentTraces)
  .where(eq(agentTraces.status, 'pending'))
  .orderBy(asc(agentTraces.createdAt))
  .limit(1)

// 3. CAS 抢锁：pending → processing（where 同时匹配 id + 旧状态）
const locked = await db
  .update(agentTraces)
  .set({ status: 'processing' })
  .where(and(eq(agentTraces.id, trace.id), eq(agentTraces.status, 'pending')))

// 4. 标记 done
await db.update(agentTraces).set({ status: 'done' }).where(eq(agentTraces.id, trace.id))
```

## minato（koishi/cordis 生态，`ctx.model` 声明 + `ctx.database` 统一查询）

```ts
// 类型声明（declare module 'minato' 合并 Tables）
declare module 'minato' {
  interface Tables {
    agentTraces: AgentTrace
  }
}

interface AgentTrace {
  id: number
  threadId: string
  messageId: string
  chatId: string
  inputText: string
  status: 'pending' | 'processing' | 'done' | 'failed'
}
```

```ts
// 表结构声明（koishi 里随 database 插件执行；cordis 接入需自行装配 minato + sqlite driver）
ctx.model.extend('agent_traces', {
  id: { type: 'unsigned', primary: true, autoInc: true },
  thread_id: 'string',
  message_id: 'string',
  chat_id: 'string',
  input_text: 'string',
  status: 'string'
})
```

```ts
// 使用示例（ctx.database 统一入口，条件即查询对象）
// 1. 入队（create 返回完整记录，含自增 id）
const trace = await ctx.database.create('agent_traces', {
  thread_id: threadId,
  message_id: messageId,
  chat_id: chatId,
  input_text: inputText,
  status: 'pending'
})

// 2. 取最早一条 pending（$limit 顶层操作符）
const [pending] = await ctx.database.get('agent_traces', {
  status: 'pending',
  $limit: 1
})

// 3. CAS 抢锁：set 按条件更新（id + 旧状态同时匹配）
const locked = await ctx.database.set(
  'agent_traces',
  { id: trace.id, status: 'pending' },
  { status: 'processing' }
)

// 4. 标记 done
await ctx.database.set('agent_traces', { id: trace.id }, { status: 'done' })
```

## 直观区别

|           | Drizzle                                                         | minato                                                       |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| 表定义    | TS 代码 `sqliteTable`（列名可蛇形/驼峰自由映射）                | `ctx.model.extend` + Tables 类型声明                         |
| 查询风格  | 链式 SQL 直觉（`.where(eq(...))`），字段用 TS 引用              | 查询对象（`{ status: 'pending', $limit: 1 }`），字段用字符串 |
| 连接      | better-sqlite3（同步 API；drizzle 官方 SQLite 首选）            | better-sqlite3（原生编译）                                   |
| 与 cordis | 无直接集成，普通依赖                                            | 生态原生（`ctx.database`、`ctx.model`、迁移插件）            |
| 迁移      | drizzle-kit（node:sqlite 需配 libsql/better-sqlite3）或手写 SQL | 生态迁移机制                                                 |

> 注意：两段示例是"同一逻辑两种写法"的对照。minato 的 `create` 返回完整记录（含 id），Drizzle 需要显式 `.returning()`；minato 的 `set` 天然是条件更新（CAS），Drizzle 的 CAS 靠 `where(and(...))`。
