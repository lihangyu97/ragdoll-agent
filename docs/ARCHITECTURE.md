# Ragdoll 架构说明

> 状态：2025-08-26，渠道抽象（ChannelAdapter）+ agent 契约中立化重构后整理。
> 本文件是仓库**唯一**的架构文档，由 docs/ 下多份旧文档合并而来（feishu-agent-integration /
> cordis-migration / agent-capability-design / worker-multi-instance / orm-examples / TODO / lark.json
> 均已删除）。编码原则见仓库根 `AGENST.md`。

---

## 1. 项目概况

学习用的 agent 项目（TypeScript）：渠道消息 → SQLite 队列 → agent 执行 → 出站回复。

- **框架**：cordis 4（koishi 同款 DI + 插件框架）
- **agent**：langchain（`createAgent` + SqliteSaver checkpointer）；对外契约框架无关（见 §3.2）
- **存储**：better-sqlite3 + drizzle-orm（表定义唯一来源 `src/services/data/database/schema.ts`）
- **配置**：环境变量 → 各 Service `static Config`（zod）校验，缺配置 → 插件 FAILED

## 2. 四大模块与目录

| 模块                  | 目录                    | 职责                                                                             |
| --------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| **出入站**（channel） | `src/services/channel/` | 渠道编排（`ChannelService`）+ 渠道契约（`types.ts`）+ 适配器（`adapters/lark/`） |
| **调用器**（worker）  | `src/services/worker/`  | 轮询队列、路由归属、执行编排、出站回复                                           |
| **agent**             | `src/services/agent/`   | 能力注册表（`capability/`，数据面）+ 执行（`AgentService`，执行面）              |
| **持久化**（data）    | `src/services/data/`    | `database` + `traces` / `threads` / `turns` / `channels` repository              |

```
                 ┌──────────────────────────────────────────────┐
 larkAdapter ──► │ channel（ChannelService）                     │
                 │  register / dispatch(统一入站管线) / send(路由) │
                 └──────────────┬───────────────────────────────┘
                                │ insertTrace（带 channel）
                                ▼
                 ┌──────────────────────────────────────────────┐
                 │ worker                                        │
                 │  轮询抢锁 → 路由(绑定→规则→identify→default)    │
                 │  → agent.run → 状态流转 → channel.send 出站    │
                 └──────────────┬───────────────────────────────┘
                                │ run/identify + agent/* 事件（框架无关载荷）
                                ▼
                 ┌──────────────────────────────────────────────┐
                 │ agent                                         │
                 │  AgentService（执行面）+ capability（注册表/组装）│
                 └──────────────┬───────────────────────────────┘
                                │ repository 调用
                                ▼
                 ┌──────────────────────────────────────────────┐
                 │ data（database / traces / threads / turns /  │
                 │      channels）                               │
                 └──────────────────────────────────────────────┘
```

## 3. 核心契约

### 3.1 出入站：`ChannelAdapter`（`src/services/channel/types.ts`）

框架无关接口，任何渠道完整实现即可插拔：

```ts
interface ChannelAdapter {
  readonly id: string // 'lark' | 'telegram' | …
  start(): Promise<void> // 建连：WS / 长轮询 / webhook
  stop(): Promise<void>
  send(reply: OutboundReply): Promise<boolean> // 出站（失败返回 false，上层只记日志）
}

interface InboundMessage {
  channel: string // 出站路由依据
  threadId: string // 适配器负责加渠道前缀命名空间（如 'lark:p2p:oc_xxx'），防跨渠道撞 id
  chatId: string
  chatType: string // 'p2p' | 'group'
  messageId: string // 出站回复锚点（reply-to）
  senderId?: string
  senderName?: string
  text: string // 解析后的纯文本
  raw?: unknown // 原始事件（落库进 channel_messages.extra，debug 用）
}
```

- **入站**：adapter 监听平台事件 → 归一化成 `InboundMessage` → `ctx.channel.dispatch(msg)`。
  `dispatch` 是**统一入站管线**：落库 `channel_messages`（`UNIQUE(channel, message_id)` 幂等去重，
  平台 at-least-once 重推的重复事件整体跳过）→ `ensureThread` → `insertTrace`（带 channel）→ 回执（"🤔 正在思考中…"）→ 广播 `message/received`。
- **出站**：worker 完成路径经 `ctx.channel.send({ channel, messageId, text })` 按 `channel` 路由回对应 adapter。
- **装配**：每渠道一个薄插件（`src/plugins/channel-lark.ts` 同构），`register` + `ctx.effect` 管理 start/stop 生命周期；`src/index.ts` / `cordis.yml` 只挂插件（不手写 register，保证生命周期、Config 校验、DI 都走 cordis）。
- **注意**：lark 群聊只有话题线程（`thread_id`）的消息才会处理，非话题群消息无法定位会话，仅记日志忽略。

