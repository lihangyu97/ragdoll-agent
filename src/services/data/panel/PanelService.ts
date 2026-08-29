import { Service, type Context } from 'cordis'
import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import {
  agentThreads,
  agentTraces,
  agentTurns,
  logger,
  TRACE_STATUS,
  type TraceStatus
} from '@/services/data/database/schema'

export type TurnRecord = typeof agentTurns.$inferSelect
export type LogRecord = typeof logger.$inferSelect

export interface TraceStatusCounts {
  pending: number
  processing: number
  done: number
  failed: number
}

/** 近 24h trace 量按小时聚合（bucket = 'YYYY-MM-DD HH:00:00'，本地时间） */
export interface HourlyBucket {
  bucket: string
  count: number
}

export interface OverviewData {
  counts: TraceStatusCounts
  hourly: HourlyBucket[]
  processing: {
    id: number
    threadId: string
    channel: string | null
    inputText: string
    heartbeatAt: string | null
    createdAt: string | null
  }[]
}

export interface TraceListItem {
  id: number
  threadId: string
  channel: string | null
  status: string
  inputText: string
  createdAt: string | null
  updatedAt: string | null
  /** updatedAt - createdAt（毫秒）：pending/processing 时长仍在增长，仅 done/failed 时是最终耗时 */
  durationMs: number | null
}

export interface ThreadListItem {
  threadId: string
  chatType: string
  chatId: string
  senderId: string | null
  agentId: string | null
  status: string
  lastAt: string | null
  lastStatus: string | null
  lastInput: string | null
}

export interface LogQuery {
  level?: string | undefined
  threadId?: string | undefined
  limit?: number | undefined
}

declare module 'cordis' {
  interface Context {
    panel: PanelService
  }
}

/**
 * panel Service：面板只读查询（只读、无状态），跨 traces/threads/turns/logger 表做展示聚合。
 * 面板 API 是唯一消费者；写入路径仍归各自 repository（traces/threads/turns），这里不提供任何写方法。
 */
export default class PanelService extends Service {
  static inject = ['database']

  constructor(ctx: Context) {
    super(ctx, 'panel')
  }

  getOverview(): OverviewData {
    const db = this.ctx.database.db

    const countRows = db
      .select({ status: agentTraces.status, count: sql<number>`count(*)`.as('count') })
      .from(agentTraces)
      .groupBy(agentTraces.status)
      .all()
    const counts: TraceStatusCounts = { pending: 0, processing: 0, done: 0, failed: 0 }
    for (const row of countRows) counts[row.status as TraceStatus] = row.count

    // 'YYYY-MM-DD HH:MM:SS' 的字典序即时间序，直接按表达式分组/排序
    const hourExpr = sql`strftime('%Y-%m-%d %H:00:00', ${agentTraces.createdAt})`
    const hourly = db
      .select({
        bucket: sql<string>`${hourExpr}`.as('bucket'),
        count: sql<number>`count(*)`.as('count')
      })
      .from(agentTraces)
      .where(sql`${agentTraces.createdAt} >= datetime('now', 'localtime', '-24 hours')`)
      .groupBy(hourExpr)
      .orderBy(hourExpr)
      .all()

    const processing = db
      .select({
        id: agentTraces.id,
        threadId: agentTraces.threadId,
        channel: agentTraces.channel,
        inputText: agentTraces.inputText,
        heartbeatAt: agentTraces.heartbeatAt,
        createdAt: agentTraces.createdAt
      })
      .from(agentTraces)
      .where(eq(agentTraces.status, TRACE_STATUS.PROCESSING))
      .orderBy(desc(agentTraces.id))
      .all()

    return { counts, hourly, processing }
  }

  listTraces(status?: TraceStatus, limit = 100): TraceListItem[] {
    return this.ctx.database.db
      .select({
        id: agentTraces.id,
        threadId: agentTraces.threadId,
        channel: agentTraces.channel,
        status: agentTraces.status,
        inputText: agentTraces.inputText,
        createdAt: agentTraces.createdAt,
        updatedAt: agentTraces.updatedAt,
        // julianday 解析 'YYYY-MM-DD HH:MM:SS'，差值 × 一天毫秒数
        durationMs: sql<number | null>`round(
          (julianday(${agentTraces.updatedAt}) - julianday(${agentTraces.createdAt})) * 86400000
        )`.as('durationMs')
      })
      .from(agentTraces)
      .where(status ? eq(agentTraces.status, status) : undefined)
      .orderBy(desc(agentTraces.id))
      .limit(limit)
      .all()
  }

  listThreads(limit = 50): ThreadListItem[] {
    // 每 thread 的最后一条 trace 用相关子查询取（面板数据量小，不为它写窗口函数）。
    // 子查询里外表必须显式限定：drizzle 单表查询渲染列时不带表前缀，会被内层 at.thread_id 遮蔽
    const outer = sql.raw('"agent_threads"."thread_id"')
    const lastExpr = (col: string, alias: string) =>
      sql<
        string | null
      >`(select ${sql.raw(col)} from agent_traces at where at.thread_id = ${outer} order by at.id desc limit 1)`.as(
        alias
      )
    const lastAtExpr = sql<
      string | null
    >`(select max(at.created_at) from agent_traces at where at.thread_id = ${outer})`.as('lastAt')
    return this.ctx.database.db
      .select({
        threadId: agentThreads.threadId,
        chatType: agentThreads.chatType,
        chatId: agentThreads.chatId,
        senderId: agentThreads.senderId,
        agentId: agentThreads.agentId,
        status: agentThreads.status,
        lastAt: lastAtExpr,
        lastStatus: lastExpr('at.status', 'lastStatus'),
        lastInput: lastExpr('at.input_text', 'lastInput')
      })
      .from(agentThreads)
      .orderBy(sql`lastAt desc`)
      .limit(limit)
      .all()
  }

  getTurns(threadId: string): TurnRecord[] {
    return this.ctx.database.db
      .select()
      .from(agentTurns)
      .where(eq(agentTurns.threadId, threadId))
      .orderBy(agentTurns.turnNo, agentTurns.id)
      .all()
  }

  listLogs({ level, threadId, limit = 200 }: LogQuery = {}): LogRecord[] {
    const conds: SQL[] = []
    if (level) conds.push(eq(logger.level, level))
    if (threadId) conds.push(eq(logger.threadId, threadId))
    return this.ctx.database.db
      .select()
      .from(logger)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(logger.id))
      .limit(limit)
      .all()
  }
}
