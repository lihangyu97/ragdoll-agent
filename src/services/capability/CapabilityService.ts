import { Service, type Context } from 'cordis'
import { z } from 'zod'
import { tool, type ClientTool } from '@langchain/core/tools'

declare module 'cordis' {
  interface Context {
    capability: CapabilityService
  }
  interface Events {
    // 组装期改写点：监听器签名 (prompt, definition, next)，调用 next() 取下游结果后再改写
    'agent/prompt-build': (
      prompt: string,
      definition: AgentDefinition,
      next: () => unknown
    ) => unknown
  }
}

/** 技能：可复用的任务指令包（与来源无关，P0 只支持代码注册） */
export interface Skill {
  name: string
  description: string
  /** 触发场景/关键词（进技能目录，帮助模型判断何时使用） */
  trigger?: string
  instructions: string
  /** 数据文件（如 FAQ 文本、模板），load_skill 时一并返回 */
  resources?: Record<string, string>
  /** 该技能约定使用的工具名（引用全局注册的工具，不自带） */
  tools?: string[]
}

/** 声明式组装规格：声明"要什么能力"，assemble 时拼成 AgentSpec 快照 */
export interface AgentDefinition {
  id: string
  basePrompt: string
  /** 具名 prompt 段（registerPrompt 注册），按顺序拼接 */
  personas?: string[]
  skills?: string[]
  /** catalog：只注入技能目录 + load_skill 懒加载（默认）；full：instructions 全量编译进 prompt */
  skillMode?: 'catalog' | 'full'
  tools?: string[]
}

/** 组装产物：agent 运行时按此快照构建 langchain agent */
export interface AgentSpec {
  systemPrompt: string
  tools: ClientTool[]
}

/** 内置默认定义兜底：不注册任何 definition 也能 assemble('default') */
const DEFAULT_DEFINITION: AgentDefinition = {
  id: 'default',
  basePrompt: 'You are a helpful assistant. Always reply in Chinese (中文).',
  skillMode: 'catalog'
}

/**
 * capability Service：agent 能力注册表 + 组装器（数据面）。
 * 注册 = 具名能力进注册表（version +1）；组装 = 按 AgentDefinition 产出 AgentSpec 快照。
 * 执行由 agent Service 消费快照懒构建 langchain agent，version 变更即失效重建。
 */
export default class CapabilityService extends Service {
  private readonly prompts = new Map<string, string>()
  private readonly tools = new Map<string, ClientTool>()
  private readonly skills = new Map<string, Skill>()
  private readonly definitions = new Map<string, AgentDefinition>()
  private _version = 0

  constructor(ctx: Context) {
    super(ctx, 'capability')
    this.definitions.set(DEFAULT_DEFINITION.id, DEFAULT_DEFINITION)
  }

  /** 注册表版本号：任何 register/unregister 递增，agent 据此失效重建运行时 */
  get version(): number {
    return this._version
  }

  registerPrompt(name: string, prompt: string) {
    this.assertUnique(this.prompts, name, 'prompt')
    this.prompts.set(name, prompt)
    this._version++
  }

  unregisterPrompt(name: string) {
    this.assertExists(this.prompts, name, 'prompt')
    this.prompts.delete(name)
    this._version++
  }

  registerTool(tool: ClientTool) {
    this.assertUnique(this.tools, tool.name, 'tool')
    this.tools.set(tool.name, tool)
    this._version++
  }

  unregisterTool(name: string) {
    this.assertExists(this.tools, name, 'tool')
    this.tools.delete(name)
    this._version++
  }

  registerSkill(skill: Skill) {
    this.assertUnique(this.skills, skill.name, 'skill')
    this.skills.set(skill.name, skill)
    this._version++
  }

  unregisterSkill(name: string) {
    this.assertExists(this.skills, name, 'skill')
    this.skills.delete(name)
    this._version++
  }

  /** 同一 id 重复注册 = 覆盖（内置 default 定义可被业务定义替换） */
  registerDefinition(def: AgentDefinition) {
    this.definitions.set(def.id, def)
    this._version++
  }

  unregisterDefinition(id: string) {
    if (!this.definitions.delete(id)) {
      throw new Error(`[capability] definition 不存在: ${id}`)
    }
    this._version++
  }