### 3.2 agent/* 事件：框架无关载荷（`src/services/agent/steps.ts`）

`AgentService` 对外只有 `run(input, threadId, agentId)` 与 `identify(input)` 两个签名（已中立）；langchain 消息在 run 内部转换成中立载荷再发事件，**全仓库只有 `src/services/agent/` 内部 + `src/plugins/weather/`（demo 工具）能 import `@langchain/*`**：

| 事件                | 载荷（统一 payload，身份字段在 `AgentEventBase`） | 订阅方                |
| ------------------- | ------------------------------------------------- | --------------------- |
| `agent/input`       | `{ threadId, turnNo, input }`                     | turn-recorder、output |
| `agent/tool-call`   | `{ threadId, turnNo, node, toolCalls }`           | turn-recorder、output |
| `agent/tool-result` | `{ threadId, turnNo, node, toolCallId, text }`    | turn-recorder、output |
| `agent/result`      | `{ threadId, turnNo, node, text }`                | turn-recorder、output |
| `agent/error`       | `{ threadId, turnNo, error }`                     | turn-recorder、output |
| `agent/timeout`     | `{ threadId, turnNo }`                            | turn-recorder、output |

> 事件载荷全部 payload 化（事件名即判别符，增删字段对订阅方是兼容变更）；`turnNo` 由
> `AgentService.run()` 入口计算一次并随每个事件下发，观测方无需推断轮次，并发/交错线程不丢记录。

### 3.3 数据表（`src/services/data/database/schema.ts`）

