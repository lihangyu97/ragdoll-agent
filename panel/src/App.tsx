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
      <main className="relative min-h-0 flex-1 overflow-hidden">
        {TABS.map(t => (
          <div
            key={t.id}
            inert={tab === t.id ? undefined : true}
            className={`absolute inset-0 overflow-y-auto overscroll-none p-6 transition-opacity duration-200 ${
              tab === t.id ? 'z-10 opacity-100' : 'pointer-events-none z-0 opacity-0'
            }`}
          >
            {t.id === 'overview' && <Overview onOpenThread={openThread} />}
            {t.id === 'threads' && <ThreadsView threadId={threadId} onSelect={setThreadId} />}
            {t.id === 'logs' && <LogsView />}
          </div>
        ))}
      </main>
    </div>
  )
}
