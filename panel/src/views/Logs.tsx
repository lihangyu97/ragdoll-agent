import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type LogRow } from '../api'
import { Badge, Card, Empty, Json } from '../components/ui'
import { fmtTime } from '../lib/format'

const LEVEL_OPTIONS = ['', 'info', 'warn', 'error']

/** datetime-local 值（YYYY-MM-DDTHH:MM）转库内时间格式：起点补 :00，终点补 :59 覆盖整分钟 */
const toDbTime = (v: string, end: boolean) =>
  v ? `${v.replace('T', ' ')}${end ? ':59' : ':00'}` : ''

export default function LogsView() {
  const [level, setLevel] = useState('')
  const [threadId, setThreadId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  // 加载更多：extra 是已追加的历史批；moreCursor 是下一批的 beforeId（null=还没追加过）
  const [extra, setExtra] = useState<LogRow[]>([])
  const [moreCursor, setMoreCursor] = useState<number | null>(null)
  const [exhausted, setExhausted] = useState(false)
  // 加载更多后暂停自动刷新：第一页静止，追加的历史才不会因 3s 轮询错位
  const [paused, setPaused] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const { data: page } = useQuery({
    queryKey: ['logs', level, threadId, from, to],
    queryFn: () =>
      api.logs({
        level: level || undefined,
        threadId: threadId || undefined,
        from: toDbTime(from, false),
        to: toDbTime(to, true)
      }),
    refetchInterval: paused ? undefined : 3000
  })

  // 筛选条件变化时重置追加状态
  useEffect(() => {
    setExtra([])
    setMoreCursor(null)
    setExhausted(false)
    setPaused(false)
  }, [level, threadId, from, to])

  const loadMore = async () => {
    if (!page || page.items.length === 0 || loadingMore) return
    setLoadingMore(true)
    setPaused(true)
    try {
      const beforeId = moreCursor ?? page.items[page.items.length - 1]!.id
      const next = await api.logs({
        level: level || undefined,
        threadId: threadId || undefined,
        from: toDbTime(from, false),
        to: toDbTime(to, true),
        beforeId
      })
      setExtra(e => [...e, ...next.items])
      if (next.nextCursor == null) setExhausted(true)
      else setMoreCursor(next.nextCursor)
    } finally {
      setLoadingMore(false)
    }
  }

  const items = [...(page?.items ?? []), ...extra]
  const hasMore =
    !exhausted && page != null && page.items.length > 0 && (moreCursor ?? page.nextCursor) != null

  return (
    <Card
      className="flex h-full min-h-0 flex-col"
      bodyClassName="min-h-0 flex-1 overflow-hidden"
      title={
        <div className="flex flex-wrap items-center gap-3">
          level
          <div className="flex gap-1">
            {LEVEL_OPTIONS.map(l => (
              <button
                key={l}
                onClick={() => setLevel(l)}
                className={`rounded px-2 py-1 font-mono text-xs ${
                  level === l ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-950 text-zinc-400'
                }`}
              >
                {l || 'all'}
              </button>
            ))}
          </div>
          <input
            value={threadId}
            onChange={e => setThreadId(e.target.value)}
            placeholder="精确匹配 threadId"
            className="w-52 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300 placeholder:text-zinc-600"
          />
          <input
            type="datetime-local"
            value={from}
            onChange={e => setFrom(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300 [color-scheme:dark]"
          />
          <span className="text-zinc-600">至</span>
          <input
            type="datetime-local"
            value={to}
            onChange={e => setTo(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300 [color-scheme:dark]"
          />
        </div>
      }
    >
      <div className="h-full overflow-auto overscroll-none">
        {!page ? (
          <Empty>加载中…</Empty>
        ) : items.length === 0 ? (
          <Empty>没有符合条件的日志</Empty>
        ) : (
          <>
            <div className="space-y-0.5 font-mono text-xs">
              {items.map(log => (
                <div key={log.id} className="flex gap-3 rounded px-2 py-1.5 hover:bg-zinc-800/50">
                  <span className="shrink-0 text-zinc-600">{fmtTime(log.createdAt)}</span>
                  <span className="w-14 shrink-0">
                    <Badge status={log.level} />
                  </span>
                  <span className="w-40 shrink-0 truncate text-zinc-500">{log.threadId ?? ''}</span>
                  <div className="min-w-0 flex-1">
                    <span className="break-all text-zinc-300">{log.message}</span>
                    {log.data && <Json text={log.data} />}
                  </div>
                </div>
              ))}
            </div>
            {hasMore && (
              <div className="mt-3 text-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="rounded border border-zinc-700 px-4 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
                >
                  {loadingMore ? '加载中…' : '加载更多'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  )
}
