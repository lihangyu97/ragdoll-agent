# worker 无主 trace 回收：心跳租约（heartbeat / lease）方案

> 状态：**方案讨论稿（未实施）**。背景是现有静态阈值回收的局限（见 §1），以及后续多 worker / 多实例
> （pm2 每核一个 worker）的演进需求。实施时机见 §9。相关现状：`docs/cordis-migration.md` §0 worker 描述、
> `docs/TODO.md`。

---

## 1. 背景与问题

现状（2025-08-25 已实现）：

- 无主 trace 回收 = `TracesService.resetStaleProcessingTraces()`：把 `status='processing'` 且
  `updated_at` 超过 `STALE_PROCESSING_MINUTES`（= 10min）的记录重置回 pending
- 触发时机 = **仅 worker 启动时**（`WorkerService.start()` → `recoverStaleTraces()`）
- 判死依据 = `updated_at`，即**进入 processing 的时刻**（`updateTraceStatus` 每次状态流转刷新它）

两个根本局限：

1. **阈值必须大于"合法运行时长"，否则误伤正在跑的 trace**：单次 agent 执行上限
   `AGENT_RUN_TIMEOUT_MS` = 5min，所以阈值取 10min。**agent 一轮时长一旦超过 10min，
   阈值就得跟着调大，而无主 trace 的恢复延迟也同步变大**（最多等阈值 + 轮询间隔才被回收）。
   "允许长任务"和"尽快恢复"在静态阈值下不可兼得。
2. **只覆盖"启动时"**：运行期间某个实例崩溃、其他实例一直活着时，它的残留 trace
   要等其他实例**下一次启动**才会被回收；且多实例下"无条件重置所有 processing"会误伤
   其他实例正在跑的 trace（这也是现实现加超时阈值的原因）。

## 2. 方案：心跳租约

把判死依据从"**开始时间**"换成"**最近活跃时间**"：

- worker 领取 trace 进入处理时，**处理期间每 30s 刷新一次 `heartbeat_at`**（一条 UPDATE，开销可忽略）
- 判死依据：`heartbeat_at` 超过 **90s（= 3 × 心跳间隔）** 未更新 ⇒ 判定进程已死
- 效果：**阈值与 run 时长彻底解耦**——agent 跑 30 分钟也一直有心跳、不会被误判；
  进程崩溃后最快 ~2 分钟（判死 90s + sweep 间隔）就被回收，而不是现在的 10min+

## 3. 配套决策

### 3.1 心跳写哪里

- `agent_traces` **新增一列 `heartbeat_at`**（复用 `updatedAt` 会混淆"状态流转时间"与"活跃时间"两种语义，不推荐）
- worker 在 `agent.run` 进行期间并行跑一个 interval 写 `heartbeat_at`（`run` 是 async/await，
  起定时器并行刷新，run 结束后 clear 即可）；只在处理中刷，领取/完成不刷
- **不推荐**用 agent 进度事件（`agent/tool-call` 等）当心跳：LLM 单次流式响应长时间不吐 token
  （长思考）时事件会停，心跳假死
- **不推荐**借 checkpointer 的 checkpoint 写入时间：依赖 LangGraph SqliteSaver 内部表结构，脆弱

### 3.2 回收触发：从"仅启动时"升级为"周期 sweep"

- 每个 worker 在**轮询循环里定期 sweep**（每次 `poll()` 开头顺带扫一次，或独立 60s 定时器）
- sweep = 一条原子 UPDATE：`status='processing' AND heartbeat_at < now-90s → 重置回 pending`
- **多实例安全**：同一行只会被一个实例的 UPDATE 命中一次；只要实例活着，它的 trace 心跳就是新的，
  不会被其他实例 sweep 掉
- 启动时的 `recoverStaleTraces()` 保留（sweep 同一逻辑，启动先跑一轮即可），顺带覆盖"重启"场景

### 3.3 与现有超时的职责划分

| 机制                                                         | 作用域   | 职责                                      |
| ------------------------------------------------------------ | -------- | ----------------------------------------- |
| `AGENT_RUN_TIMEOUT_MS`（5min，进程内 AbortController abort） | 单进程内 | 防**单次 run 卡死**（LLM 不返回）         |
| 心跳阈值（90s）                                              | 跨进程   | 判死：防**进程崩溃/挂起**留下的无主 trace |

