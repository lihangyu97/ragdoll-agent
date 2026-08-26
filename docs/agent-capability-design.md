# Agent 能力模型与注入 Service 设计方案

> 状态：**P0 已落地**（2025-08-26，评审通过；P0 实施完成，P1/P2 待做）。
> 评审结论：独立 `capability` Service；skills 默认 `catalog` 懒加载（`full` 作为可选项保留在 AgentDefinition 里）；P0 只做注册表+组装+skills；多 agent 推迟到 P2。
> 背景：当前 agent 无 skills 能力；tools / systemPrompt 是 demo 时当玩具传入的（`src/toy/*` + `agent-demo` 插件启动装配）。
> 目标：定义"一个 agent 由什么能力组成"，并设计一个 Service 把 skills / tools / systemPrompt / 知识等**注入** agent 运行时。
> 遵循 AGENST.md：简单优先、不投机实现、先评审再动手。

---

## 0. 结论速览（TL;DR）

- **能力清单**：除 skills / tools 外，一个可用的 agent 还需要 8 类能力——Prompt 体系、知识（RAG）、记忆、模型管理、守卫（guardrails）、观测、渠道抽象、运行时策略。
- **注入机制**：新增 **`capability` Service（注册表 + 组装器）**：`registerSkill / registerTool / registerPrompt / registerKnowledge / assemble(def)`。
  - 注册 = 具名能力进注册表（全局、与来源无关）；
  - 组装 = 按 **AgentDefinition**（声明式规格）把能力拼成 **AgentSpec 快照**（systemPrompt + tools + …），经 cordis `waterfall` 事件可改写；
  - 执行 = 现有 `agent` Service 消费快照懒构建 langchain agent，注册表版本号变更即失效重建。
- **Skills 加载策略**：默认**目录注入 + 懒加载**（prompt 只放 `name+description` 目录，内置 `load_skill(name)` 工具按需取全文），小技能集可配置全量注入。
- **分期**：P0 注册表 + 组装 + skills（含 toy 迁移）；P1 知识 + 守卫 + 观测；P2 多 agent 路由 + 渠道抽象 + per-agent 策略。

---

## 1. 现状与问题（来自代码）

| 现状                                                                                                    | 问题                                                                   |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `AgentService` 单例：一个 `ChatOpenAI` + 一个 `systemPrompt` 字符串 + 一个 `tools: ClientTool[]`        | 能力全局唯一一份，无法按 agent / 场景差异化；skills 无概念             |
| 注册点只有 `registerTools(tools)` / `setSystemPrompt(prompt)`，改动即 `agent = undefined` 下次 run 重建 | 逐对象失效，无版本概念；只支持"替换全局"，不支持具名增删               |
| tools / prompt 来自 `src/toy/*`，由 `agent-demo` 插件启动时一次性注入                                   | 来源只有"代码硬注册"；无 skill 元数据、无触发条件、无按需加载          |
| systemPrompt 是单段字符串                                                                               | 无法分层组装（身份/角色/技能/约束），无法在组装期被插件拦截改写        |
| 无知识库 / 长期记忆 / 守卫 / 模型路由 / per-agent 策略                                                  | 能力面缺失（详见 §2）                                                  |
| worker 完成路径直调 `ctx.lark.reply()`                                                                  | 渠道耦合，web/console 等新渠道要改 worker（TODO 已记"responder 待做"） |

**核心问题**：`agent` Service 把"能力是什么"（数据）和"能力怎么跑"（执行）焊在了一起，且数据面只有一个全局槽位。

---

## 2. 能力清单：一个 Agent 由什么组成

> 优先级：P0 = 本次重构必做；P1 = 紧随其后；P2 = 有明确需求再做。

### 2.1 Prompt 体系（P0）

systemPrompt 不是一段字符串，而是**可分层、可扩展的组装产物**：

```
[身份]  你是谁、跑在什么平台、默认语言、输出风格基调
[角色]  persona：特定岗位/语气（可选，可多段）
[技能]  技能目录（name+description+trigger，懒加载时只到这一层）
[约束]  输出格式、工具使用规则（如"可并行调用""失败要如实告知"）
[记忆]  会话摘要/长期事实（P1+，见 2.5）
[知识]  挂载知识源说明（P1+，见 2.4）
```

