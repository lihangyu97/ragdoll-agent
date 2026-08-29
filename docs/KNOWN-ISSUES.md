# 已知问题清单

> 2026-08-29 全仓库 review 后整理。与 `ARCHITECTURE.md` §6（待办）互补：本文记录
> review 发现的问题与风险，待办里已有的（心跳租约 / 队列索引 / token 观测 / guardrails）
> 不重复展开，只在相关条目下引用。

---

## 1. 运行模型

### 1.1 worker 完全串行（优先级最高）

`WorkerService.poll()` 用 `processing` 标志 + 循环内 `await this.process(trace)`，
整条队列一次只处理一条 trace，单实例无任何并发。

- 一条 agent run 最长 5 分钟（`AGENT_RUN_TIMEOUT_MS`），期间所有人的消息全部排队
- 没有按 thread 隔离：一个慢会话阻塞全部渠道、全部用户
- 改进方向：并发度可配置的 worker pool（简单信号量即可），或至少按 threadId 分桶并行；
  注意与 §6 待办「心跳租约回收」联动——多实例/并发抢锁语义要一起定

### 1.2 thread 绑定「一次性定终身」且不可逆

`WorkerService.resolveAgentId()`：首条消息即永久绑定 agent，之后无法变更。

- LLM 识别失败 / 返回 null 时**静默绑定 `default` 并永久生效**，用户无感知
- 没有解绑 / 重绑命令（如 `/reset` `/bind xxx`），绑错只能手改 `agent_threads` 表
- 改进方向：规则层路由（`agent/resolve` bail 事件）命中才永久绑定；LLM 识别结果
  可考虑会话内临时生效、N 轮后再落库；提供管理命令解绑

### 1.3 失败即丢，无重试 / 无重新投递

- trace 处理失败只标记 `failed` + 回复错误消息，没有重试计数、没有死信/重新投递机制
- 出站回复 `channel.send` 失败（adapter 返回 false 或抛错）只记日志，回复永久丢失
- **消息已消费但回复丢失的崩溃窗口**：`process()` 里先 DONE 再 `replyIfNeeded`，
  两步之间崩溃则状态 done、用户永远收不到回复
- 改进方向：failed 可重试计数 + 上限；出站失败重试队列；或先回复再 DONE（代价是
  崩溃后重复回复，配合幂等 message_id 可接受）

### 1.4 双连接共用同一个 SQLite 文件

业务库（`DatabaseService` → `getDb()` better-sqlite3 单例）与 langgraph checkpointer
（`SqliteSaver`）默认都是 `data/agent.db`，两条独立连接。WAL + busy_timeout 只是缓解，
高并发写仍可能出现 `SQLITE_BUSY`。ARCHITECTURE §7 已记录；根治需要把 checkpointer
指向独立文件，或换共享连接的 checkpointer 实现。

## 2. 安全（接入真实用户前必须处理）

> 现有护栏（路径前缀校验 / 命令白名单 / 解释器白名单）均为演示级，文档已声明。
> 以下是可以被实际利用的具体缺口，最终边界 = OS 沙箱/容器（同 §6 P1 guardrails）。

### 2.1 系统工具默认注入所有 agent

`CapabilityService` 构造时 seed `read_file/write_file/edit_file/list_dir/glob/grep/
run_command` 六个原语，`assemble` 自动并入**每个** agent，无法按 definition 裁剪。
在 guardrails 落地前，至少支持 definition 级别的系统工具白/黑名单。

### 2.2 `safePath` 不解析 symlink

`systemTools.ts` 的 `safePath` 用 `resolve()` + 前缀判断，不 `realpath`。
沙箱内一个指向外部的符号链接即可让 read/write 越界。修复：`stat` 后对最终路径
做 `realpath` 校验，或 `mkdtemp` + 挂载隔离。

### 2.3 `run_command` 白名单是前缀匹配

`commands` 白名单按前缀匹配命令字符串，`ls; rm -rf …` 这类拼接即绕过。
在真沙箱前建议：默认保持禁用（现默认已禁用），启用时仅允许无参数的固定命令，
或改为 argv 数组 + 精确匹配。

### 2.4 `run_skill_script` 的脚本内容随时可改

`skills/` 是仓库内普通目录，脚本白名单锁定的是路径不是内容——任何能改
`skills/<name>/scripts/` 的人都能让模型下次执行任意代码（解释器白名单限制的是
解释器不是行为）。默认关（现默认已关）+ 与 2.2/2.3 同属真沙箱前的演示语义。

### 2.5 无用户 / 群鉴权与限流

任何能触发 bot 的渠道用户（含群里 @）都能驱动 agent 跑工具，无 allowlist、无
限流、无每用户配额。多租户接入前需要渠道侧准入 + 用量限制。

## 3. 工程卫生

- ~~`AGENST.md` 文件名拼写错误~~（已改名为 `AGENTS.md`，ARCHITECTURE.md 引用已同步）
- 只有 prettier 没有 ESLint/oxlint：无 lint 规则（no-unused、no-floating-promise 等
  都靠自觉），pre-commit 只跑 format。见 docs/TOOLS.md 的 oxlint 评估结论
- 无 CI：10 个测试文件覆盖不错，但只能本地手动 `pnpm test`，建议加最小 CI
  （typecheck + test + format:check）
- `identify()` 的 `chatType` 参数是死参数：worker 调用从不传，路由 prompt 永远缺
  会话类型信息。要么传 `trace` 里已有的 chat 信息，要么删掉参数
- 依赖 cordis `4.0.0-rc.8` / loader `rc` 版本：pre-release 框架 API 变动风险，
  升级时留意 changelog
- `answer` 取「流里最后一个非工具消息」，若中间节点产出非空文本会覆盖语义上的
  最终答案；目前 createAgent 图形下问题不大，换框架/加子图时要重审
