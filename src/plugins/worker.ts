import type { Context } from 'cordis'

export default {
  name: 'worker',
  inject: ['worker'],
  apply(ctx: Context) {
    ctx.effect(() => {
      ctx.worker.start()
      return () => {
        ctx.worker.stop()
      }
    })
  }
}
