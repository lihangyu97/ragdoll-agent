import 'dotenv/config'
import { Context } from 'cordis'
import DatabaseService from '@/services/data/database/DatabaseService'
import ChannelStoreService from '@/services/data/channels/ChannelStoreService'

/**
 * 种子用户脚本：删库（rm data/agent.db*）后执行 `pnpm seed`，
 * 重建表结构并把 channel_users 的初始记录塞回去。
 * 幂等：channel + userId 已存在则刷新名字，可重复执行。
 */
const SEED_USERS = [
  // 飞书通讯录里的本人（open_id 来自 im.message.receive_v1 事件）
  { channel: 'lark', userId: 'ou_91869f5e371b7c238b2bf22f30687540', name: '李航宇' }
]

const ctx = new Context()
ctx.plugin(DatabaseService, { dbPath: process.env.RAGDOLL_DB_PATH ?? 'data/agent.db' })
await ctx.plugin(ChannelStoreService)

for (const user of SEED_USERS) {
  ctx.channelStore.upsertUser(user.channel, user.userId, user.name)
  console.log(`✅ 种子用户已写入: ${user.name} (${user.channel}/${user.userId})`)
}
