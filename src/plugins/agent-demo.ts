import type { Context } from 'cordis'
import _tools from '@/toy/tools'
import _systemPrompt from '@/toy/systemPrompt'

/**
 * demo 插件：加载即把 toy 的工具/提示词注册进 agent Service（启动装配期一次性注册）。
 * 后续加工具 = 新增插件 + 配一行，不用改 agent 核心。
 */
export default {
  name: 'agent-demo',
  inject: ['agent'],
  apply(ctx: Context) {
    ctx.agent.registerTools(_tools)
    ctx.agent.setSystemPrompt(_systemPrompt)
  }
}
