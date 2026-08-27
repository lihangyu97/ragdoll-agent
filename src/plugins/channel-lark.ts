import type { Context } from 'cordis'

/** 装配 lark 渠道：注册 adapter 到 channel Service + 生命周期（start/stop 由 effect 管理） */
export default {
  name: 'channel-lark',
  inject: ['channel', 'larkAdapter'],
  apply(ctx: Context) {
    ctx.channel.register(ctx.larkAdapter)
    ctx.effect(async () => {
      await ctx.larkAdapter.start()
      return () => {
        ctx.larkAdapter.stop()
      }
    })
  }
}
