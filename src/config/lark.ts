import 'dotenv/config'
import { Domain, LoggerLevel } from '@larksuiteoapi/node-sdk'

if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
  throw new Error('缺少飞书配置：请检查 LARK_APP_ID LARK_APP_SECRET')
}

// 飞书开放平台 → 开发者后台 → 你的应用 →「凭证与基础信息」
export const LARK_APP_ID = process.env.LARK_APP_ID
export const LARK_APP_SECRET = process.env.LARK_APP_SECRET

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
