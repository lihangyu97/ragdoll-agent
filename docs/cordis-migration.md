# 基于 Cordis 框架重构方案（结论文档）

> 状态：**仅讨论，未写代码**。本文档记录重构分析与结论，供下次会话/本人直接接手继续。
> 原则遵循 AGENST.md：简单优先、外科手术式修改、不写迁移逻辑（表结构变更直接清库）。

---

## 0. 当前进展（2025-08-25 更新）

**全部落地**（`pnpm typecheck` + `pnpm test` 全绿，`pnpm dev` 冒烟 + 真实 LLM 链路验证通过）：

**Services**（各带 `static inject` 声明依赖）：

- **`database`**（`src/services/database/DatabaseService.ts`）：收编 `sqlite/base`（连接 getDb + 建表 initSchema + safe run/get/all + 错误分级 classifySqliteError），构造时建表
- **`traces` / `threads` / `turns` / `channelLark`**（`src/services/{traces,threads,turns,channel-lark}/`）：原 `sqlite/agentTraces` 等 1:1 平移，注入 database；`TRACE_STATUS` / `THREAD_STATUS` 常量随 Service 导出
- **`agent`**（`src/services/agent/AgentService.ts`）：懒加载 model/checkpointer/agent，`ctx.agent.run(input, threadId)`，广播 `agent/input` / `agent/tool-call` / `agent/tool-result` / `agent/result` / `agent/error` 五个类型化事件；`registerTools()` / `setSystemPrompt()` 作为 tools/prompt 注册点
- **`lark`**（`src/services/lark/LarkService.ts`）：入站生产（落库 channel_lark → ensureThread → insertTrace → 回"正在思考"）+ 出站（replyToMessage）；订阅 `agent/result`/`agent/error` 反查 processing trace 回消息
- **`worker`**（`src/services/worker/WorkerService.ts`）：轮询 `agent_traces`（3s），抢锁 → `ctx.agent.run` → done/failed；启动时 `resetStaleProcessingTraces` 兜底残留

**Plugins**：