| 表                 | 用途             | 备注                                                                                                                                                           |
| ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel_messages` | 渠道消息（通用） | `UNIQUE(channel, message_id)`（dispatch 幂等去重）；渠道专属字段进 `extra` JSON                                                                                |
| `channel_users`    | 渠道用户缓存     | `UNIQUE(channel, user_id)`；lark 的 open_id → 用户名                                                                                                           |
| `agent_threads`    | 会话线程         | `thread_id` PK（带渠道前缀）；`agent_id` = 绑定的 agent definition（一次性定终身）                                                                             |
| `agent_traces`     | 消息队列         | pending → processing → done/failed；`channel` 列是出站路由依据；worker 抢锁 CAS                                                                                |
| `agent_turns`      | 每轮执行轨迹     | turn-recorder 写入（INPUT / TOOL_CALL / TOOL_RESULT / AGENT_RESULT / ERROR / TIMEOUT）；`UNIQUE(thread_id, turn_no) WHERE hook_type='INPUT'`（防并发重复开轮） |
| `logger`           | 日志落库         | `@/utils/logger` 直接写，不经 database Service（写失败不中断业务）                                                                                             |

## 4. 事件协议一览

| 事件                 | 模式        | 用途                                                                   |
| -------------------- | ----------- | ---------------------------------------------------------------------- |
| `agent/*`（六个）    | `emit`      | 执行观测（载荷框架无关，见 §3.2）                                      |
| `message/received`   | `emit`      | channel dispatch 后广播 `{ channel, threadId, text }`，观察/审计用     |
| `trace/status`       | `emit`      | worker 状态流转广播 `{ threadId, status }`                             |
| `agent/resolve`      | `bail`      | 规则层路由：监听器返回 agentId 即命中（确定性规则），未命中走 LLM 识别 |
| `agent/prompt-build` | `waterfall` | 组装期改写 systemPrompt（守卫、插件注入）                              |

## 5. 扩展指南

### 新渠道（如 telegram）

1. `src/services/channel/adapters/telegram/TelegramAdapter.ts`：实现 `ChannelAdapter`（监听 + 归一化入站消息调 `ctx.channel.dispatch` + `send` 出站）
2. `src/plugins/channel-telegram.ts`：与 `channel-lark.ts` 同构（`register` + effect 生命周期）
3. `src/index.ts` / `cordis.yml` 各加装配（两行）

worker / agent / 持久化**零改动**（threadId 记得加 `telegram:` 前缀）。

### 新 agent / 换 agent 框架

- 新增 definition（`registerDefinition`）+ 工具（`registerTool`）+ skill（`registerSkill`）即可，见 §5.3
- 换框架：改动收敛在 `src/services/agent/` 内部（事件载荷已中立）；真换时把 AgentService 内部拆成 backend 适配层即可，worker/观测层无感知
- 注意：tool 契约目前仍是 langchain `ClientTool`（唯一实现，不做投机抽象）；checkpointer（langgraph 记忆）在框架内部

### 新能力（工具 / skill / definition）

全部经 `ctx.capability` 注册（`src/services/agent/capability/CapabilityService.ts`），注册即 `version +1` → agent 运行时失效重建：

- `registerTool(tool)`：领域工具（langchain `ClientTool`）；系统工具（read_file/write_file/…，平台原语）构造时 seed，自动进每个 agent，不可同名注册/注销
- `registerSkill(skill)`：`{ name, description, trigger?, instructions, resources?, tools? }`；默认 `catalog` 懒加载（prompt 只放目录 + 内置 `load_skill(name)` 工具），小技能集可 `full` 全量注入
- `registerDefinition(def)`：`{ id, basePrompt, personas?, skills?, skillMode?, tools? }` 声明式规格，`assemble(def)` 产出 `AgentSpec`（systemPrompt + tools）

## 6. 待办

### P1：knowledge + guardrails + 观测增强

- [ ] `registerKnowledge` + `knowledge_search`（SQLite FTS5，不上向量库）
- [ ] `agent/before-input` waterfall（输入改写/拦截）+ 工具白名单
- [ ] 事件 payload 补 token 用量/耗时；model 配置挪进 AgentDefinition

### P2：渠道插拔验证 + agent backend

- [ ] telegram adapter（实现 ChannelAdapter 验证插拔，同时验证 threadId 前缀约定）
- [ ] 换 agent 框架时拆 backend 适配层（当前泄漏已堵死，改动收敛在 agent 模块）

### 待定

- [ ] **worker 多实例：心跳租约回收**（方案已定未实施）：`agent_traces` 加 `heartbeat_at`，处理期间每 30s 刷新；90s 未更新判死；回收从"仅启动时"升级为周期 sweep（多实例安全）；恢复语义 = 至少一次（工具副作用需幂等）。实施时机：上 pm2 多实例时，与部署一起做。现实现（启动时 + 10min 静态阈值回收）单实例够用。
- [ ] **数据库索引**（数据量上来再加）：`agent_traces(status, created_at)`、`agent_traces(thread_id)`（`agent_turns(thread_id, turn_no)` 已做部分索引：INPUT 唯一）

## 7. 约定与坑

### 约定（AGENST.md 摘要）

- **表结构变更直接清库**（`rm -f data/agent.db*` 后 `pnpm seed`），不写迁移逻辑；drizzle 迁移只重建一次（`pnpm db:generate`）
- **不 commit/push**，除非主动要求

### cordis 坑（已踩）

- **inject 必须声明**：fiber 上下文访问其他 service 必须声明 `static inject` / `inject`，否则抛 `cannot get property without inject`
- **cordis 内置 logger 默认静默**：只缓冲不输出；根上注册 `ctx.logger.exporter`（error/warn → console）才能看到插件 FAILED 原因
- **双连接问题**：`getDb()` 单例（better-sqlite3）与 agent checkpointer（SqliteSaver）各自持有 SQLite 连接（WAL + busy_timeout 已有），cordis 不解决，注意即可
- **事件只在进程内**：不跨进程不持久化；DB 队列才是跨进程/重启恢复的可靠通道，多进程下 worker 轮询依然成立
- **yml 启动**：`pnpm start:yml` 必须用 tsx 跑（loader 的 import 不经 tsx 无法解析 `@/*` 别名）；yml 敏感配置用 `!!js` 标签写环境变量表达式（**是 `!!js` 不是 `!js`**）
- **别过度设计**：保留原生 sqlite（不上 minato / `ctx.model`）、保留 DB 队列；不做投机抽象（单一实现不提前做接口）

## 附录

### lark（飞书）配置

- 环境变量：`LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN`（`feishu` | `lark`），见 `.env.example`
- 应用权限 scopes（开发者后台配置，原 `docs/lark.json`）：
  - tenant：`im:message`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message.group_at_msg.include_bot:readonly`、`im:message:send_as_bot`、`im:chat`、`contact:contact.base:readonly`、`contact:user.base:readonly`、`im:message.reactions:read` / `write_only`、`im:app_feed_card:write`、`cardkit:card:write`、`docx:*`、`wiki:*`、`drive:*`、`search:bot`
  - user：`contact:user.base:readonly`、`contact:user.email:readonly`、`contact:user.employee_id:readonly`、`docx:*`、`drive:*`、`wiki:*`、`search:bot`

### ORM 选型结论

**Drizzle + better-sqlite3**（drizzle-orm 0.45 无 node:sqlite 驱动，better-sqlite3 是官方 SQLite 首选；不上 minato/`ctx.model`）。`drizzle-kit generate` 生成迁移，运行时 `migrate` 应用。
