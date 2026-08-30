import type { Context } from 'cordis'
import tools from './tools'
import homeSkill from './home-skill'

/**
 * home agent（demo）：注册家居设备 toy 工具 + home skill，并组装 home agent（skills 挂 home）。
 * 加能力 = 新注册行 / 新注册插件，不用改 agent 核心。
 */
export default {
  name: 'agent-home',
  inject: ['capability'],
  apply(ctx: Context) {
    for (const tool of tools) {
      ctx.capability.registerTool(tool)
    }
    ctx.capability.registerSkill(homeSkill)
    ctx.capability.registerDefinition({
      id: 'home',
      basePrompt: '你是一个智能家居助手，帮助用户控制灯和风扇等设备，回答使用中文',
      skills: [homeSkill.name]
    })
  }
}