两者并存、职责不同。若未来真上长任务，`AGENT_RUN_TIMEOUT_MS` 需跟着调大/做成可配置；
心跳方案本身不受影响。

## 4. 恢复语义：至少一次（重放副作用）

重置回 pending 后，trace 会被任一 worker **从头再执行一次**（同一输入重跑）。

- 对话回复场景：没问题——崩溃那次没来得及回复，重跑一次用户只看到一次回复
- **若 agent 挂的工具带副作用**（发邮件、写库、调外部 API）：重放 = 重复副作用，需应对：
  1. 接受"至少一次"（对话类够用，最简单）
  2. 工具副作用设计成**幂等**（同一输入重复执行无额外影响）
  3. "执行 ID + 去重表"（做了才算，复杂，最后再考虑）

## 5. 参数建议

| 参数       | 值                                     | 说明                                     |
| ---------- | -------------------------------------- | ---------------------------------------- |
| 心跳间隔   | 30s                                    | 写入频率；越低判死越快但写得多           |
| 判死阈值   | 90s = 3×间隔                           | 容忍偶发 GC / 卡顿 / 调度延迟            |
| sweep 频率 | 60s（或每次 poll）                     | 回收延迟 ≈ 判死阈值 + sweep 间隔         |
| 时钟       | SQLite `datetime('now')`（数据库时钟） | 单机部署无问题；多机部署避免各机时钟偏差 |

## 6. 多机部署注意事项

- 心跳/判死都用**数据库时钟**（`datetime('now', 'localtime')`），不要用各进程本地时间，避免时钟偏差误判
- 多机共享 SQLite 文件本身有网络文件系统风险（NFS 锁不可靠），多机场景应换 PostgreSQL 等；
  心跳租约的 UPDATE 语义在 PG 下同样成立（`SELECT ... FOR UPDATE SKIP LOCKED` 抢锁可一并升级）

## 7. 与现状代码的对应

- `TracesService.resetStaleProcessingTraces()`：语义复用，判据从 `updated_at < now-10min`
  改为 `heartbeat_at < now-90s`；方法名可保持或改 `sweepStaleProcessingTraces()`
- `STALE_PROCESSING_MINUTES` 常量：退役或改义为心跳判死阈值（90s）
- `WorkerService.recoverStaleTraces()`：从"启动时跑一次"扩展为"启动跑一次 + 轮询周期跑"
- `WorkerService` 处理路径：新增心跳 interval（`agent.run` 期间每 30s 写 `heartbeat_at`）

## 8. 改造清单（实施时对照）

- [ ] `src/services/data/database/schema.ts`：`agentTraces` 加 `heartbeatAt` 列 → `pnpm db:generate`
      （表结构变更后按约定清库，无迁移逻辑）
- [ ] `src/services/data/traces/TracesService.ts`：新增/修改心跳判死 sweep（原子 UPDATE）
- [ ] `src/services/worker/WorkerService.ts`：处理期间心跳 interval；poll 周期 sweep；启动 sweep 保留
- [ ] 测试：心跳续租不误伤（处理中超阈值仍不回收）；超时判死回收；sweep 周期触发；
      至少一次重放语义（恢复后重新消费）
- [ ] `docs/cordis-migration.md` §0 / `docs/TODO.md`：同步说明

## 9. 实施时机（阶段划分）

- **阶段 1（现状，多实例之前）**：单实例 + 启动时静态阈值回收已够用，暂不做
- **阶段 2（上多实例时，与 pm2 部署一起）**：心跳 + 周期 sweep 一并落地；
  同时启用崩溃残留的"运行期间"回收能力
- **阶段 3（真长任务/多机）**：`AGENT_RUN_TIMEOUT_MS` 可配置化；SQLite → PostgreSQL
  （`FOR UPDATE SKIP LOCKED`）；必要时上执行 ID 去重

---

> 结论一句话：把"开始时间 + 大阈值"换成"持续心跳 + 小阈值"——`heartbeat_at` 每 30s 刷新、
> 90s 没更新判死、周期 sweep 回收；agent 想跑多久跑多久，无主 trace 最快 ~2 分钟恢复，互不拖累。
