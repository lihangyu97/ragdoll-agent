# 飞书 + Agent 集成方案

## 目标

飞书消息通过 Agent 处理并回复，支持多轮对话。当前阶段只做设计，不动代码。

---

## 最终效果

### 单聊场景

用户与机器人私聊：

```
[用户]   今天杭州天气怎么样？
[机器人] 🤔 正在思考中…
[机器人] 杭州今天天气晴朗，25°C，适合出门。

[用户]   明天呢？
[机器人] 🤔 正在思考中…
[机器人] 明天杭州预计多云，22-26°C。
```

→ 同一用户连续对话，上下文自动延续。
→ 每次用户发消息，先收到「正在思考中…」，agent 处理完后追加最终回复。
→ 想重置上下文，后续通过 `/reset` 命令清空历史。

### 话题群场景

用户在话题群中回复机器人的某条消息（进入话题线程）：

```
┌─ 话题：天气查询 ─────────────────────┐
│ [用户] 杭州今天天气怎么样？            │
│ [机器人] 🤔 正在思考中…               │
│ [机器人] 杭州今天天气晴朗，25°C。     │
│ [用户] 那上海呢？                      │  ← 回复机器人上一条，同话题
│ [机器人] 🤔 正在思考中…               │
│ [机器人] 上海今天多云，22°C。         │
└────────────────────────────────────────┘

┌─ 话题：查一下附近餐厅 ────────────────┐
│ [用户] 附近有什么好吃的？              │  ← 新话题，独立上下文
│ [机器人] 🤔 正在思考中…               │
│ [机器人] 您附近有这些餐厅：…           │
└────────────────────────────────────────┘
```

→ 每个话题独立上下文，互不干扰。

### 并发场景

```
[用户 A] 今天天气怎么样？
[用户 B] 推荐一下好玩的景点？
[机器人] 🤔 正在思考中…
[机器人] 🤔 正在思考中…
[机器人] 今天天气晴朗，25°C。
[机器人] 推荐您去西湖、灵隐寺等景点。
```

→ 不同用户的对话独立排队，各自串行处理。

---

## 整体架构

```
┌──────────────┐    写入      ┌──────────────────┐     轮询      ┌──────────────┐
│  飞书 WS     │ ──────────→  │  agent_traces    │ ──────────→  │   Worker     │
│  (监听消息)  │  (pending)   │  (消息队列/表)    │  每隔 3s     │  (单线程)    │
│              │              │                  │  取最早一条   │              │
│  1. 回"思考中"│              │  ┌────────────┐  │              │  agent.run() │
│  2. 写traces │              │  │ pending    │  │              │              │
│  3. 回结果   │              │  │ processing │  │              └──────┬───────┘
│  (hooks回调) │              │  │ done       │  │                     │
│              │              │  │ failed     │  │                     │
└──────────────┘              │  └────────────┘  │                     ▼
                              └──────────────────┘             ┌──────────────────┐
                                      │                        │  LangGraph       │
                                      │ 关联                    │  Checkpointer    │
                                      │                        │  (SQLite 持久化)  │
                                      ▼                        └──────────────────┘
                              ┌──────────────────┐
                              │  agent_threads    │
                              │  (会话元信息/表)  │
                              │  ┌────────────┐  │
                              │  │ active     │  │
                              │  │ inactive   │  │
                              │  └────────────┘  │
                              └──────────────────┘
```

---

## 表结构

```sql
-- 每个话题一条记录，生命周期贯穿整个会话
CREATE TABLE agent_threads (
  thread_id   TEXT PRIMARY KEY,  -- 单聊=chat_id, 话题群=thread_id
  chat_type   TEXT NOT NULL,     -- p2p / group
  chat_id     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- active / inactive
  created_at  TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

-- 每条消息一条记录，worker 按此排队
CREATE TABLE agent_traces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT NOT NULL REFERENCES agent_threads(thread_id),
  message_id  TEXT NOT NULL,     -- 飞书消息 ID，用于回复
  chat_id     TEXT NOT NULL,     -- 飞书会话 ID，用于回复
  input_text  TEXT NOT NULL,     -- 用户消息原文，传给 agent.run()
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending / processing / done / failed
  created_at  TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at  TEXT DEFAULT (datetime('now', 'localtime'))
);
```

### 数据示例

