type PlainVal = string | number | ((...arg: any) => any)

export const assign = (...args: Record<string, PlainVal>[]) => Object.assign({}, ...args)
