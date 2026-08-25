import 'dotenv/config'
import { Domain, LoggerLevel } from '@larksuiteoapi/node-sdk'

// 拆 import 副作用：这里不再 throw（缺 env 由 LarkService 构造器校验 → 插件 FAILED 而非 import 崩进程）。
// 非空断言仅用于类型收窄，运行时缺失时构造器会先抛错。

// 飞书开放平台 → 开发者后台 → 你的应用 →「凭证与基础信息」
export const LARK_APP_ID = process.env.LARK_APP_ID!
export const LARK_APP_SECRET = process.env.LARK_APP_SECRET!

// 国内版飞书 feishu（默认）；国际版 Lark 套件用 lark
export const LARK_DOMAIN = process.env.LARK_DOMAIN === 'lark' ? Domain.Lark : Domain.Feishu

export const LOGGER_LEVEL = LoggerLevel.error

export const larkBaseConfig = {
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  domain: LARK_DOMAIN,
  loggerLevel: LOGGER_LEVEL
}

export const larkHandlers = {
  onReady: () => console.log('[lark] ready'),
  onError: (error: Error) => console.error('[lark] error: ', error.message),
  onReconnecting: () => console.warn('[lark] reconnecting…'),
  onReconnected: () => console.log('[lark] reconnected')
}
