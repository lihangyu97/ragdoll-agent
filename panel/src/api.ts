export type TraceStatus = 'pending' | 'processing' | 'done' | 'failed'

export interface TraceRow {
  id: number
  threadId: string
  channel: string | null
  status: string
  inputText: string
  createdAt: string | null
  updatedAt: string | null
  durationMs: number | null
}

export interface ThreadRow {
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

export interface TurnRow {
  id: number
  threadId: string
  turnNo: number
  hookType: string
  node: string | null
  toolCallId: string | null
  toolName: string | null
  args: string | null
  content: string | null
  toolsResult: string | null
  createdAt: string | null
}

export interface LogRow {
  id: number
  level: string
  message: string
  data: string | null
  threadId: string | null
  createdAt: string | null
}

export interface LogPage {
  items: LogRow[]
  /** 下一页游标：还有更早记录时返回本页最后一条 id，否则 null */
  nextCursor: number | null
}

export interface OverviewData {
  counts: Record<TraceStatus, number>
  hourly: { bucket: string; count: number }[]
  processing: {
    id: number
    threadId: string
    channel: string | null
    inputText: string
    heartbeatAt: string | null
    createdAt: string | null
  }[]
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  overview: () => get<OverviewData>('/api/overview'),
  traces: (status?: string) =>
    get<TraceRow[]>(`/api/traces${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  threads: () => get<ThreadRow[]>('/api/threads'),
  turns: (threadId: string) => get<TurnRow[]>(`/api/threads/${encodeURIComponent(threadId)}/turns`),
  logs: (
    params: {
      level?: string
      threadId?: string
      beforeId?: number
      from?: string
      to?: string
    } = {}
  ) => {
    const { level, threadId, beforeId, from, to } = params
    const qs = new URLSearchParams()
    if (level) qs.set('level', level)
    if (threadId) qs.set('threadId', threadId)
    if (beforeId != null) qs.set('beforeId', String(beforeId))
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    const s = qs.toString()
    return get<LogPage>(`/api/logs${s ? `?${s}` : ''}`)
  }
}
