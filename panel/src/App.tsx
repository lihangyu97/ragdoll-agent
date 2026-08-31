import { useState } from 'react'
import Overview from './views/Overview'
import ThreadsView from './views/Threads'
import LogsView from './views/Logs'

const TABS = [
  { id: 'overview', label: '总览' },
  { id: 'threads', label: 'Threads' },
  { id: 'logs', label: '日志' }
] as const

export type TabId = (typeof TABS)[number]['id']

export default function App() {
  const [tab, setTab] = useState<TabId>('overview')
  const [threadId, setThreadId] = useState<string | null>(null)

  // 跨页钻取：Traces 行点击 → Threads 回放
  const openThread = (id: string) => {
    setThreadId(id)
    setTab('threads')
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-200">
      <header className="flex items-center gap-6 border-b border-zinc-800 px-6 py-3">
        <span className="font-mono text-sm font-bold text-emerald-400">RAGDOLL AGENT PANEL</span>
        <nav className="flex gap-1">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded px-3 py-1.5 text-sm transition-colors ${
                tab === t.id
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className="ml-auto font-mono text-xs text-zinc-600">3s 自动刷新</span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-none p-6">
        {tab === 'overview' && <Overview onOpenThread={openThread} />}
        {tab === 'threads' && <ThreadsView threadId={threadId} onSelect={setThreadId} />}
        {tab === 'logs' && <LogsView />}
      </main>
    </div>
  )
}
