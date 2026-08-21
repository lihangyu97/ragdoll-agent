# TODO

> 待办事项记录，做完一项勾一项。格式：`- [ ] 任务`（未做）/ `- [x] 任务`（完成）。

## SQL 访问层错误处理（2025-08 讨论方案，未实现）

**背景**：`node:sqlite`（DatabaseSync）是同步 API，`prepare/run/get` 出错会**同步 throw**。
当前所有查询函数都没包 try/catch，一旦触发就是 unhandled rejection → Node 24 默认崩进程。
目前"看着没报错"只是因为：数据都合法 + `initSchema()` 兜住了表结构 + FK 约束没开（`PRAGMA foreign_keys` 未启用）。

**已知漏网点**：

- `worker/index.ts` 的 `getPendingTrace()` 和 `updateTraceStatus(pending→processing)` 在 try/catch 外
- `channels/lark/index.ts` 的 `handleMessage`（insertLarkMessage / ensureThread / insertTrace）无兜底
- 全项目无 `unhandledRejection / uncaughtException` handler
- 注意：`SqliteCheckpointer`（langgraph）自己持有独立 DatabaseSync 实例，不走 `getDb()`，访问层管不到

**已确认事实**：`node:sqlite` 错误对象 `code` 恒为 `ERR_SQLITE_ERROR`，分类要靠 `errcode`：
`errcode=1`（SQLITE_ERROR：语法/表不存在）、`1299`（NOT NULL）、`2067`（UNIQUE）、`5/6`（BUSY/LOCKED，已有 busy_timeout=5000）。

**方案**：

1. 错误分级：
   - errcode=1（编程错误：SQL 写错/表不存在）→ fail-fast：ERROR 日志 + rethrow
   - 约束冲突（2067/1299/275/787）→ 降级：日志 + 返回 null/false
   - 资源错误（5/6/13/10/14/8/11）→ 降级：ERROR 日志
2. 新增 `src/sqlite/safe.ts`：`safeRun` / `safeGet` / `safeAll`（统一 try/catch + classify + 日志 + 带 SQL/参数/errcode/thread_id），另导出 `classifySqliteError` 便于单测
3. 改造清单（换用 safe 函数，对外签名基本不变）：
   - `agentTraces.ts`：insertTrace / getPendingTrace / getLatestProcessingTrace / updateTraceStatus（读→null，写→false，CAS boolean 语义保留）
   - `agentThreads.ts`：ensureThread（失败记日志）
   - `channelLark.ts`：insertLarkMessage / upsertUser / getUserName
   - `logger.ts`：insertLog 失败静默降级（日志写入失败不能连锁报错）
   - `worker/index.ts`：poll() 循环外层加 try/catch 保险，失败后 sleep 再继续（防空转）
   - `channels/lark/index.ts`：handleMessage 包 try/catch，失败记日志 + 回复用户，WS 不断连
4. 全局兜底：`application/index.ts` 加 `process.on('unhandledRejection' / 'uncaughtException')`，记日志后 `process.exitCode = 1`（兜住 checkpointer 等第三方实例的漏网异常）
5. 验证：造错脚本（删表 / 插 NULL / 插重复 open_id）断言不 throw + 日志有记录；正常收发消息回归

**待拍板（2 个取舍）**：

- [ ] 取舍 1：「查询失败」和「查询无结果」是否区分？
  - 简单版（推荐）：都返回 null，靠 ERROR 日志区分
  - 进阶版：`Result<T>`（`{ok, value} | {ok:false, error}`），样板多
- [ ] 取舍 2：编程错误（errcode=1）rethrow（推荐，fail-fast）还是全降级只记日志？

**状态**：⏸ 暂停，等拍板后实现
