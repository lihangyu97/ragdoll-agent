# TODO

> 待办事项记录，做完一项勾一项。格式：`- [ ] 任务`（未做）/ `- [x] 任务`（完成）。

## Cordis 框架重构 ✅（2025-08-25 主要迁移完成）

- [x] 迁移方案与结论见 `docs/cordis-migration.md`（Service/Plugin 映射、事件协议、依赖图、坑）
- [x] 阶段零~三全部落地：sqlite 各层 → database/traces/threads/turns/channelLark Service；HookBus → cordis 事件；Application 拆成 lark/worker/turn-recorder/console-demo 插件；tools/prompt 插件注入
- [x] 每阶段 `pnpm typecheck` + `pnpm test` 保底
- [x] 真实链路验证：pending trace → worker 消费 → 工具调用 → agent/result 触发 lark 回复 + turn-recorder 写库
- [x] 阶段四（部分）：config 拆 import 副作用（import 不再 throw，校验挪 Service 构造器 → 插件 FAILED）；Schema 校验未引入（见 cordis-migration.md §7）
- [x] 补 worker / turn-recorder 单测（`test/worker.test.ts`、`test/turn-recorder.test.ts`）
- [x] 根上补回全局异常兜底（见下节）

## SQL 访问层错误处理 ✅（已实现；迁移后收编进 `database` Service）

**背景**：`node:sqlite`（DatabaseSync）是同步 API，`prepare/run/get` 出错会**同步 throw**。
之前所有查询函数都没包 try/catch，一旦触发就是 unhandled rejection → Node 24 默认崩进程。
（曾出现真实报错：旧库 `agent_threads` 表缺 `sender_open_id` 列，`ensureThread` 插入时 throw。）

**环境事实（实测确认）**：Node 24 的 `node:sqlite` **默认开启外键约束**（`PRAGMA foreign_keys = 1`），
违反 `REFERENCES` 会报 `errcode=787`（FOREIGN KEY constraint failed）。此前"FK 约束没开所以不会报"的认知有误。
生产路径已按 FK 安全（`ensureThread` 先于 `insertTrace`）；注意：直接往 `agent_traces` 插不存在的 thread_id、
或删除仍有 traces 引用的 `agent_threads` 记录，都会被 FK 拦截报错。

**已实现（最终方案，迁移后位置）**：

- [x] safe 执行 + 错误分级：`DatabaseService.run/get/all` + `classifySqliteError`（原 `src/sqlite/base/safe.ts`）
  - 策略：出错 → 记完整日志（SQL 摘要 / 参数 / errcode / threadId）→ **rethrow**（所有错误都中断，不做降级/重试）
  - 错误分级：`schema`（errcode=1 系）/ `constraint`（19xx 系，含 FK 787）/ `resource`（5/6/8/10/11/13/14）/ `unknown`
- [x] 数据模块全部换用：`traces` / `threads` / `turns` / `channelLark` Service（注入 database）
- [x] `sqlite/logger.ts` 例外：不走 safe，写失败 console 兜底 —— 日志写入失败不能反过来中断业务
- [x] 飞书回传：`lark.handleReceiveV1Message` 包 catch，sql 报错即中断并记录；agent 错误回传 `⚠️ Agent 处理失败：...`（agent/error 事件订阅）
- [x] LLM 超时：单次请求 60s + `maxRetries: 2`（`ChatOpenAI`）；`run()` 整体 5 分钟 AbortController 超时（`signal` 传入 `agent.stream`，超时 → AbortError → trace failed + 飞书回传）
- [x] worker 兜底：`poll()` 循环 try/catch（sql 报错不崩循环）+ 启动时 `resetStaleProcessingTraces()` 重置孤儿 processing 记录
- [x] 全局兜底：~~application/index.ts~~ **已补回**（2025-08-25）：`src/index.ts` 根上 `unhandledRejection`（exitCode=1 自然退出）/ `uncaughtException`（exit(1) 立即退出），兜住 checkpointer 等第三方实例的漏网异常（`SqliteSaver` 自己持有独立 DatabaseSync，不走 `getDb()`，database Service 管不到）
- [x] 验证：`test/database.test.ts`（错误 SQL rethrow + logger 记录）、`test/traces.test.ts`（FK 787）、`test/worker.test.ts`（轮询消费 + 失败路径）、`test/turn-recorder.test.ts` 已覆盖；正常收发消息真实链路验证过

## 数据库索引（待定，2026-08 评估过暂不加）

**背景**：当前每表几百条数据，全表扫描毫秒级，不加索引性能无感。但代码里几条高频查询路径值得以后加，成本极低：

- [ ] `agent_traces(status, created_at)`：worker 轮询 `status='pending' ORDER BY created_at` + 启动时 `resetStaleProcessingTraces` 都命中
- [ ] `agent_traces(thread_id)`：`getLatestProcessingTrace` 按 thread 查；且 `thread_id` 是 FK 引用列（Node 24 的 node:sqlite 默认开外键约束，见上文），对 FK 相关操作也有益
- [ ] `agent_turns(thread_id, turn_no)`：每条 turn 写入前都跑 `MAX(turn_no)`，加完可走覆盖索引

**明确不用加**：`channel_lark_user.open_id` / 各表 PK 已由 UNIQUE/主键约束隐式建索引；`channel_lark`、`logger` 应用里只 insert，显示工具的 ad-hoc 查询不需要索引。

**决策**：暂不加，等数据量真上来了（或显示工具出现明显慢查询）再落到 `DatabaseService.initSchema` 的 `CREATE INDEX IF NOT EXISTS`（跟随现有清库重建流程，无迁移）。
