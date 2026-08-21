import { initSchema } from '@sqlite/base/schema'
import { upsertUser } from '@sqlite/channelLark'

/**
 * 种子用户脚本：删库（rm data/agent.db*）后执行 `pnpm seed`，
 * 重建表结构并把 channel_lark_user 的初始记录塞回去。
 * 幂等：open_id 已存在则刷新名字，可重复执行。
 */
const SEED_USERS = [
  // 飞书通讯录里的本人（open_id 来自 im.message.receive_v1 事件）
  { openId: 'ou_91869f5e371b7c238b2bf22f30687540', name: '李航宇' }
]

initSchema()

for (const user of SEED_USERS) {
  upsertUser(user.openId, user.name)
  console.log(`✅ 种子用户已写入: ${user.name} (${user.openId})`)
}
