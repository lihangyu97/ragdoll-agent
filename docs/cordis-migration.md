# 基于 Cordis 框架重构（现状 + 架构说明）

> 状态：**主要迁移已完成**（2025-08-25）。本文档从"迁移方案"转为"迁移现状 + 架构说明 + 可选增强"。
> 原则遵循 AGENST.md：简单优先、外科手术式修改、不写迁移逻辑（表结构变更直接清库）。

---

## 0. 当前进展

`pnpm typecheck` + `pnpm test`（23 用例）全绿；`pnpm dev` 冒烟 + 真实 LLM 链路验证通过（插入 pending trace → worker 消费 done → 工具调用链 → worker 完成路径直调 lark 出站回复 + turn-recorder 写入轮次记录）。

**Services**（各带 `static inject` 声明依赖；实现见 `src/services/*`，数据层在 `src/services/data/`）：

- **数据层**（`src/services/data/`）：**`database`**（better-sqlite3 连接 getDb + 暴露 drizzle 实例，构造时 `migrate` 应用 schema 迁移）、**`traces` / `threads` / `turns` / `channelLark`**（薄 repository，内部查询用 drizzle（同步 builder：`.all()/.get()/.run()`），注入 database；`TRACE_STATUS` / `THREAD_STATUS` 常量与表定义统一在 `database/schema.ts`）
- **`agent`**：懒加载 model/checkpointer/agent，`ctx.agent.run(input, threadId)`，广播五个 `agent/*` 类型化事件；`registerTools()` / `setSystemPrompt()` 作为 tools/prompt 注册点
- **`lark`**：入站生产（落库 channel_lark → ensureThread → insertTrace → 回"正在思考"）+ 出站 `reply()`（REST）；不订阅 `agent/*`（回复由 worker 完成路径直调）
- **`worker`**：周期轮询 `agent_traces`（3s interval，tick 内消费到空，启动立即消费一轮），抢锁 → `ctx.agent.run` → done/failed；仅 `timer` + `processing` 防重入两个状态；崩溃/重启残留兜底已做：**启动时回收超时（>10min，`STALE_PROCESSING_MINUTES`）的无主 processing trace** 重置回 pending（只回收超时的，不误伤其他实例正在跑的，多实例安全）；完成路径直调 `ctx.lark.reply()` 出站回复