- 组装管线 = cordis `waterfall` 事件（`agent/prompt-build`），插件可在组装期追加/改写——呼应 TODO 里"waterfall 构建 systemprompt"的预想。
- 工具 schema 由 langchain `createAgent` 自动并入 prompt，不在本层手拼。

### 2.2 Skills（指令包）（P0）

- **定义**：`name + description + trigger(触发词/场景) + instructions(正文) + resources(可选数据文件) + tools(可选，约定使用的全局工具名)`。本质是"可复用的任务指令集"，与来源无关。
- **加载策略**（两种，按 agent 配置选）：
  - `catalog`（推荐，默认）：prompt 只注入技能**目录**，内置 `load_skill(name)` 工具按需取全文 → 技能可上百个而 prompt 不膨胀（与 DSH harness 的 skill 机制同款）。
  - `full`：小技能集（≤3 个）直接把 instructions 编译进 systemPrompt，省一次工具调用。
- **工具归属**：P0 不引入"skill 自带工具"，skill 只**引用**全局注册的工具名（指令里约束"用什么工具"）。langchain agent 的工具集构建时固定，运行时动态增减需要重建 agent，P0 不做（见 §7）。

### 2.3 Tools（可执行能力）（P0 增强）

- 现有 `registerTools` 升级为具名注册：`registerTool(name, tool, meta?)` / `unregisterTool(name)`。
- meta 可选：分组/命名空间、权限级别、是否危险、超时。命名唯一性注册时校验。
- 工具发现：`load_skill` 之外，可提供 `list_tools` 类工具（P1，按需）。

### 2.4 Knowledge 知识库 / RAG（P1）

- `registerKnowledge(kb)` 注册知识源（文档/FAQ/代码片段），agent 定义里挂载。
- 检索工具 `knowledge_search(query)`；起步用 SQLite **FTS5 全文检索**（现成存储、零新依赖），数据量/语义检索需求出现后再上 embedding 向量。

### 2.5 Memory 记忆（P1，分两层）

- **短期（已有）**：langgraph checkpointer 按 thread 持久化多轮上下文——保留不动。
- **长期（缺）**：跨会话事实/偏好/摘要。可选：`memory` 表 + 每次 run 注入记忆摘要，或 `memory_get/set` 工具。先不做引擎，按真实需求决定（P2 候选）。

### 2.6 Model 管理（P1）

- 当前单 `ChatOpenAI` 实例写死在 AgentService。能力化：模型注册表（provider/model/temperature/baseUrl），AgentDefinition 里指定；为"按 agent 换模型、后续 fallback/路由"铺路。P0 至少把 model 参数挪进 AgentDefinition（默认值不变）。

### 2.7 Guardrails 守卫 / 安全策略（P1）

- 输入过滤（prompt 注入检测）、输出过滤（敏感信息）、工具调用白名单/审批。
- 实现方式 = **cordis 事件策略点**（呼应 cordis-migration.md 判据"拦截和策略走事件"）：
  - `agent/before-input`（`waterfall`：可改写/拦截输入）；
  - `agent/before-output`（可选）；
  - 工具层白名单在注册 meta 上做。

### 2.8 观测（P0 保持 + P1 增强）

- 已有：`agent/*` 五个事件 + turn-recorder / console-demo / traces。
- 增强：token 用量、耗时、错误分类进事件 payload（langchain 的 usage metadata 有）；多 agent 后事件 payload 带 `agentId`。

### 2.9 渠道抽象（P2）

- worker 直调 `lark.reply()` 改为通用 `responder`：trace 记录 `channel + messageId`，完成路径按 trace 查 responder 回消息。新渠道（web/console）不碰 worker。与能力注入正交，但多 agent 落地前建议一起做。

### 2.10 运行时策略（P2）

- 全局 `AGENT_RUN_TIMEOUT_MS`（5min）→ AgentDefinition 可配：超时、重试、并发限制、token 预算/限流。

---

## 3. 核心设计：`capability` Service（注入机制）

### 3.1 职责拆分（两个 Service，一个数据面一个执行面）

```
capability Service（新增，数据面）          agent Service（改造，执行面）
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ registries:                  │          │ model 实例 / checkpointer     │
│   prompts / tools / skills / │  assemble │ buildRuntime(spec) → agent   │
│   knowledge / definitions    │ ────────→ │ （懒构建 + 版本失效缓存）      │
│ assemble(defId) → AgentSpec  │           │ run(input, threadId, agentId?)│
│ version（每次注册 +1）        │           │ agent/* 事件（payload 带 id）  │
└──────────────────────────────┘          └──────────────────────────────┘
```

