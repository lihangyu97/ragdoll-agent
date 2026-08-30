# Ragdoll 架构说明

> 状态：2026-08-29，心跳租约 + 队列索引实施、interrupt/resume 设计储备整理。
> 本文件是仓库**唯一**的架构文档，由 docs/ 下多份旧文档合并而来（feishu-agent-integration /
> cordis-migration / agent-capability-design / worker-multi-instance / orm-examples / TODO / lark.json /
> KNOWN-ISSUES / TOOLS 均已删除并入本文）。编码原则见仓库根 `AGENTS.md`。

---

## 1. 项目概况

学习用的 agent 项目（TypeScript）：渠道消息 → SQLite 队列 → agent 执行 → 出站回复。

- **框架**：cordis 4（koishi 同款 DI + 插件框架）
- **agent**：langchain（`createAgent` + SqliteSaver checkpointer，内含 langgraph 1.4）；模型层独立为 provider Service（AgentService 经 `getModel()` 取模型实例）；对外契约框架无关（见 §3.2）
- **存储**：better-sqlite3 + drizzle-orm（表定义唯一来源 `src/services/data/database/schema.ts`）
- **配置**：环境变量 → 各 Service `static Config`（zod）校验，缺配置 → 插件 FAILED

## 2. 四大模块与目录

| 模块                  | 目录                                                           | 职责                                                                                       |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **出入站**（channel） | `src/services/channel/`                                        | 渠道编排（`ChannelService`）+ 渠道契约（`types.ts`）+ 适配器（`adapters/lark/`）           |
| **调用器**（worker）  | `src/services/worker/`                                         | 轮询队列、路由归属、执行编排、出站回复                                                     |
| **agent**             | `src/services/agent/`                                          | 模型层（`provider/`）+ 能力注册表（`capability/`，数据面）+ 执行（`AgentService`，执行面） |
| **持久化**（data）    | `src/services/data/`                                           | `database` + `traces` / `threads` / `turns` / `channels` repository                        |
| **观察面板**（panel） | `panel/` + `src/services/data/panel/` + `src/plugins/panel.ts` | 前端 Vite 子包 + 只读查询 Service + HTTP 服务插件                                          |

**Service / plugin 拆分约定**：`services/**` 是可注入的能力（含数据访问），构造器无副作用、不自启——测试只挂 Service 即可用内存库跑；`plugins/*.ts` 是生命周期接线的唯一位置（Service 的 start/stop、Config 校验、对外部世界的接线如 HTTP/渠道/事件订阅）。原因：cordis 4 rc 的 Service 无自动启动钩子，`app.plugin(Service)` 只实例化不启动，必须有插件层调 start/stop。纯转发的薄插件（如 `plugins/worker.ts`）也保留此结构，换全仓库统一的心智模型。

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
                 │  AgentService（执行面）+ provider（模型层）    │
                 │  + capability（注册表/组装）                   │
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