**Plugins**（`src/plugins/*`）：`channel`（lark 生命周期）、`worker`（worker 生命周期）、`agent-demo`（注入 toy tools/prompt）、`turn-recorder`（订阅 agent/* 写 agent_turns，以 agent/input 为轮次边界）、`console-demo`（订阅 agent/* 打印，原 toy/loggerHooks）

**事件**：`agent/*` 五个 + 领域层 `message/received`（lark 入队后广播）、`trace/status`（worker 状态流转广播）

**其他**：`insertTrace` 改 `RETURNING id`；根入口装配全部插件；测试改为 cordis Context + Service 模式（`test/{database,traces,threads}.test.ts`）；`logger` 并入 `@/utils/logger` 模块（见 §3）；旧死代码（`src/agent/*`、`src/worker`、`src/channels/lark`、`src/application`、`src/config`、`src/sqlite/*` 各 repository 等）已删除

---

## 1. 背景与目标（迁移前现状）

迁移前仓库是"学习用 agent 项目"：飞书消息 → SQLite 队列 → LangGraph agent 执行 → 回消息，痛点：

- **模块级单例 + import 副作用**：`getDb()` 单例、`defaultBus` 单例、`agent/index.ts` 顶层 `new ChatOpenAI()` / `createAgent()`；config 模块 import 时缺 env 直接 throw 崩进程
- **手写事件总线 `HookBus`**：`track` 注册后没有 unsubscribe
- **Application 手动编排**：手动串 initSchema / worker / lark，无依赖注入、无插件生命周期
- **agent 与演示代码焊死**：顶层硬 import `@/toy/tools`、`@/toy/systemPrompt`

目标：迁移到 cordis（koishi 生态 DI + 插件框架），获得依赖注入、插件生命周期、类型化事件。**以上痛点均已解决。**

---

## 2. Cordis 判定原则（仍适用）

- **Service = 能力**：有稳定 API、被多个模块直接调用、通常全局唯一实现 → `ctx.<key>` + `inject` 声明依赖
- **Plugin = 行为**：消费 Service、订阅事件、有生命周期副作用（定时器、连接、监听器）→ `ctx.plugin()`
- **事件 = 通知/拦截**：广播观察用 `emit`；需要返回值/短路用 `waterfall`/`serial`/`bail`
- **口诀**：_直接能力调用走 Service 方法，拦截和策略走事件_
- 生命周期：`ctx.on()` / `ctx.effect()` 注册即 effect，插件卸载自动撤销

参考：harness 的 [Cordis 入门](https://github.com/deepseek-ai/DeepSeek-Harness/blob/HEAD/docs/cordis-primer.zh.md)、[Services 教程](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/cordis-tutorial/03-services.md)、[Events 教程](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/cordis-tutorial/04-events.md)

---

## 3. Service / Plugin 映射表（最终结果）

| 原模块                                               | cordis 角色                                               | 状态       | 说明                                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `sqlite/base`（db/schema/safe）                      | **`database` Service**（已换 Drizzle）                    | ✅         | better-sqlite3 连接 + drizzle 查询实例；建表走 `drizzle-kit generate` + 运行时 `migrate`（safe 层退役）     |
| `sqlite/agentTraces`                                 | **`traces` Service**                                      | ✅         | 队列能力：enqueue / 抢锁 / 状态流转                                                                         |
| `sqlite/agentThreads` / `agentTurns` / `channelLark` | `threads` / `turns` / `channelLark` Service               | ✅         | 1:1 repository                                                                                              |
| `logger` + `logger/context`                          | 并入 `@/utils/logger` **模块**（非 Service）              | ✅（决策） | cordis 内置 `ctx.logger` 占名；按待决问题"倾向保留自定义"处理，改动最小；`AsyncLocalStorage` 线程上下文保留 |
| `agent/index`                                        | **`agent` Service**                                       | ✅         | `ctx.agent.run`；tools/prompt 插件注入                                                                      |
| `agent/checkpointer`                                 | agent Service 内部依赖                                    | ✅         | 内联 SqliteSaver                                                                                            |
| `agent/hooks`（HookBus）                             | **删除 → cordis 事件系统**                                | ✅         | 文件已删                                                                                                    |
| `agent/turn`（AgentTurn）                            | **`turn-recorder` Plugin**                                | ✅         | 订阅 agent/* 写库                                                                                           |
| `worker`                                             | **`worker` Service + Plugin**                             | ✅         | 轮询循环由插件 effect 包 start/stop；注入 `agent` + `traces` + `lark`（完成路径直调出站回复）               |
| `channels/lark`                                      | **`lark` Service**                                        | ✅         | 入站（WS 收消息）+ 出站（`reply()` REST；回复由 worker 直调，不再订阅 agent/*）                             |
| `channels/lark/message`                              | lark Service 内部纯函数工具                               | ✅         | `src/services/lark/message.ts`                                                                              |
| `toy/tools`、`systemPrompt`                          | **`agent-demo` Plugin**                                   | ✅         | 注册工具/提示词                                                                                             |
| `toy/loggerHooks`                                    | **`console-demo` Plugin**                                 | ✅         | 订阅 agent/* 打印                                                                                           |
| `config/*`（已删，配置内联到各 Service）             | 各 Service `static Config`（zod schema）+ 根入口传 config | ✅         | 配置统一从 env 读入经 cordis Config 校验 → 缺配置插件 FAILED（ValidationError 可见）                        |
| `application` + `index`                              | 根：`new Context()` → `ctx.plugin(...)`                   | ✅         | 信号处理 + uncaught 兜底 + cordis 日志 console exporter 都在根上                                            |

**判据小结**：别人会调用它、实现唯一 → Service（database / traces / threads / turns / lark 出站 / agent 运行）；启动后自己跑、消费别人 → Plugin（worker / turn-recorder / lark 入站 / toy 演示）。`agent` 既是能力（run 被 worker 调）又是事件源（发 agent/* 事件），**Service 发声 + 事件广播**，两者不冲突。

---

## 4. 事件通信设计

命名空间 `domain/action`，type-safe 靠 `interface Events` 声明合并（`src/services/*/type.ts`）。

### agent 层（五个事件，全部 `emit` 广播）

| 事件                | 载荷                          | 订阅方                                                                        |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `agent/input`       | (threadId, input)             | turn-recorder、console demo                                                   |
| `agent/tool-call`   | (threadId, node, AIMessage)   | turn-recorder、console demo                                                   |
| `agent/tool-result` | (threadId, node, ToolMessage) | turn-recorder、console demo                                                   |
| `agent/result`      | (threadId, node, BaseMessage) | turn-recorder、console demo（回复由 worker 完成路径直调 lark 出站，不走事件） |
| `agent/error`       | (threadId, error)             | lark adapter（回错误）                                                        |

agent 服务直接发五种静态类型化事件，node 作为载荷字段（不再动态归类）。

### 领域层

| 事件               | 模式   | 说明                                                                     |
| ------------------ | ------ | ------------------------------------------------------------------------ |
| `message/received` | `emit` | lark 收到消息、解析完、落库入队后广播；将来加 web/console 渠道时同一事件 |
| `trace/status`     | `emit` | worker 状态流转 pending→processing→done/failed，观察/审计用              |

### 回复路径（worker 完成路径直调 lark 出站）

- worker 消费完 trace（done/failed）后，用自己抢到的那条 trace 的 `messageId` **直调 `ctx.lark.reply()`（出站 REST，不需要 WS）**，失败只记日志不中断主流程
- 为多实例/多进程铺路：回复不依赖同进程事件，worker 实例自己就能回消息（出站是 REST，任何配置了 lark client 的进程都能调）；只有入站（WS 收消息）需要单实例
- `agent/result` / `agent/error` 事件仍照发（turn-recorder / console-demo 用），lark **不再订阅**它们
- 通用 `responder`（把 channel/message_id 写进 trace，多渠道可回复）**暂不做**，多渠道出现时再考虑

---

## 5. tools/prompt 插件注入（已落地）

- `agent` Service 暴露 `registerTools()` / `setSystemPrompt()` 注册点，懒构建 + 失效缓存（下次 run 重建）
- `agent-demo` 插件加载即注入 toy 工具/提示词；加工具 = 新插件 + 配一行，不用改 agent 核心

---

## 6. 依赖图（实际）

```
database（构造时建表）
traces / threads / turns / channelLark → inject [database]
agent ←（自持 model/checkpointer；插件注入 tools/prompt）
lark:           inject [channelLark, threads, traces]（入站 WS + 出站 reply()；不订阅 agent/*）
worker:         inject [agent, traces, lark]（轮询队列 + 状态流转 + 完成路径直调 lark 出站回复）
turn-recorder:  inject [turns]（订阅 agent/* 写库）
agent-demo:     inject [agent]（注册工具/提示词）
logger:         @/utils/logger 模块（非 Service，落库走 @/utils/sqlite 的 insertLog/getDb）
```

---

## 7. 遗留与可选增强（按优先级）

**迁移已完成**：阶段零（sqlite/logger 包 Service，logger 例外）→ 阶段一（HookBus → cordis 事件）→ 阶段二（Application 拆插件）→ 阶段三（tools/prompt 插件注入）均于 2025-08-25 落地。

**待办（按优先级）**：

- [x] **P1 补回 uncaught 兜底**：`src/index.ts` 根上保留 `unhandledRejection`（exitCode=1 自然退出）/ `uncaughtException`（exit(1) 立即退出）——兜住 checkpointer 等第三方实例的漏网异常
- [x] **P2 补 worker / turn-recorder 单测**：`test/worker.test.ts`（mock agent Service + 轮询消费 + trace/status 事件，含失败路径）、`test/turn-recorder.test.ts`（事件驱动写库、轮次递增、跨 thread 忽略）
- [x] **P3 config 改 cordis Config**：各 Service 定义 `static Config`（zod schema，如 `apiKey`/`baseUrl`/`appId`/`dbPath`/`domain`），根入口 `src/index.ts` 统一从 env 读入并 `ctx.plugin(Service, config)` 传入 → 缺配置插件 FAILED（ValidationError 列出问题字段）；配套在根上注册 `ctx.logger` console exporter（cordis 4 rc 内置 logger 默认只缓冲不输出，否则插件错误不可见）；`src/config/` 目录已删，配置内联进各 Service 或经 Config 传入
- [ ] **P4 事件订阅方 / 第二渠道**：`trace/status`、`message/received` 目前无订阅方（观察/审计预留）；加 web/console 渠道验证事件协议
- [x] **P5（部分落地）**：回复已改为 worker 完成路径直调 `ctx.lark.reply()`（出站 REST），不再依赖事件订阅（为多实例铺路）；通用 `responder`（多渠道回复）+ 回复失败重试队列仍可后续做
- [ ] **明确不做**：minato / `ctx.model`（保留原生 sqlite）、DB 队列保留、事件不持久化、数据库索引（数据量上来再说，见 TODO.md）

---

## 8. 坑与注意事项（含已踩）

- **inject 必须声明（已踩）**：插件/Service 的 fiber 上下文访问其他 service 必须声明 `inject`，否则 `ctx.xxx` 抛 `cannot get property "xxx" without inject`——Service 类用 `static inject = [...]`，普通插件对象用 `inject: [...]` 字段
- **cordis 4 rc 内置 logger 默认静默（已踩）**：`ctx.logger` 只把消息推进缓冲，不输出 console；插件 FAILED 的错误会被吞掉。根上注册 `ctx.logger.exporter`（error/warn 打到 console）才能看到原因
- **import 时副作用**：已拆（`src/config/` 目录删除，配置内联/Config 化）；缺配置由 cordis Config（zod）校验 → 插件 FAILED（ValidationError 列出字段）且 console 可见
- **双连接问题仍在**：`getDb()` 单例（better-sqlite3）和 agent checkpointer（SqliteSaver）各自持有 SQLite 连接（WAL + busy_timeout 已有），cordis 不解决，文档说明即可
- **事件只在进程内**：cordis 事件不跨进程也不持久化，DB 队列仍是跨进程/重启恢复的可靠通道；不要试图把事件做持久，worker 轮询 DB 在多进程下依然成立
- **测试**：已切换为 `new Context()` + plugin Service 单测，`DB_PATH=:memory:` 照常工作
- **版本**：实际使用 npm 的 **cordis `4.0.0-rc.8`**（koishi 同款），声明合并写在 `declare module 'cordis'`，已验证正常（注意：cordis 4 无 `ctx.start()`，插件加载用 `ctx.plugin()` + fiber dispose 手动收尾）
- **yml 启动**：`pnpm start:yml`（`scripts/start-yml.ts`）经 `@cordisjs/plugin-loader` + `@cordisjs/plugin-include` 读 `cordis.yml` 装配插件树；yml 条目 `name` 指向本地 TS 模块（loader 的 import 不经 tsx 无法解析 `@/*` 别名，故入口脚本必须用 tsx 跑，不能直接用 cordis 自带 bin.js）；敏感配置用 yml 的 `!!js` 标签写环境变量表达式（`!!js process.env.X`，注意 **是 `!!js` 不是 `!js`**——js-yaml 4 里 `!js` 需要 `%TAG` 指令才能解析成自定义 tag）；退出用 `app.loader.entries()` 逆序 dispose 各 entry fiber
- **别过度设计**：保留原生 sqlite（不上 minato / `ctx.model`）、保留 DB 队列、回复路径保持"adapter 订阅回消息"