- **为什么独立成 Service**：注册表是"被大量插件调用的全局能力"，执行器未来可以多实例（多 agent）；数据面与执行面解耦后，插件只注入 `capability`，不碰运行细节，测试也更简单（组装结果可单测断言）。
- 若想最小改动，也可 P0 先并入 `agent` Service（保留 `ctx.agent.registerSkill(...)` 形态），架构图不变，只是入口合并——实现时二选一，**推荐独立 Service**。

### 3.2 注册 API（注入面）

```
ctx.capabilities
  .registerPrompt(name, prompt)              // 具名 prompt 段（身份/角色/约束…）
  .registerTool(name, tool, meta?)           // langchain ClientTool + 可选 meta
  .registerSkill(skill)                      // { name, description, trigger?, instructions, resources?, tools? }
  .registerKnowledge(kb)                     // 知识源
  .registerDefinition(def)                   // AgentDefinition（见 3.3）
  .unregister*(name)
  .assemble(defId | def): AgentSpec         // 组装快照（带缓存）
```

- 注册即"能力进库"，**不立即重建任何运行时**；`version` +1。
- 来源抽象：P0 只有代码注册；skill / tool 都是纯数据对象，API 形态天然兼容后续"文件目录扫描（SKILL.md 约定）"与"DB 存储"，不提前实现。

### 3.3 AgentDefinition（声明式规格，组装输入）

```ts
interface AgentDefinition {
  id: string
  basePrompt: string          // 身份（必填）
  personas?: string[]         // 角色/风格（引用 registerPrompt 的段名）
  skills?: string[]           // skill id 引用
  skillMode?: 'catalog' | 'full'   // 默认 catalog（懒加载）
  tools?: string[]            // 工具名引用（直接挂，不走 skill）
  knowledge?: string[]        // 知识源（P1）
  model?: ModelSpec           // 覆盖默认模型（P1 生效，P0 占位）
  guardrails?: {...}          // P1
  timeoutMs?: number          // P2
}
```

- 默认定义：`{ id: 'default', basePrompt: '你是 ragdoll agent…', skillMode: 'catalog' }`——不配定义也能跑，保持现有行为。

### 3.4 组装管线（assemble）

```
assemble(def) →
  1. basePrompt（身份）
  2. persona 段拼接（按声明顺序）
  3. 技能目录（skillMode='catalog'：name+description+trigger 列表；'full'：instructions 全文）
  4. 约束段（输出格式/工具使用规则）
  5. P1+：记忆摘要、知识源说明
  → 经 'agent/prompt-build' waterfall 事件（插件可追加/改写）
  → 产出 AgentSpec { systemPrompt, tools, knowledge, guardrails, timeoutMs }
```

- `catalog` 模式下自动注册内置工具 `load_skill(name)`（返回 instructions + resources 文本）。
- 工具收集 = def.tools 直挂 + 各 skill 声明的 tools（去重、校验存在性）。

### 3.5 缓存与失效（版本号，替代逐对象置空）

- `capability` 维护单调 `version`；`agent` 的每个 runtime 记住构建时的 `version`。
- `ensureAgent()` 时 `version` 变了 → 重建（沿用现有"懒构建"模式，只是失效粒度从"改一个工具"变成"注册表版本"——更简单且无遗漏）。
- 多 agent 时：`Map<defId, { version, runtime }>`。

### 3.6 多 Agent 与路由（P2）

- `agent` 持有多个 runtime；`run(input, threadId, agentId = 'default')`。
- thread → agent 绑定：`agent_threads` 表加 `agent_id` 列（或路由规则），worker 领 trace 时带上。事件 payload 增加 `agentId`（默认 agent 行为不变）。

### 3.7 事件 / 策略点一览

| 事件                  | 模式        | 用途                                      |
| --------------------- | ----------- | ----------------------------------------- |
| `agent/prompt-build`  | `waterfall` | 组装期改写 systemPrompt（守卫、插件注入） |
| `agent/before-input`  | `waterfall` | 输入改写/拦截（P1 guardrails）            |
| `agent/skill-load`    | `emit`      | 技能懒加载观测                            |
| `agent/*`（现有五个） | `emit`      | 不变；P2 起 payload 带 agentId            |

