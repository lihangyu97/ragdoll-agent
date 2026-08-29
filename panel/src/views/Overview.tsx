import { useQuery } from '@tanstack/react-query'
import { api, type OverviewData } from '../api'
import { Badge, Card, Empty } from '../components/ui'
import { secondsSince, truncate } from '../lib/format'

/** 与 TracesService.LEASE_TIMEOUT_SECONDS 一致：超时未续租 = 疑似无主 */
const LEASE_TIMEOUT_SECONDS = 90

function HourlyBars({ hourly }: { hourly: OverviewData['hourly'] }) {
  const now = new Date()
  const buckets: { label: string; count: number }[] = []
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - i)
    const pad = (n: number) => String(n).padStart(2, '0')
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00:00`
    const hit = hourly.find(h => h.bucket === key)
    buckets.push({ label: `${pad(d.getHours())}:00`, count: hit?.count ?? 0 })
  }
  const max = Math.max(1, ...buckets.map(b => b.count))

  return (
    <div>
      <div className="flex h-32 items-end gap-1">
        {buckets.map((b, i) => (
          <div
            key={i}
            title={`${b.label} — ${b.count} 条`}
            className={`flex-1 rounded-t ${b.count > 0 ? 'bg-emerald-500/70' : 'bg-zinc-800'}`}
            style={{ height: `${Math.max(b.count > 0 ? 4 : 2, (b.count / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-xs text-zinc-600">
        <span>{buckets[0]?.label}</span>
        <span>近 24h</span>
        <span>{buckets[buckets.length - 1]?.label}</span>
      </div>
    </div>
  )
}

export default function Overview({ onOpenThread }: { onOpenThread: (id: string) => void }) {
  const { data } = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: 3000
  })
  if (!data) return <Empty>加载中…</Empty>

  const stats = [
    { label: 'pending', value: data.counts.pending, tone: 'text-zinc-100' },
    { label: 'processing', value: data.counts.processing, tone: 'text-sky-400' },
    { label: 'done', value: data.counts.done, tone: 'text-emerald-400' },
    { label: 'failed', value: data.counts.failed, tone: 'text-red-400' }
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-4">
        {stats.map(s => (
          <Card key={s.label}>
            <div className="text-xs text-zinc-500">{s.label}</div>
            <div className={`mt-1 font-mono text-3xl font-bold ${s.tone}`}>{s.value}</div>
          </Card>
        ))}
      </div>

      <Card title="近 24h trace 量">
        <HourlyBars hourly={data.hourly} />
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card title="processing 租约">
          {data.processing.length === 0 ? (
            <Empty>当前没有 processing 中的 trace</Empty>
          ) : (
            <div className="space-y-2">
              {data.processing.map(t => {
                const age = secondsSince(t.heartbeatAt)
                const stale = age !== null && age > LEASE_TIMEOUT_SECONDS
                return (
                  <div
                    key={t.id}
                    className="flex cursor-pointer items-center gap-3 rounded bg-zinc-950 px-3 py-2 font-mono text-xs hover:bg-zinc-800"
                    onClick={() => onOpenThread(t.threadId)}
                  >
                    <span className="text-zinc-500">#{t.id}</span>
                    <span className="min-w-0 flex-1 truncate text-zinc-300">
                      {truncate(t.inputText, 40)}
                    </span>
                    <span className={stale ? 'text-red-400' : 'text-zinc-500'}>
                      心跳 {age === null ? '-' : `${age}s 前`}
                      {stale && ' ⚠ 超时'}
                    </span>
                  </div>
                )
              })}
              <p className="text-xs text-zinc-600">
                超过 {LEASE_TIMEOUT_SECONDS}s 未续租会被 worker sweep 回收重派
              </p>
            </div>
          )}
        </Card>

        <Card title="状态说明">
          <div className="space-y-2 text-xs text-zinc-500">
            <p className="flex items-center gap-2">
              <Badge status="pending" /> 已入队，等待 worker 领取
            </p>
            <p className="flex items-center gap-2">
              <Badge status="processing" /> worker 处理中（30s 心跳续租）
            </p>
            <p className="flex items-center gap-2">
              <Badge status="done" /> 处理成功，已出站回复
            </p>
            <p className="flex items-center gap-2">
              <Badge status="failed" /> 处理失败，去日志页看报错
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}
