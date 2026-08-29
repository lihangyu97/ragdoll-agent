import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { Badge, Card, Empty } from '../components/ui'
import { fmtDuration, fmtTime, truncate } from '../lib/format'

const STATUS_OPTIONS = ['', 'pending', 'processing', 'done', 'failed']

export default function TracesView({ onOpenThread }: { onOpenThread: (id: string) => void }) {
  const [status, setStatus] = useState('')
  const { data } = useQuery({
    queryKey: ['traces', status],
    queryFn: () => api.traces(status || undefined),
    refetchInterval: 3000
  })

  return (
    <Card
      title={
        <div className="flex items-center gap-2">
          筛选
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-300"
          >
            {STATUS_OPTIONS.map(s => (
              <option key={s} value={s}>
                {s || '全部状态'}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {!data ? (
        <Empty>加载中…</Empty>
      ) : data.length === 0 ? (
        <Empty>没有符合条件的 trace</Empty>
      ) : (
        <table className="w-full font-mono text-xs">
          <thead>
            <tr className="text-left text-zinc-600">
              <th className="pb-2 pr-3 font-normal">ID</th>
              <th className="pb-2 pr-3 font-normal">状态</th>
              <th className="pb-2 pr-3 font-normal">渠道</th>
              <th className="pb-2 pr-3 font-normal">输入</th>
              <th className="pb-2 pr-3 font-normal">耗时</th>
              <th className="pb-2 font-normal">时间</th>
            </tr>
          </thead>
          <tbody>
            {data.map(t => (
              <tr
                key={t.id}
                onClick={() => onOpenThread(t.threadId)}
                className="cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-800/50"
              >
                <td className="py-2 pr-3 text-zinc-500">#{t.id}</td>
                <td className="py-2 pr-3">
                  <Badge status={t.status} />
                </td>
                <td className="py-2 pr-3 text-zinc-500">{t.channel ?? '-'}</td>
                <td className="max-w-md py-2 pr-3 text-zinc-300">{truncate(t.inputText, 60)}</td>
                <td className="py-2 pr-3 text-zinc-400">{fmtDuration(t.durationMs)}</td>
                <td className="py-2 text-zinc-500">{fmtTime(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
