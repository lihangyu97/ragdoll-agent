type PlainVal = string | number | ((...arg: any) => any)

export function assign(...args: Record<string, PlainVal>[]) {
  return Object.assign({}, ...args)
}

export function stringify(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    return value.stack ? `${value.message}\n${value.stack}` : value.message
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
