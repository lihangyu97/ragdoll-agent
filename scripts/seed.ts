import 'dotenv/config'
import { Context } from 'cordis'
import DatabaseService from '@/services/data/database/DatabaseService'
import ChannelLarkService from '@/services/data/channel-lark/ChannelLarkService'

/**
 * 种子用户脚本：删库（rm data/agent.db*）后执行 `pnpm seed`，
 * 重建表结构并把 channel_lark_user 的初始记录塞回去。
 * 幂等：open_id 已存在则刷新名字，可重复执行。
 */
const SEED_USERS = [
  // 飞书通讯录里的本人（open_id 来自 im.message.receive_v1 事件）
  { openId: 'ou_91869f5e371b7c238b2bf22f30687540', name: '李航宇' }
]

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: process.env.DB_PATH ?? 'data/agent.db' })
await ctx.plugin(ChannelLarkService)

for (const user of SEED_USERS) {
  ctx.channelLark.upsertUser(user.openId, user.name)
  console.log(`✅ 种子用户已写入: ${user.name} (${user.openId})`)
}
