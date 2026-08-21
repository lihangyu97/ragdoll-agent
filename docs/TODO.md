# TODO

> 待办事项记录，做完一项勾一项。格式：`- [ ] 任务`（未做）/ `- [x] 任务`（完成）。

## SQL 访问层错误处理 ✅（2025-08 已实现）

**背景**：`node:sqlite`（DatabaseSync）是同步 API，`prepare/run/get` 出错会**同步 throw**。
之前所有查询函数都没包 try/catch，一旦触发就是 unhandled rejection → Node 24 默认崩进程。
（曾出现真实报错：旧库 `agent_threads` 表缺 `sender_open_id` 列，`ensureThread` 插入时 throw。）

**已实现（最终方案）**：

- [x] 新增 `src/sqlite/safe.ts`：`safeRun` / `safeGet` / `safeAll` + `classifySqliteError`
  - 策略：出错 → 记完整日志（SQL 摘要 / 参数 / errcode / threadId）→ **rethrow**（所有错误都中断，不做降级/重试）
  - 错误分级：`schema`（errcode=1 系）/ `constraint`（19xx 系）/ `resource`（5/6/8/10/11/13/14）/ `unknown`
- [x] 数据模块全部换用 safe 函数：`agentTraces` / `agentThreads` / `agentTurns` / `channelLark`
- [x] `sqlite/logger.ts` 例外：不走 safe，写失败 console 兜底 —— 日志写入失败不能反过来中断业务
- [x] 飞书回传：`lark.handleMessage` 包 try/catch，sql 报错即中断流程并回复 `⚠️ 处理失败：...`（友好信息；完整错误进 logger 表）
- [x] agent 运行错误回传：`hooks.ts` 扩展 `AGENT_ERROR` 事件，worker catch 里先广播（trace 仍为 processing，lark 可反查 message_id）再标 failed；lark 订阅后回复 `⚠️ Agent 处理失败：...`

**尚未做**：

- [ ] 全局兜底：`application/index.ts` 加 `process.on('unhandledRejection' / 'uncaughtException')`，记日志后 `process.exitCode = 1`（兜住 checkpointer 等第三方实例的漏网异常——`SqliteCheckpointer` 自己持有独立 DatabaseSync，不走 `getDb()`，safe 层管不到）
- [ ] 验证：造错脚本（删表 / 插 NULL / 插重复 open_id）断言 rethrow + 日志有记录；正常收发消息回归

## 表结构迁移机制（2025-08 新增）

**背景**：`initSchema()` 用 `CREATE TABLE IF NOT EXISTS`，表已存在时**不会改结构**。
曾导致：旧库缺 `sender_open_id` 列，代码按新 schema 插入直接报错，只能靠手动删库重建。

- [ ] 给 schema 加版本号（如 `PRAGMA user_version`），启动时比对，低版本执行 `ALTER TABLE` 迁移
- [ ] 迁移脚本组织方式：`src/sqlite/migrations/` 下按版本号放迁移，`initSchema` 按顺序执行
