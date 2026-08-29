import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { z } from 'zod'
import type { Context } from 'cordis'
import logger from '@/utils/logger'
import { TRACE_STATUS, type TraceStatus } from '@/services/data/database/schema'

const PanelPluginConfig = z.object({
  /** HTTP 端口 */
  port: z.number().default(3111)
})

/**
 * panel 插件：面板 HTTP 服务（/api 只读查询 + panel/dist 静态托管）。
 * 数据经 PanelService（只读），不碰任何写入路径。前端开发模式：
 * `pnpm --filter ragdoll-panel dev`（vite 把 /api 代理到本服务），生产：`pnpm --filter ragdoll-panel build` 后由本插件托管。
 */
export default {
  name: 'panel',
  inject: ['panel'],
  Config: PanelPluginConfig,
  apply(ctx: Context, config: z.infer<typeof PanelPluginConfig>) {
    const app = new Hono()

    app.get('/api/overview', c => c.json(ctx.panel.getOverview()))

    app.get('/api/traces', c => {
      const status = c.req.query('status')
      if (status && !Object.values(TRACE_STATUS).includes(status as TraceStatus)) {
        return c.json({ error: `非法 status: ${status}` }, 400)
      }
      const limit = Math.min(Number(c.req.query('limit')) || 100, 500)
      return c.json(ctx.panel.listTraces(status as TraceStatus | undefined, limit))
    })

    app.get('/api/threads', c => c.json(ctx.panel.listThreads()))

    app.get('/api/threads/:threadId/turns', c =>
      c.json(ctx.panel.getTurns(c.req.param('threadId')))
    )

    app.get('/api/logs', c => {
      const limit = Math.min(Number(c.req.query('limit')) || 200, 1000)
      return c.json(
        ctx.panel.listLogs({
          level: c.req.query('level'),
          threadId: c.req.query('threadId'),
          limit
        })
      )
    })

    if (!existsSync('panel/dist')) {
      logger.warn(
        '[panel] panel/dist 不存在，前端未构建（pnpm --filter ragdoll-panel build），页面请求将 404'
      )
    }
    app.use('*', serveStatic({ root: './panel/dist' }))
    // SPA 兜底：非 /api 路径全回 index.html
    app.get('*', serveStatic({ path: './panel/dist/index.html' }))

    const server = serve({ fetch: app.fetch, port: config.port }, info => {
      logger.info(`[panel] http://localhost:${info.port}`)
    })
    ctx.effect(() => () => server.close())
  }
}
