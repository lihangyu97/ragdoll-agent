import type { ReactNode } from 'react'

export function Card({
  title,
  right,
  className = '',
  bodyClassName = '',
  children
}: {
  title?: ReactNode
  right?: ReactNode
  className?: string
  bodyClassName?: string
  children: ReactNode
}) {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900 ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <span className="text-sm font-medium text-zinc-300">{title}</span>
          {right}
        </div>
      )}
      <div className={`p-4 ${bodyClassName}`}>{children}</div>
    </div>
  )
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-zinc-700/60 text-zinc-300',
  processing: 'bg-sky-500/20 text-sky-300',
  done: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/20 text-red-300',
  error: 'bg-red-500/20 text-red-300',
  warn: 'bg-amber-500/20 text-amber-300',
  info: 'bg-zinc-700/60 text-zinc-300',
  active: 'bg-emerald-500/15 text-emerald-300',
  inactive: 'bg-zinc-700/60 text-zinc-400'
}

export function Badge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? 'bg-zinc-700/60 text-zinc-300'
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 font-mono text-xs ${style}`}>
      {status}
    </span>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-zinc-500">{children}</div>
}

export function Json({ text }: { text: string | null }) {
  if (text === null || text === '') return <span className="text-zinc-600">-</span>
  let pretty = text
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    // 非 JSON 文本原样展示
  }
  return (
    <details>
      <summary className="cursor-pointer select-none text-zinc-500 hover:text-zinc-300">
        展开（{text.length} 字符）
      </summary>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 text-xs text-zinc-400">
        {pretty}
      </pre>
    </details>
  )
}
