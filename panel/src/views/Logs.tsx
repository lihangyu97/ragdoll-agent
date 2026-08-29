import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { Badge, Card, Empty, Json } from '../components/ui'
import { fmtTime } from '../lib/format'

const LEVEL_OPTIONS = ['', 'info', 'warn', 'error']

export default function LogsView() {
  const [level, setLevel] = useState('')
  const [threadId, setThreadId] = useState('')
  const { data } = useQuery({
    queryKey: ['logs', level, threadId],
    queryFn: () => api.logs(level || undefined, threadId || undefined),
    refetchInterval: 3000
  })

  return (
    <Card
      title={
        <div className="flex items-center gap-3">
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
            className="w-72 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300 placeholder:text-zinc-600"
          />
        </div>
      }
    >
      {!data ? (
        <Empty>加载中…</Empty>
      ) : data.length === 0 ? (
        <Empty>没有符合条件的日志</Empty>
      ) : (
        <div className="space-y-0.5 font-mono text-xs">
          {data.map(log => (
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
      )}
    </Card>
  )
}