```
agent_threads

thread_id │ chat_type │ chat_id  │ status  │ created_at
──────────┼───────────┼──────────┼─────────┼────────────────────
T         │ p2p       │ oc_xxx   │ active  │ 2025-08-20 10:00:00

agent_traces

id │ thread_id │ message_id │ input_text     │ status  │ created_at
───┼───────────┼────────────┼────────────────┼─────────┼────────────────────
1  │ T         │ msg_aaa    │ 今天天气怎么样   │ done    │ 2025-08-20 10:00:00
2  │ T         │ msg_bbb    │ 明天呢          │ done    │ 2025-08-20 10:01:00
3  │ T         │ msg_ccc    │ 后天呢          │ pending │ 2025-08-20 10:02:00
```

---

## Thread ID 策略

| 场景                             | threadId           | 多轮支持                       |
| -------------------------------- | ------------------ | ------------------------------ |
| **单聊** (`chat_type === "p2p"`) | `chat_id`          | 始终同一上下文，后续用命令重置 |
| **话题群** (`group`，话题内消息) | `thread_id`        | 每个话题独立上下文，自动延续   |
| **普通群聊**                     | 暂不处理，后续扩展 |

---

## 消息流

### 飞书 WS 收到消息时

```
handleMessage()
  ├─ 1. 解析消息内容
  ├─ 2. 确定 threadId
  ├─ 3. 确保 agent_threads 有该 thread 记录（没有则创建）
  ├─ 4. replyText("🤔 正在思考中…")       ← 立即回复
  └─ 5. 插 agent_traces (status = pending) ← 排队等 worker 处理
```

### Worker 轮询

```
每隔 3 秒
  │
  ▼
SELECT * FROM agent_traces
WHERE status = 'pending'
ORDER BY created_at ASC
LIMIT 1
  │
  ├─ 没有 → 等下一轮
  │
  └─ 有 → UPDATE status = 'processing'
           │
           ▼
           try:
             const result = await agent.run(record.input_text, { threadId: record.thread_id })
             //           ↑ 从 input_text 字段读出，传给 agent
             //             检查点自动加载该 thread 全部历史，上下文延续
             //             多轮对话 worker 不需要知道是第几轮
             UPDATE status = 'done'
           catch:
             UPDATE status = 'failed'    ← 报错就标 failed，pm2 多进程兜底
```

### 飞书回复

通过 Hooks 监听 `AGENT_RESULT`，回调中：

```
trackHook(Hooks.AGENT_RESULT, (threadId, msg) => {
  // 查 agent_traces 表，取该 thread_id 最新一条 status=done 的记录
  const trace = getLatestDoneTrace(threadId)
  // 用 trace.message_id 或 trace.chat_id 回复飞书
  replyText(trace.message_id, msg.content)
})
```

预留 `TOOL_CALL` 等 hook 位置，后续扩展。

### 错误处理

`agent.run()` 报错时标记 `failed`，后续通过 pm2 多进程保证可用性，不需要超时兜底。

---

## 并发控制

单个 Worker 单线程串行，一次处理一条，处理完再拿下一个。不同 thread 的消息自然排队，同 thread 的消息也自然排队（因为每次只取最早的 `pending`）。

后续可通过 pm2 启动多个 Worker 进程，利用原子 `UPDATE` 天然竞争，互不冲突。

---

## 改动范围

### 需改动的文件

| 文件                         | 改动                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| `src/agent/index.ts`         | `run()` 返回 `Promise<string>`，收集 stream 中最后一个 AI Message 的文本    |
| `src/channels/lark/index.ts` | `handleMessage()` 改为写 `agent_traces` + `agent_threads`，不再直接调 agent |
| `src/sqlite/`（新增）        | 新增 `AgentThreads.ts` 和 `AgentTraces.ts`（或合并为一个文件）              |
| 新增 `src/worker/`           | Worker 轮询循环 + agent.run() 调用                                          |

### 无需改动的模块

Checkpointer、AgentTurn、Hooks 机制全部复用。

---

## 后续扩展

- **上下文重置命令**：通过 `/reset` 等命令将 `agent_threads.status` 设为 `inactive`，并清空 checkpointer 中对应 thread 的历史
- **普通群聊支持**：补充 `chat_type === "group"` 且无 `thread_id` 的处理策略
- **用户身份注入**：在 `input_text` 中拼接发送者信息，让 agent 感知谁在说话
- **Worker 并行**：后续可改为一次取多条（不同 thread），并发执行，提升吞吐