- `channel`：lark 生命周期（effect 包 start/close）
- `worker`：worker 生命周期（effect 包 start/stop）
- `agent-demo`：注入 toy tools/prompt 到 agent
- `turn-recorder`：订阅 agent/* 写 `agent_turns`（以 agent/input 为轮次边界，worker 串行保证单活跃轮）
- `console-demo`：订阅 agent/* 打印到控制台（原 toy/loggerHooks）

**事件**：`agent/*` 五个 + 领域层 `message/received`（lark 入队后广播）、`trace/status`（worker 状态流转广播）

**其他**：`insertTrace` 改 `RETURNING id`；根入口装配全部插件；测试改为 cordis Context + Service 模式（`test/{database,traces,threads}.test.ts`）；`logger` 按文档待决问题"倾向保留自定义"保持 `@/logger` 模块（落库依赖保留的 `@/sqlite/logger` + `getDb`）；旧死代码（`src/agent/*`、`src/worker`、`src/channels/lark`、`src/application`、`src/toy/demo`、`src/toy/loggerHooks`、`src/sqlite/*` 各 repository）已删除

**已验证**：真实 LLM 链路——插入 pending trace → worker 消费（pending→done）→ 工具调用（getLocation → getWeather+getTemperature）→ `agent/result` 触发 lark 回复 + turn-recorder 写入 7 条轮次记录。

**cordis 坑（已踩）**：插件/Service 的 fiber 上下文访问其他 service 必须先声明 `inject`，否则 `ctx.xxx` 抛 `cannot get property "xxx" without inject`——Service 类用 `static inject = [...]`，普通插件对象用 `inject: [...]` 字段。

**遗留（可选，文档 §7 阶段四）**：

- config 换 Schema 校验、拆 import 副作用（当前 `config/agent.ts` 保留 import 时 throw + `modelConfig`，`config/lark.ts` 同样）
- `trace/status` / `message/received` 目前无订阅方（观察/审计预留）
- 双连接问题（getDb 单例 vs agent checkpointer）仍在，文档 §8 说明

---

## 1. 背景与目标

当前仓库是一个"学习用 agent 项目"：飞书消息 → SQLite 队列 → LangGraph agent 执行 → 回消息。

现状特征（重构要解决的痛点）：

- **模块级单例 + import 副作用**：`getDb()` 单例、`defaultBus` 单例、`agent/index.ts` 顶层 `new ChatOpenAI()` / `createAgent()`；config 模块 import 时缺 env 直接 throw 崩进程
- **手写事件总线 `HookBus`**（`src/agent/hooks.ts`）：`track` 注册后**没有 unsubscribe**，测试靠独立实例隔离
- **Application 手动编排**：`Application.start()` 手动串 initSchema / worker / lark，无依赖注入、无插件生命周期
- **agent 与演示代码焊死**：`agent/index.ts` 顶层 `import _tools from '@/toy/tools'`、`import _systemPrompt from '@/toy/systemPrompt'`

目标：迁移到 cordis（koishi 生态的 DI + 插件框架），获得依赖注入、插件生命周期、类型化事件。

---

## 2. Cordis 判定原则

- **Service = 能力**：有稳定 API、被多个模块直接调用、通常全局唯一实现 → `ctx.<key>` + `inject` 声明依赖
- **Plugin = 行为**：消费 Service、订阅事件、有生命周期副作用（定时器、连接、监听器）→ `ctx.plugin()`
- **事件 = 通知/拦截**：广播观察用 `emit`；需要返回值/短路用 `waterfall`/`serial`/`bail`
- **口诀**：_直接能力调用走 Service 方法，拦截和策略走事件_
- 生命周期：`ctx.on()` / `ctx.effect()` 注册即 effect，插件卸载自动撤销——治当前 HookBus 无 unsubscribe 的隐患
- 参考：harness 的 [Cordis 入门](https://github.com/deepseek-ai/DeepSeek-Harness/blob/HEAD/docs/cordis-primer.zh.md)、[Services 教程](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/cordis-tutorial/03-services.md)、[Events 教程](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/cordis-tutorial/04-events.md)

---

## 3. Service / Plugin 映射表

| 现有模块                                             | cordis 角色                                                                                                 | 理由                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `sqlite/base`（db/schema/safe）                      | **`database` Service**                                                                                      | 单例连接 + 建表 + safe 执行 + 错误分级，所有数据模块的公共能力                                                             |
| `sqlite/agentTraces`                                 | **`traces` Service（队列能力）**                                                                            | enqueue / 抢锁 / 状态流转；lark 生产、worker 消费，两边注入                                                                |
| `sqlite/agentThreads` / `agentTurns` / `channelLark` | 各自 repository Service（`threads` / `turns` / `channelLark`）                                              | 与现有文件 1:1，改动最小，顺带展示 service 粒度                                                                            |
| `logger` + `logger/context`                          | **`logger` Service**（注入 database；或对接 cordis 自带 `ctx.logger` + 自定义持久化 transport，见待决问题） | 能力明确；`AsyncLocalStorage` 线程上下文与 cordis 正交，保留                                                               |
| `agent/index`（model/agent/run）                     | **`agent` Service**                                                                                         | 核心能力 `ctx.agent.run(input, threadId)`；tools/prompt 改为插件注入（见 §5）                                              |
| `agent/checkpointer`                                 | `agent` Service 内部依赖                                                                                    | 不必单独成 service                                                                                                         |
| `agent/hooks`（HookBus）                             | **删除 → cordis 事件系统**                                                                                  | `ctx.on` 自带卸载 + 类型化 Events，见 §4                                                                                   |
| `agent/turn`（AgentTurn）                            | **`turn-recorder` Plugin**                                                                                  | 纯订阅行为：监听 agent/* 事件写库，无人直接调用                                                                            |
| `worker`                                             | **`worker` Plugin**                                                                                         | 后台轮询循环 → `ctx.effect()` 包 timer + poll；disposer 复用现在 `stop()` 的"唤醒 sleep 退出"逻辑；注入 `traces` + `agent` |
| `channels/lark`                                      | **`lark` adapter Plugin，同时 provide `ctx.lark` Service**                                                  | 入站适配（WS 长连、收消息、解析）是行为；出站 API（`replyToMessage` / `sendText` / `getUserName`）是能力                   |
| `channels/lark/message`                              | lark plugin 内部纯函数工具                                                                                  | 无状态解析，不需要 service/plugin 身份                                                                                     |
| `toy/tools`、`systemPrompt`                          | **demo plugins（向 agent 注册工具/提示词）**                                                                | 最大结构收益，见 §5                                                                                                        |
| `toy/loggerHooks`                                    | demo console plugin（订阅 agent/* 打印）                                                                    | 纯订阅行为                                                                                                                 |
| `config/*`                                           | 拆掉 import 副作用 → 根入口校验 + 作为 plugin config 传入                                                   | 缺 env 不再 import 即崩，而是插件 FAILED 状态；可被 Schema 校验                                                            |
| `application` + `index`                              | 根：`new Context()` → `ctx.plugin(...)` → `ctx.start()`；信号处理 + uncaught 兜底留在根上                   | composition root 就是 cordis 的活                                                                                          |

**判据小结**：别人会调用它、实现唯一 → Service（database / traces / threads / turns / lark 出站 / agent 运行）；启动后自己跑、消费别人 → Plugin（worker / turn-recorder / lark 入站 / toy 演示）。`agent` 既是能力（run 被 worker 调）又是事件源（发 agent/* 事件），答案是 **Service 发声 + 事件广播**，两者不冲突。

---

## 4. 事件通信设计

命名空间 `domain/action`，type-safe 靠 `interface Events` 声明合并（替代现有 `HookMap`）。

### agent 层（原 HookBus 五个事件平移，全部 `emit` 广播）

| 事件                | 载荷                          | 订阅方                                |
| ------------------- | ----------------------------- | ------------------------------------- |
| `agent/input`       | (threadId, input)             | turn-recorder、console demo           |
| `agent/tool-call`   | (threadId, node, AIMessage)   | turn-recorder、console demo           |
| `agent/tool-result` | (threadId, node, ToolMessage) | turn-recorder、console demo           |
| `agent/result`      | (threadId, node, BaseMessage) | lark adapter（回消息）、turn-recorder |
| `agent/error`       | (threadId, error)             | lark adapter（回错误）、turn-recorder |

注意：原来 `trigger(node, threadId, msg)` 按消息类型**动态归类**成三种事件的写法要改掉——agent 服务直接发五种**静态类型化**事件，node 作为载荷字段。

### 领域层（新增，把现在的"隐式约定"显式化）

| 事件               | 模式   | 说明                                                                         |
| ------------------ | ------ | ---------------------------------------------------------------------------- |
| `message/received` | `emit` | lark 收到消息、解析完、落库入队后广播；将来加 web/console 渠道时同一事件     |
| `trace/status`     | `emit` | worker 状态流转 pending→processing→done/failed，观察/审计用，避免别人轮询 DB |

### 回复路径（保持事件解耦）

- worker（或 agent service）只发 `agent/result` / `agent/error`，**完全不知道 lark 存在**
- lark adapter 作为订阅方，自己处理"查 processing trace 拿 message_id → 调 `ctx.lark.reply`"
- 现有 `getLatestProcessingTrace` 反查逻辑原样保留
- 更进一步的通用 `responder`（把 channel/message_id 写进 trace，多渠道都能被回复）**暂不做**，多渠道出现时再考虑

---

## 5. 最大结构收益：tools/prompt 从硬编码变成插件注入

- 现状：`agent/index.ts` 顶层硬 import `@/toy/tools`、`@/toy/systemPrompt`——agent 和演示工具焊死
- 目标：`agent` Service 暴露注册点（service 方法或事件），toy 变成注册插件：加载即注入工具/提示词，卸载即撤销（effect 逆操作）
- 收益：加一个工具 = 写一个新插件 + 配一行，不用改 agent 核心文件

---

## 6. 依赖图

```
database ← logger / traces / threads / turns / channelLark
agent ← (llm, checkpointer, 来自插件的 tools/prompt)
lark plugin:    inject [database, traces, threads, channelLark, logger]  → provide lark
worker plugin:  inject [traces, agent]
turn-recorder:  inject [turns]（订阅 agent/*）
toy plugins:    inject [agent]（注册工具/提示词）
```

---

## 7. 迁移顺序（每步可独立验证、可回退）

1. **阶段零（机械平移）**：引入 cordis 依赖，建根 Context，把 sqlite/logger 各层包成 Service，行为零变化
2. **阶段一**：HookBus 换成 cordis 事件（事件名不变，订阅方平移），删 `agent/hooks.ts`
3. **阶段二**：Application 拆成插件（lark adapter / worker / turn-recorder），`ctx.start()/stop()` 接管生命周期
4. **阶段三**：agent Service 开放 tools/prompt 注册，toy 变插件
5. **阶段四（可选）**：config 换 Schema 校验、考虑 `ctx.model`、加第二个渠道验证事件协议

---

## 8. 坑与注意事项

- **import 时副作用必须清**：config import 即 throw、model 顶层 new——都要挪进 Service 懒加载或根装配，否则 cordis 的 PENDING/FAILED 状态机形同虚设
- **双连接问题还在**：`getDb()` 单例和 checkpointer 各自持有 SQLite 连接（WAL + busy_timeout 已有），cordis 不解决；两者收编到 database/agent service 下，文档说明即可
- **事件只在进程内**：cordis 事件不跨进程也不持久化，DB 队列仍是跨进程/重启恢复的可靠通道；**不要试图把事件做持久**，worker 轮询 DB 在多进程下依然成立
- **测试会变简单**：迁移后每个插件用 `new Context()` + mock service 单测，`DB_PATH=:memory:` 照常工作
- **版本**：用 npm 上的 `cordis` 3.x（koishi 同款），声明合并写在 `declare module 'cordis'`（不是 harness 的 `@deepseek-ai/cordis`）
- **别过度设计**：保留原生 sqlite（不上 minato / `ctx.model`）、保留 DB 队列、回复路径保持"adapter 订阅回消息"——这四个"不做"让迁移可控

---

## 9. 下次继续（接手清单）

**已定结论**（直接执行即可）：

- [x] sqlite 各层 + agent 运行 + lark 出站 → Service
- [x] worker 轮询 + turn 记录 + lark 入站 + toy 演示 → Plugin
- [x] HookBus → cordis 类型化事件（agent/* 五个平移 + message/received + trace/status 两个新增）
- [x] DB 队列继续承担跨进程可靠性，事件不持久化

**待决问题**（明天开工前先定）：

- [ ] `logger`：保留自定义 logger service（写 DB + 线程上下文） vs 对接 cordis `ctx.logger` + 自定义 transport？倾向保留自定义，改动最小
- [ ] tools/prompt 注册点：service 方法 vs 事件？倾向 service 方法（`agent.addTools`），类型更直接
- [ ] 是否引入 plugin config Schema 校验（阶段四再议）
- [ ] 阶段零从哪个模块起手？倾向 database → logger → traces 顺序，每步 typecheck + 现有测试保底
- [ ] 确认 cordis 3.x 在 pnpm 下的安装与 `declare module 'cordis'` 声明合并正常

**开工前验证**：`pnpm typecheck` + `pnpm test` 全绿，再动阶段零。
