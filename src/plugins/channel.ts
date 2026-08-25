import type { Context } from 'cordis'

export default {
  name: 'channel',
  inject: ['lark'],
  apply(ctx: Context) {
    ctx.effect(() => {
      ctx.lark.start()
      return () => {
        ctx.lark.close()
      }
    })
  }
}
