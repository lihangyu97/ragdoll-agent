# TODO

> 待办事项记录，做完一项勾一项。格式：`- [ ] 任务`（未做）/ `- [x] 任务`（完成）。

## SQL 访问层错误处理 ✅（2025-08 已实现）

**背景**：`node:sqlite`（DatabaseSync）是同步 API，`prepare/run/get` 出错会**同步 throw**。
之前所有查询函数都没包 try/catch，一旦触发就是 unhandled rejection → Node 24 默认崩进程。
（曾出现真实报错：旧库 `agent_threads` 表缺 `sender_open_id` 列，`ensureThread` 插入时 throw。）

**环境事实（实测确认）**：Node 24 的 `node:sqlite` **默认开启外键约束**（`PRAGMA foreign_keys = 1`），
违反 `REFERENCES` 会报 `errcode=787`（FOREIGN KEY constraint failed）。此前"FK 约束没开所以不会报"的认知有误。
生产路径已按 FK 安全（`ensureThread` 先于 `insertTrace`）；注意：直接往 `agent_traces` 插不存在的 thread_id、
或删除仍有 traces 引用的 `agent_threads` 记录，都会被 FK 拦截报错。

**已实现（最终方案）**：

- [x] 新增 `src/sqlite/safe.ts`：`safeRun` / `safeGet` / `safeAll` + `classifySqliteError`
  - 策略：出错 → 记完整日志（SQL 摘要 / 参数 / errcode / threadId）→ **rethrow**（所有错误都中断，不做降级/重试）
  - 错误分级：`schema`（errcode=1 系）/ `constraint`（19xx 系，含 FK 787）/ `resource`（5/6/8/10/11/13/14）/ `unknown`
- [x] 数据模块全部换用 safe 函数：`agentTraces` / `agentThreads` / `agentTurns` / `channelLark`
- [x] `sqlite/logger.ts` 例外：不走 safe，写失败 console 兜底 —— 日志写入失败不能反过来中断业务
- [x] 飞书回传：`lark.handleMessage` 包 try/catch，sql 报错即中断流程并回复 `⚠️ 处理失败：...`（友好信息；完整错误进 logger 表）
- [x] agent 运行错误回传：`hooks.ts` 扩展 `AGENT_ERROR` 事件，worker catch 里先广播（trace 仍为 processing，lark 可反查 message_id）再标 failed；lark 订阅后回复 `⚠️ Agent 处理失败：...`
- [x] LLM 超时：单次请求 60s + `maxRetries: 2`（`ChatOpenAI`）；`run()` 整体 5 分钟 AbortController 超时（`signal` 传入 `agent.stream`，超时 → AbortError → trace failed + 飞书回传）
- [x] worker 兜底：`poll()` 循环 try/catch（sql 报错不崩循环）+ 启动时 `resetStaleProcessingTraces()` 重置孤儿 processing 记录

**尚未做**：

- [x] 全局兜底：`application/index.ts` 加 `process.on('unhandledRejection' / 'uncaughtException')`，记日志后退出（unhandledRejection → exitCode=1 自然退出；uncaughtException → exit(1) 立即退出，兜住 checkpointer 等第三方实例的漏网异常——`SqliteCheckpointer` 自己持有独立 DatabaseSync，不走 `getDb()`，safe 层管不到）
- [ ] 验证：造错脚本（删表 / 插 NULL / 插重复 open_id）断言 rethrow + 日志有记录；正常收发消息回归

## 数据库索引（待定，2026-08 评估过暂不加）

**背景**：当前每表几百条数据，全表扫描毫秒级，不加索引性能无感。但代码里几条高频查询路径值得以后加，成本极低：

- [ ] `agent_traces(status, created_at)`：worker 轮询 `status='pending' ORDER BY created_at` + 启动时 `resetStaleProcessingTraces` 都命中
- [ ] `agent_traces(thread_id)`：`getLatestProcessingTrace` 按 thread 查；且 `thread_id` 是 FK 引用列（Node 24 的 node:sqlite 默认开外键约束，见上文），对 FK 相关操作也有益
- [ ] `agent_turns(thread_id, turn_no)`：每条 turn 写入前都跑 `MAX(turn_no)`，加完可走覆盖索引

**明确不用加**：`channel_lark_user.open_id` / 各表 PK 已由 UNIQUE/主键约束隐式建索引；`channel_lark`、`logger` 应用里只 insert，显示工具的 ad-hoc 查询不需要索引。

**决策**：暂不加，等数据量真上来了（或显示工具出现明显慢查询）再落到 `schema.ts` 的 `CREATE INDEX IF NOT EXISTS`（跟随现有清库重建流程，无迁移）。
