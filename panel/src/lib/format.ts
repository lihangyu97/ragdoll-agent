/** 'YYYY-MM-DD HH:MM:SS'（库里的本地时间文本）→ Date */
export function parseLocal(s: string | null): Date | null {
  if (!s) return null
  return new Date(s.replace(' ', 'T'))
}

/** 'YYYY-MM-DD HH:MM:SS' → 'MM-DD HH:MM:SS'（当年省年份，跨年保留完整） */
export function fmtTime(s: string | null): string {
  if (!s) return '-'
  const year = new Date().getFullYear()
  return s.startsWith(`${year}-`) ? s.slice(5) : s
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** 距现在的秒数（数据是服务端本地时间，面板同机部署时直接可比） */
export function secondsSince(s: string | null): number | null {
  const d = parseLocal(s)
  if (!d || isNaN(d.getTime())) return null
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
