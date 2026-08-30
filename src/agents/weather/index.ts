import type { Context } from 'cordis'
import tools from './tools'
import weatherSkill from './weather-skill'
import { FETCH_IMAGE_TOOL } from '@/plugins/lark-image'

/**
 * weather agent（demo）：注册 toy 工具 + weather skill，并组装默认 agent（skills 挂 weather）。
 * 加能力 = 新注册行 / 新注册插件，不用改 agent 核心。
 */
export default {
  name: 'agent-demo',
  inject: ['capability'],
  apply(ctx: Context) {
    for (const tool of tools) {
      ctx.capability.registerTool(tool)
    }
    ctx.capability.registerSkill(weatherSkill)
    ctx.capability.registerDefinition({
      id: 'weather',
      basePrompt: 'You are a helpful assistant. Always reply in Chinese (中文).',
      skills: [weatherSkill.name],
      // fetch_image 由 lark-image 插件注册；未装该插件时 collectTools 会跳过并 warn，不崩
      tools: [FETCH_IMAGE_TOOL]
    })
  }
}