---

## 4. 与现有代码的映射

| 现状                                                                    | 改后                                                                                         |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `AgentService.registerTools / setSystemPrompt`                          | 删除 → `capability` 注册 API                                                                 |
| `AgentService.ensureAgent()` 用 `this.tools/this.systemPrompt`          | 改为 `capabilities.assemble(defaultDef)` 拿 AgentSpec 构建                                   |
| `agent-demo` 插件 `ctx.agent.registerTools(_tools)` + `setSystemPrompt` | 改为注册一个 weather **skill** + 三个工具（保持"加能力 = 新插件/新注册行，不改 agent 核心"） |
| `src/toy/*`                                                             | 迁移成 skill 形态（P0 的验收样例），toy 目录可退役                                           |
| `worker / lark / turn-recorder`                                         | 基本不动（`run` 签名不变；P2 加 agentId）                                                    |
| `src/index.ts`                                                          | 多挂 `capability` Service + 默认定义装配                                                     |

---

## 5. 分期实施与验证

### P0：注册表 + 组装 + skills（一次重构）✅（2025-08-26）

- [x] `capability` Service：prompt/tool/skill/definition 四个 register/unregister + `version` + `assemble(def)`
- [x] AgentDefinition + 组装管线（basePrompt → persona → 技能目录/全文；组装期 `agent/prompt-build` waterfall 改写点）
- [x] `catalog` 模式 + `load_skill(name)` 工具（懒加载，未知技能返回可恢复提示）
- [x] toy weather 迁移成 skill（`src/toy/weather-skill.ts`），`agent-demo` 改用新 API，`toy/systemPrompt.ts` 退役
- [x] 验证：`pnpm typecheck` + 38 用例全绿（含 assemble 产物断言、catalog/full 两模式、load_skill 全文、重复注册/缺失引用抛错、version 递增、waterfall 改写点）；真实链路待跑

### P1：知识 + 守卫 + 观测

- [ ] `registerKnowledge` + `knowledge_search`（SQLite FTS5）
- [ ] `agent/before-input` waterfall（输入改写/拦截）+ 工具白名单
- [ ] 事件 payload 补 token 用量/耗时；model 配置挪进 AgentDefinition

### P2：多 agent + 渠道 + 策略

- [ ] 多 AgentDefinition + `agent_id` 路由（threads 表加列）
- [ ] `responder` 渠道抽象（worker 不再直调 lark）
- [ ] per-agent 超时/预算/限流

---

## 6. 明确不做（防过度设计）

- **skill 自带工具 / 运行时动态增删工具**：langchain 工具集构建时固定，动态化要"保存状态 → 重建 agent → 恢复"，复杂度高收益低；P0 用"全量注册 + skill 指令约束"，观察真实需要再说。
- **向量库 / embedding**：FTS5 够用就够用。
- **长期记忆引擎**：先有真实场景再设计。
- **技能市场 / 远端下载 / 目录扫描**：P0 只做代码注册，API 形态预留。
- **DB 迁移逻辑**（AGENST 约定）：加列等直接清库，不写迁移。

---

## 7. 风险与决策点

### 风险

1. **`load_skill` 延迟生效**：模型本轮调 `load_skill` 拿到全文，下一轮才能按指令行动——接受（DSH harness 同理），在 skill 文档里写明。
2. **工具 schema 的 token 成本**：`catalog` 只省了 prompt 侧的技能正文；工具 schema 仍全量进 prompt（langchain 限制）。工具量大时再考虑动态工具（§6 已划为不做）。
3. **命名冲突**：注册时校验 name 唯一，冲突即抛错。
4. **多 agent 事件兼容**：payload 加 agentId 是向后兼容的（订阅方忽略即可）。

### 决策点（2025-08-26 已确认）

1. **Skills 加载策略**：✅ 默认 `catalog`（懒加载）；AgentDefinition 保留 `skillMode` 字段，小技能集可配 `full`。
2. **Service 形态**：✅ 独立 `capability` Service（注册表 + 组装），`agent` Service 消费快照执行。
3. **P0 边界**：✅ 只做注册表 + 组装 + skills；knowledge / guardrails 留 P1。
4. **多 agent**：✅ P2 再做；P0 `run()` 签名不变，不预留 agentId。
5. **技能来源**：✅ P0 只做代码注册；目录扫描（SKILL.md）等真实需要时再上。