  /** 组装 AgentSpec 快照：systemPrompt（分层组装 + waterfall 改写点）+ tools（直挂 + skill 引用 + load_skill） */
  async assemble(def: string | AgentDefinition = 'default'): Promise<AgentSpec> {
    const definition = typeof def === 'string' ? this.getDefinition(def) : def
    const systemPrompt = await this.buildSystemPrompt(definition)
    const tools = this.collectTools(definition)
    return { systemPrompt, tools }
  }

  private getDefinition(id: string): AgentDefinition {
    const def = this.definitions.get(id)
    if (!def) throw new Error(`[capability] definition 不存在: ${id}`)
    return def
  }

  private getPrompt(name: string): string {
    const prompt = this.prompts.get(name)
    if (!prompt) throw new Error(`[capability] prompt 不存在: ${name}`)
    return prompt
  }

  private getTool(name: string): ClientTool {
    const t = this.tools.get(name)
    if (!t) throw new Error(`[capability] tool 不存在: ${name}`)
    return t
  }

  private getSkill(name: string): Skill {
    const skill = this.skills.get(name)
    if (!skill) throw new Error(`[capability] skill 不存在: ${name}`)
    return skill
  }

  private async buildSystemPrompt(def: AgentDefinition): Promise<string> {
    const parts: string[] = [def.basePrompt]

    for (const name of def.personas ?? []) {
      parts.push(this.getPrompt(name))
    }

    if (def.skills?.length) {
      if (def.skillMode === 'full') {
        for (const name of def.skills) {
          const skill = this.getSkill(name)
          parts.push(`## 技能：${skill.name}\n\n${skill.instructions}`)
        }
      } else {
        const lines = ['## 可用技能\n\n需要时调用 load_skill(name) 加载技能详细说明：']
        for (const name of def.skills) {
          const skill = this.getSkill(name)
          const trigger = skill.trigger ? `（触发：${skill.trigger}）` : ''
          lines.push(`- ${skill.name}：${skill.description}${trigger}`)
        }
        parts.push(lines.join('\n'))
      }
    }

    const built = parts.join('\n\n')

    // 组装期改写点：插件可经 ctx.waterfall('agent/prompt-build', ...) 追加/改写 systemPrompt
    return (await this.ctx.waterfall('agent/prompt-build', built, def, () => built)) as string
  }

  private collectTools(def: AgentDefinition): ClientTool[] {
    const tools: ClientTool[] = []
    const seen = new Set<string>()
    const add = (t: ClientTool) => {
      if (!seen.has(t.name)) {
        seen.add(t.name)
        tools.push(t)
      }
    }

    for (const name of def.tools ?? []) add(this.getTool(name))
    for (const skillName of def.skills ?? []) {
      for (const toolName of this.getSkill(skillName).tools ?? []) {
        add(this.getTool(toolName))
      }
    }

    // catalog 模式：注入 load_skill 懒加载工具
    if ((def.skillMode ?? 'catalog') === 'catalog' && def.skills?.length) {
      add(this.createLoadSkillTool())
    }

    return tools
  }

  private createLoadSkillTool(): ClientTool {
    return tool(async ({ name }: { name: string }) => this.renderSkill(name), {
      name: 'load_skill',
      description: '加载技能详细说明（技能名从系统提示的"可用技能"目录中选取）',
      schema: z.object({ name: z.string().describe('技能名') })
    })
  }

  /** load_skill 实现：返回技能全文（instructions + resources）；技能不存在时返回可恢复提示，不 throw，模型可自行纠正 */
  private renderSkill(name: string): string {
    const skill = this.skills.get(name)
    if (!skill) {
      return `未找到技能：${name}。可用技能：${[...this.skills.keys()].join('、') || '无'}。`
    }
    const lines = [`# 技能：${skill.name}`, skill.instructions]
    for (const [key, value] of Object.entries(skill.resources ?? {})) {
      lines.push(`## 资源：${key}\n\n${value}`)
    }
    return lines.join('\n\n')
  }

  private assertUnique(map: Map<string, unknown>, name: string, kind: string) {
    if (map.has(name)) {
      throw new Error(`[capability] ${kind} 已存在: ${name}`)
    }
  }

  private assertExists(map: Map<string, unknown>, name: string, kind: string) {
    if (!map.has(name)) {
      throw new Error(`[capability] ${kind} 不存在: ${name}`)
    }
  }
}
