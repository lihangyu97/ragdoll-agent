import 'dotenv/config'
import { Domain } from '@larksuiteoapi/node-sdk'

if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
  throw new Error('缺少飞书配置：请检查 LARK_APP_ID LARK_APP_SECRET')
}

// 飞书开放平台 → 开发者后台 → 你的应用 →「凭证与基础信息」
export const LARK_APP_ID = process.env.LARK_APP_ID
export const LARK_APP_SECRET = process.env.LARK_APP_SECRET

// 国内版飞书 feishu（默认）；国际版 Lark 套件用 lark
export const LARK_DOMAIN = process.env.LARK_DOMAIN === 'lark' ? Domain.Lark : Domain.Feishu
