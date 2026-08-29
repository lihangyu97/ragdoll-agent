import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type ThreadRow, type TurnRow } from '../api'
import { Badge, Card, Empty, Json } from '../components/ui'
import { fmtTime, truncate } from '../lib/format'

const HOOK_LABELS: Record<string, { label: string; tone: string }> = {
  INPUT: { label: 'USER', tone: 'text-zinc-200' },
  TOOL_CALL: { label: 'TOOL', tone: 'text-sky-300' },
  TOOL_RESULT: { label: 'RESULT', tone: 'text-amber-300' },
  AGENT_RESULT: { label: 'OUTPUT', tone: 'text-emerald-300' },
  ERROR: { label: 'ERROR', tone: 'text-red-300' },
  TIMEOUT: { label: 'TIMEOUT', tone: 'text-red-300' }
}

function TurnEntry({ turn }: { turn: TurnRow }) {
  const meta = HOOK_LABELS[turn.hookType] ?? { label: turn.hookType, tone: 'text-zinc-400' }
  const isJson = turn.hookType === 'TOOL_CALL' || turn.hookType === 'TOOL_RESULT'
  const body = isJson
    ? (turn.toolCalls ?? turn.toolsResult)
    : turn.hookType === 'ERROR'
      ? (turn.content ?? '(无内容)')
      : turn.content

  return (
    <div className="flex gap-3 border-t border-zinc-800/60 py-2 first:border-0">
      <span className={`w-16 shrink-0 pt-0.5 font-mono text-xs ${meta.tone}`}>{meta.label}</span>
      <span className="w-28 shrink-0 truncate pt-0.5 font-mono text-xs text-zinc-600">
        {turn.node ?? ''}
      </span>
      <div className="min-w-0 flex-1 font-mono text-xs whitespace-pre-wrap break-words text-zinc-300">
        {isJson ? <Json text={body ?? null} /> : body || <span className="text-zinc-600">-</span>}
      </div>
    </div>
  )
}

function ThreadReplay({ threadId }: { threadId: string }) {
  const { data: turns } = useQuery({
    queryKey: ['turns', threadId],
    queryFn: () => api.turns(threadId),
    refetchInterval: 5000
  })
  if (!turns) return <Empty>加载中…</Empty>
  if (turns.length === 0) return <Empty>该 thread 还没有 turn 记录</Empty>

  // 按 turnNo 归组成轮（库内已按 turnNo, id 排序）
  const groups: TurnRow[][] = []
  for (const turn of turns) {
    const last = groups[groups.length - 1]
    if (last && last[0]?.turnNo === turn.turnNo) last.push(turn)
    else groups.push([turn])
  }

  return (
    <div className="space-y-4">
      {groups.map(group => {
        const first = group[0]
        return (
          <Card
            key={first!.turnNo}
            title={`Turn ${first!.turnNo}`}
            right={
              <span className="font-mono text-xs text-zinc-500">{fmtTime(first!.createdAt)}</span>
            }
          >
            <div>
              {group.map(turn => (
                <TurnEntry key={turn.id} turn={turn} />
              ))}
            </div>
          </Card>
        )
      })}
    </div>
  )
}

function ThreadItem({
  thread,
  selected,
  onSelect
}: {
  thread: ThreadRow
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full rounded px-3 py-2 text-left transition-colors ${
        selected ? 'bg-zinc-800' : 'hover:bg-zinc-900'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-400">
          {thread.threadId}
        </span>
        {thread.lastStatus && <Badge status={thread.lastStatus} />}
      </div>
      <div className="mt-1 truncate text-sm text-zinc-200">
        {thread.lastInput ? (
          truncate(thread.lastInput, 32)
        ) : (
          <span className="text-zinc-600">（无消息）</span>
        )}
      </div>
      <div className="mt-0.5 font-mono text-xs text-zinc-600">{fmtTime(thread.lastAt)}</div>
    </button>
  )
}

export default function ThreadsView({
  threadId,
  onSelect
}: {
  threadId: string | null
  onSelect: (id: string | null) => void
}) {
  const { data: threads } = useQuery({
    queryKey: ['threads'],
    queryFn: api.threads,
    refetchInterval: 5000
  })

  const list = useMemo(() => threads ?? [], [threads])

  return (
    <div className="grid grid-cols-[320px_1fr] items-start gap-4">
      <Card title={`Threads（${list.length}）`}>
        <div className="-m-4 max-h-[calc(100vh-200px)] space-y-1 overflow-auto p-4">
          {list.length === 0 && <Empty>还没有会话</Empty>}
          {list.map(t => (
            <ThreadItem
              key={t.threadId}
              thread={t}
              selected={t.threadId === threadId}
              onSelect={() => onSelect(t.threadId === threadId ? null : t.threadId)}
            />
          ))}
        </div>
      </Card>

      <div>
        {threadId ? (
          <ThreadReplay threadId={threadId} />
        ) : (
          <Card>
            <Empty>← 从左侧选择一个会话，回放 agent 执行轨迹</Empty>
          </Card>
        )}
      </div>
    </div>
  )
}