| 表                 | 用途             | 备注                                                                                                                                                                                                                                            |
| ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel_messages` | 渠道消息（通用） | `UNIQUE(channel, message_id)`（dispatch 幂等去重）；渠道专属字段进 `extra` JSON                                                                                                                                                                 |
| `channel_users`    | 渠道用户缓存     | `UNIQUE(channel, user_id)`；lark 的 open_id → 用户名                                                                                                                                                                                            |
| `agent_threads`    | 会话线程         | `thread_id` PK（带渠道前缀）；`agent_id` = 绑定的 agent definition（一次性定终身）                                                                                                                                                              |
| `agent_traces`     | 消息队列         | pending → processing → done/failed；`channel` 列是出站路由依据；worker 抢锁 CAS（`claimTrace`）+ 心跳租约（`heartbeat_at`：领取写入、30s 续租、90s 未刷新判死、周期 sweep 回收，恢复语义 = 至少一次）；索引 `(status, created_at)`（poll 热点） |
| `agent_turns`      | 每轮执行轨迹     | turn-recorder 写入（INPUT / TOOL_CALL / TOOL_RESULT / AGENT_RESULT / ERROR / TIMEOUT）；`UNIQUE(thread_id, turn_no) WHERE hook_type='INPUT'`（防并发重复开轮，`getMaxTurnNo` 靠 `hook_type='INPUT'` 过滤复用此索引）                            |
| `logger`           | 日志落库         | `@/utils/logger` 直接写，不经 database Service（写失败不中断业务）                                                                                                                                                                              |

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
- 换模型 / 多模型：改动收敛在 `provider/`（模型配置与客户端构造），AgentService 只消费 `getModel()`；需要 per-definition 模型时给 `getModel` 加名字参数即可
- 注意：tool 契约目前仍是 langchain `ClientTool`（唯一实现，不做投机抽象）；checkpointer（langgraph 记忆）在框架内部

### 新能力（工具 / skill / definition）

全部经 `ctx.capability` 注册（`src/services/agent/capability/CapabilityService.ts`），注册即 `version +1` → agent 运行时失效重建：

- `registerTool(tool)`：领域工具（langchain `ClientTool`）；系统工具（read_file/write_file/…，平台原语）构造时 seed，自动进每个 agent，不可同名注册/注销
- `registerSkill(skill)`：`{ name, description, trigger?, instructions, resources?, tools?, license?, compatibility?, metadata?, scripts? }`；默认 `catalog` 懒加载——**目录注册表驱动**（列出全部已注册技能，`def.skills` 不参与过滤，往 `skills/` 丢技能即对所有 catalog agent 可发现）+ 内置 `load_skill(name)` 工具（支持 `resource` 参数按需加载技能文件，渐进披露对齐 agentskills.io 规范）；`full` 模式保持 opt-in（只编译 `def.skills` 声明的技能 instructions），小技能集可用
- **文件技能（agentskills.io 标准格式）**：`skill-loader` 插件启动时扫描 `skillsRoot`（默认 `skills`，`RAGDOLL_SKILLS_ROOT` env）下 `<name>/SKILL.md`（YAML frontmatter + 正文），校验命名/必填后注册进 capability；`references/` `assets/` `scripts/` 下文本文件进 `resources`（scripts 另有 `scripts` 执行索引）；与代码注册同名 → 文件版覆盖。`license`/`compatibility`/`metadata` 为宿主侧字段，存而不渲染（不进 prompt）
- **技能脚本执行（`run_skill_script`）**：`CapabilityService` 开 `enableSkillScripts`（`RAGDOLL_ENABLE_SKILL_SCRIPTS=true`）后注入；仅执行 `skills/<name>/scripts/` 白名单索引内的脚本，解释器白名单（bash/sh、python3、node），`execFile` 无 shell 注入面，cwd 限定技能目录 + 超时 + 输出截断；与 `run_command` 同为演示级护栏，真隔离需 OS 沙箱/容器
- `registerDefinition(def)`：`{ id, basePrompt, personas?, skills?, skillMode?, tools? }` 声明式规格，`assemble(def)` 产出 `AgentSpec`（systemPrompt + tools）

## 6. 待办与设计储备

### P1：knowledge + guardrails + 观测增强

- [ ] `registerKnowledge` + `knowledge_search`（SQLite FTS5，不上向量库）
- [ ] `agent/before-input` waterfall（输入改写/拦截）+ 工具白名单
- [ ] 事件 payload 补 token 用量/耗时；model 配置挪进 AgentDefinition（模型层已抽 provider，此处只剩 definition → 模型名的映射）

### P2：渠道插拔验证 + agent backend

- [ ] telegram adapter（实现 ChannelAdapter 验证插拔，同时验证 threadId 前缀约定）
- [ ] 换 agent 框架时拆 backend 适配层（当前泄漏已堵死，改动收敛在 agent 模块）

### 设计储备：langgraph interrupt / resume（人工审批 / 对话暂停）

> 2026-08-29 调研结论（仓库内 langgraph 1.4.10，`interrupt` / `Command` API 已具备）。
> 触发场景：P1 guardrails 的高危工具审批、对话暂停恢复。**方案已定稿（2026-08-30），未实施**。

**核心机制**：图执行中调用 `interrupt(payload)` 会抛特殊的 `GraphInterrupt`（不是错误），langgraph 捕获后把整张图的执行状态写进 checkpointer 并正常返回——进程此后可直接死掉，状态在 SQLite 里不丢。恢复时对同一 `thread_id` 传 `new Command({ resume: value })`（而非新消息），langgraph 加载 checkpoint 回到挂起节点。

**一个反直觉细节**：恢复时**节点函数从头重放**，重放走到 `interrupt()` 不再抛暂停，而是直接返回 resume 传入的值。推论：interrupt 之前的代码重放会再跑一遍，断点前不能有不可重复的副作用。

**两种用途（勿混淆）**：

1. **人工审批（设计初衷）**：高危工具执行前 interrupt 问人，用户确认后 resume 继续。guardrails 的天然实现路径，无需自建审批协议。
2. **跨进程崩溃恢复**：interrupt/resume **不会自动续跑**——挂起后必须有存活方主动 resume。调度部分仍归心跳租约（sweep 重派），它只提供"状态没丢、可精确续跑"的能力。

**实施方案（2026-08-30 定稿，待实施）**：

**前提——最小触发器**：仓库目前无任何 `interrupt()` 调用，只做基建则挂起分支是死代码。先加 `ask_human` 系统工具（`systemTools.ts`，实现即 `interrupt({ question, options })`，interrupt 返回值 = 用户答复，直接作为工具结果回给模型），作为触发器兼验证载体。将来 guardrails 高危审批换 `HumanInTheLoopMiddleware`（langchain 1.x createAgent 官方支持，内部同机制），基建零改动。`interrupt()` 放工具第一行，无副作用，规避重放问题。

**数据模型**：`agent_threads` 加一列 `suspendPayload`（text，nullable，挂起时写 interrupt payload JSON，恢复/取消时清空，**非空即挂起**）。不动 `status` 列（ACTIVE/INACTIVE 是启用语义，与"运行中挂起"正交）。

**trace 加 `SUSPENDED` 状态**（关键决策，调研稿只说"不标 DONE"是不够的）：保持 processing 会被租约 90s 回收重跑挂起轮；标 done 则用户收不到 question。`suspended` 天然不被 sweep/claim 碰（只认 pending）——挂起是"在等人"，本不该被重派，崩溃恢复语义自洽。

**四处改动落成文件**：

1. run 收尾（`AgentService.run`）：stream 循环结束后 `agent.getState()` 查 tasks 挂起 interrupt（不解析流事件）；返回值 `string | null` 改判别联合 `{ status: 'done' | 'suspended', answer?, question? }`；挂起时写 `suspendPayload` + emit `agent/suspend`（turn-recorder 记 `SUSPEND` hook）+ trace 标 suspended + 回复 question
2. resume 分叉（`WorkerService.process` 开头）：查 `thread.suspendPayload` 非空 → `agent.stream(new Command({ resume: inputText }))`（输入是 Command 非 HumanMessage），事件管线全复用；**跳过路由**（resolveAgentId 的规则层/LLM 识别都不走，挂起前 thread 必已绑定 agent）；完成后清空 suspendPayload、正常 DONE + 回复
3. 观测层：**resume 开新轮**（正常分配新 turnNo、正常 emit agent/input，INPUT 内容前缀 `[resume]`），挂起轮与恢复轮在 `agent_turns` 各自完整，turn-recorder 零改动
4. lark 按钮（用户下一条消息的卡片形态）：SDK 长连接支持 `card.action.trigger`（已核 `RawCardActionEvent`：`operator.open_id` / `action.value` / `context.open_message_id`，**无 thread_id**）

**lark 卡片按钮**：

- `OutboundReply` 加可选 `card` 字段，`send` 发 `msg_type: 'interactive'`；卡片内容取自 suspendPayload 的 `{ question, options }`，无 options 则回纯文本
- 按钮 value 嵌上下文：`{ "resume": "yes", "threadId": "lark:p2p:oc_xxx" }`——点击事件没有 thread_id（群话题拿不到），嵌进 value 免反查
- adapter 注册 `card.action.trigger` → 归一化 InboundMessage：threadId ← 按钮 value；text ← resume 值；senderId ← operator.open_id；合成幂等键 messageId = `card:${open_message_id}:${operator.open_id}`（同一人同一卡连点/WS 重推在 channel_messages 唯一索引处判重）→ 走现有 dispatch 管线
- 点击回执给 toast 即可；"点击后按钮置灰"需留存卡片 message_id 做卡片更新，第一版不做
- 过期点击：旧卡片点击入队后 thread 已无挂起 → worker 识别出按钮 payload 结构（固定 JSON）直接标 done 忽略，不当新任务发给 agent
- 取消场景不专门做：挂起后用户回"算了"，文本直接作为 resume 值进模型自行理解

**实施顺序**：① schema 加 suspendPayload（清库 + `pnpm db:generate`）→ ② TracesService 加 SUSPENDED（不参与 sweep/claim，单测）→ ③ ask_human 工具 + run 挂起检测与返回值改造（测试 interrupt 抛出 / getState 判别）→ ④ worker resume 分叉 + 挂起收尾（集成测试：挂起 → resume → DONE 事件序列）→ ⑤ lark 卡片与按钮 → 回归现有队列/租约测试。

普通回复 markdown 卡片化（改 send 消息类型 + 卡片模板）与本方案无耦合，后续单独做。

## 7. 约定与坑

### 约定（AGENTS.md 摘要）

- **表结构变更直接清库**（`rm -f data/agent.db*` 后 `pnpm seed`），不写迁移逻辑；drizzle 迁移只重建一次（`pnpm db:generate`）
- **不 commit/push**，除非主动要求

### cordis 坑（已踩）

- **inject 必须声明**：fiber 上下文访问其他 service 必须声明 `static inject` / `inject`，否则抛 `cannot get property without inject`
- **cordis 内置 logger 默认静默**：只缓冲不输出；根上注册 `ctx.logger.exporter`（error/warn → console）才能看到插件 FAILED 原因
- **双连接问题**：`getDb()` 单例（better-sqlite3）与 agent checkpointer（SqliteSaver）各自持有 SQLite 连接（WAL + busy_timeout 已有），cordis 不解决，注意即可
- **事件只在进程内**：不跨进程不持久化；DB 队列才是跨进程/重启恢复的可靠通道，多进程下 worker 轮询依然成立
- **yml 启动**：`pnpm start:yml` 必须用 tsx 跑（loader 的 import 不经 tsx 无法解析 `@/*` 别名）；yml 敏感配置用 `!!js` 标签写环境变量表达式（**是 `!!js` 不是 `!js`**）
- **别过度设计**：保留原生 sqlite（不上 minato / `ctx.model`）、保留 DB 队列；不做投机抽象（单一实现不提前做接口）

## 8. 已知问题与风险

> 2026-08-29 全仓库 review 后整理（原 docs/KNOWN-ISSUES.md 并入）。与 §6 待办互补，
> 待办已有的不重复展开，只在相关条目引用。已修复的条目随手标注。

### 8.1 运行模型

- **worker 完全串行（优先级最高）**：`poll()` 用 `processing` 标志 + 循环内 `await process()`，整条队列一次只处理一条，单实例无并发；一条 agent run 最长 5 分钟，期间所有人排队。改进方向：并发度可配置的 worker pool，或按 threadId 分桶并行。抢锁/租约已多实例安全（§3.3），并发化只改 worker 内部。
- **thread 绑定「一次性定终身」且不可逆**：首条消息即永久绑定；LLM 识别失败会**静默绑定 `default` 并永久生效**；无解绑/重绑命令。改进方向：规则层命中才永久绑定；LLM 识别结果可临时生效、N 轮后再落库；提供管理命令。
- **失败即丢，无重试**：failed 只标记 + 回错误消息，无重试计数/重新投递；出站 `channel.send` 失败只记日志，回复永久丢失。注：收尾 CAS 已防"租约重派后重复回复"，但 **DONE 与 reply 之间的崩溃窗口仍在**（状态 done、回复丢失）。改进方向：failed 可重试计数；出站失败重试队列。
- **双连接共用同一个 SQLite 文件**：业务库与 checkpointer 默认都是 `data/agent.db`，两条独立连接，WAL + busy_timeout 只是缓解。根治：checkpointer 指向独立文件，或换共享连接的 checkpointer 实现。

### 8.2 安全（接入真实用户前必须处理）

> 现有护栏（路径前缀校验 / 命令白名单 / 解释器白名单）均为演示级；最终边界 = OS 沙箱/容器（P1 guardrails）。

- **系统工具默认注入所有 agent**：六个原语无法按 definition 裁剪，guardrails 前至少支持 definition 级白/黑名单
- **`safePath` 不解析 symlink**：`resolve()` + 前缀判断不 `realpath`，沙箱内指向外部的符号链接即可越界
- **`run_command` 白名单是前缀匹配**：`ls; rm -rf …` 拼接即绕过；启用时建议仅允许无参数固定命令或 argv 精确匹配（现默认已禁用）
- **`run_skill_script` 的脚本内容随时可改**：白名单锁定路径不是内容；默认关（现默认已关）
- **无用户/群鉴权与限流**：任何渠道用户都能驱动 agent 跑工具，无 allowlist/限流/配额

### 8.3 工程卫生

- ~~`AGENST.md` 拼写错误~~（已改名 `AGENTS.md`）、~~`identify` 死参数 `chatType`~~（已删除）
- **无 CI**：10 个测试文件覆盖不错，但只能本地手动跑；建议最小 CI = `typecheck + lint + test + format:check`
- **依赖 cordis `4.0.0-rc.8` / loader `rc` 版本**：pre-release 框架 API 变动风险，升级时留意 changelog
- **`answer` 取「流里最后一个非工具消息」**：中间节点产出非空文本会覆盖语义上的最终答案；换框架/加子图时要重审

## 附录

### lark（飞书）配置

- 环境变量：`RAGDOLL_LARK_APP_ID` / `RAGDOLL_LARK_APP_SECRET` / `RAGDOLL_LARK_DOMAIN`（`feishu` | `lark`），见 `.env.example`
- 应用权限 scopes（开发者后台配置，原 `docs/lark.json`）：
  - tenant：`im:message`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message.group_at_msg.include_bot:readonly`、`im:message:send_as_bot`、`im:chat`、`contact:contact.base:readonly`、`contact:user.base:readonly`、`im:message.reactions:read` / `write_only`、`im:app_feed_card:write`、`cardkit:card:write`、`docx:*`、`wiki:*`、`drive:*`、`search:bot`
  - user：`contact:user.base:readonly`、`contact:user.email:readonly`、`contact:user.employee_id:readonly`、`docx:*`、`drive:*`、`wiki:*`、`search:bot`

### ORM 选型结论

**Drizzle + better-sqlite3**（drizzle-orm 0.45 无 node:sqlite 驱动，better-sqlite3 是官方 SQLite 首选；不上 minato/`ctx.model`）。`drizzle-kit generate` 生成迁移，运行时 `migrate` 应用。

### 工具链（oxlint / oxfmt）

> 原 docs/TOOLS.md（2026-08-29 实测评估）并入。版本：oxlint 1.80.0、oxfmt 0.65.0。

- **已接入并替代 prettier**：`lint: oxlint`、`lint:fix`、`format: oxfmt --write .`、`format:check`；pre-commit（lint-staged）按类型分工——代码文件 `oxfmt --write` + `oxlint --fix`，json/md/yml 走 `oxfmt --write`。prettier 依赖已移除（`.prettierrc` / `.prettierignore` 保留作回退参考，风格由 `.oxfmtrc.json` 主导，经 `--migrate=prettier` 生成，输出与原 prettier 零差异）
- **oxlint 规则取舍**：默认 correctness 分类零噪音直接启用；`-D perf/suspicious` 报的多为真问题；`pedantic` 偏风格洁癖不开
- **风险提示**：oxfmt 尚在 0.x，格式输出后续版本可能微调（可回退 prettier，风险低）
- **编辑器**：命令行走本仓库 scripts；VSCode 全局 formatter 与 oxfmt 输出一致，如需实时诊断可装 `oxc.oxc-vscode` 扩展
