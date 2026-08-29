# ragdoll-agent

学习用的 agent 项目（TypeScript）：接入飞书等渠道，把消息变成 agent 任务——**渠道消息 → SQLite 队列 → agent 执行 → 出站回复**，并自带一个观察面板可视化队列/会话/轨迹/日志。

## 核心链路

```
飞书消息 ──► channel 入站管线（幂等去重 / 建会话 / 入队 / 回执）
              │
              ▼
         SQLite 队列（agent_traces，心跳租约保证卡死自愈、多实例安全）
              │
              ▼
         worker 轮询抢锁 ──► 路由归属（绑定 → 规则 → LLM 识别 → default）
              │
              ▼
         agent 执行（langchain + 会话记忆 checkpointer，能力 = systemPrompt + 工具 + 技能）
              │
              ▼
         按来源渠道路由出站回复
```

### 关键函数与状态流转

```
┌────────────┐ lark 事件   ┌─────────────────────────────────────────────┐
│ LarkAdapter│ ──────────► │ ChannelService.dispatch()   入站管线         │
│ (WS 长连接) │             │  1. insertMessage()                          │
└────────────┘             │     UNIQUE(channel,message_id) 撞车 = 重复   │
                           │     事件，整条跳过（幂等）                    │
                           │  2. ensureThread()  建/查会话                │
                           │  3. insertTrace()   入队，状态 = pending     │
                           │  4. send()          回执「正在思考中…」       │
                           │  5. emit message/received                    │
                           └──────────────────┬──────────────────────────┘
                                              ▼
         ┌─────────────────────────────────────────────────────────────┐
         │                agent_traces 队列（trace 状态机）              │
         │                                                              │
         │  pending ──claimTrace()──► processing ──┬──CAS──► done       │
         │    ▲        抢锁 + 领租约               └──CAS──► failed     │
         │    │                                                  ▲     │
         │    └── sweep()：heartbeat_at 超 90s 未刷新判死，重置 ──┘     │
         │         （processing 期间 worker 每 30s heartbeat() 续租）    │
         └──────────────────────────────┬──────────────────────────────┘
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ WorkerService（3s 轮询，单实例串行）                                    │
│   poll() ─► maybeSweep() ─► getPendingTrace() ─► claimTrace()         │
│                                                             │        │
│   process(trace):                                           ▼        │
│     resolveAgentId()   getAgentId() 已绑定？                          │
│                          └ 否 ► bail agent/resolve 规则层             │
│                                └ 未命中 ► identify() LLM 识别         │
│                                     └ 失败/不存在 ► 'default'          │
│     agent.run()        （见下）                                       │
│     updateTraceStatus()  PROCESSING→DONE / FAILED（CAS）              │
│           │ CAS 成功才回复；失败 = 租约已被重派，放弃结果               │
│           ▼                                                           │
│     replyIfNeeded() ─► ChannelService.send() ─► adapter.send() 出站   │
└──────────────────────────────┬───────────────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ AgentService.run(input, threadId, agentId)                            │
│   nextTurnNo()  分配轮次号（随 agent/* 事件下发）                      │
│   ensureAgent()  capability.assemble() 产出 AgentSpec                 │
│                  （systemPrompt + tools；注册表 version 变更才重建）    │
│   agent.stream()  langgraph 图内循环：                                 │
│      agent 节点(调 LLM) ⇄ tools 节点(执行工具) …直到不再调工具          │
│      每个 node 更新 ─► emit agent/input /tool-call /tool-result        │
│                        /result（turn-recorder 落库 agent_turns）       │
│   最后一个非工具 AIMessage = answer，返回给 worker                      │
└──────────────────────────────────────────────────────────────────────┘
```

## 模块

| 模块    | 目录                    | 职责                                                       |
| ------- | ----------------------- | ---------------------------------------------------------- |
| channel | `src/services/channel/` | 渠道编排 + 契约（`ChannelAdapter` 接口）+ 飞书适配器       |
| worker  | `src/services/worker/`  | 轮询队列、路由归属、执行编排、出站回复                     |
| agent   | `src/services/agent/`   | 模型层（provider）+ 能力注册表（capability）+ 执行（loop） |
| data    | `src/services/data/`    | SQLite（drizzle-orm）：队列 / 会话 / 轨迹 / 渠道消息       |
| panel   | `src/plugins/panel.ts`  | 观察面板：`/api` 只读查询 + 前端静态托管（端口 3111）      |

子 agent 放在 `src/agents/<name>/`：只通过 `ctx.capability` 注册工具 / skill / definition，不改核心代码（现有 weather demo）。`src/plugins/` 则是与具体 agent 无关的基础设施插件。

插件化装配基于 cordis 4（koishi 同款 DI 框架），见 `cordis.yml`；技能系统对齐 agentskills.io 规范，往 `skills/` 丢目录即可被所有 agent 发现（`load_skill` 渐进加载）。

## 技术栈

TypeScript · cordis 4（DI/插件）· langchain / langgraph · better-sqlite3 + drizzle-orm · zod · React 19 + Vite + Tailwind（面板前端）

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 LLM（OpenAI 兼容中转）与飞书应用凭证
pnpm db:migrate
pnpm seed              # 写入种子用户（channel_users，可按需在 scripts/seed.ts 增删）
pnpm dev
```

`pnpm dev` 会自动构建面板（`panel/dist` 缺失时）并启动后端，启动后访问 **http://localhost:3111** 即面板。

前端开发调试用 `pnpm dev:panel`：同时起后端（3111）与 vite dev server（5173，`/api` 自动代理），改前端代码即时热更新。

yml 方式装配启动：`pnpm start:yml`。测试：`pnpm test`。

## 文档

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 唯一架构文档：模块与目录、核心契约、事件协议、扩展指南、待办与设计储备、约定与坑、已知问题
- [AGENTS.md](AGENTS.md) —— 编码原则
