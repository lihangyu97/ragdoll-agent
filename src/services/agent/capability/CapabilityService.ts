import { Service, type Context } from 'cordis'
import { z } from 'zod'
import { tool, type ClientTool } from '@langchain/core/tools'
import { execFile } from 'node:child_process'
import { extname, join } from 'node:path'
import { createSystemTools, type SystemToolsOptions } from './systemTools'

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

/** 技能：可复用的任务指令包（与来源无关：代码注册 / 文件加载（agentskills.io 标准格式）） */
export interface Skill {
  name: string
  description: string
  /** 触发场景/关键词（进技能目录，帮助模型判断何时使用）；标准格式技能无此字段则省略 */
  trigger?: string
  instructions: string
  /** 数据文件（如 FAQ 文本、模板），load_skill 时一并返回 */
  resources?: Record<string, string>
  /** 该技能约定使用的工具名（引用全局注册的工具，不自带） */
  tools?: string[]
  /** 技能来源：'code'（registerSkill 注册）| 'file'（skill-loader 从 skillsRoot 扫描） */
  source?: 'code' | 'file'
  /**
   * 以下为宿主侧信息（agentskills.io 标准格式字段），**不进 prompt**：
   * catalog 目录行 / full 注入 / load_skill 返回都不渲染，仅存储供宿主校验与来源追踪。
   */
  /** License（如 Apache-2.0） */
  license?: string
  /** 环境要求（宿主加载时对照本机环境检查用，当前仅存储） */
  compatibility?: string
  /** 任意键值元数据（作者/版本等，来源追踪/调试用） */
  metadata?: Record<string, string>
  /** scripts/ 下可执行文件路径索引（内容同时进 resources 供读取；run_skill_script 按此白名单执行） */
  scripts?: string[]
  /** 技能目录绝对路径（文件技能由 skill-loader 填充；run_skill_script 执行 scripts 用，宿主侧不渲染） */
  root?: string
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

/** run_skill_script 可执行脚本的解释器白名单（按扩展名） */
const SCRIPT_INTERPRETERS: Record<string, string> = {
  '.sh': 'bash',
  '.bash': 'bash',
  '.py': 'python3',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node'
}

/** 脚本输出截断长度（控制 token 占用） */
const MAX_OUTPUT_CHARS = 4000

/** capability 构造参数（cordis 按 Config 校验后传入；systemTools 选项 + 技能脚本开关） */
interface CapabilityOptions extends SystemToolsOptions {
  /** 是否启用 run_skill_script（执行技能 scripts/ 脚本；默认关） */
  enableSkillScripts?: boolean
}

/**
 * capability Service：agent 能力注册表 + 组装器（数据面）。
 * 注册 = 具名能力进注册表（version +1）；组装 = 按 AgentDefinition 产出 AgentSpec 快照。
 * 执行由 agent Service 消费快照懒构建 langchain agent，version 变更即失效重建。
 * 系统工具（read_file/write_file/list_dir/glob/grep/edit_file/run_command）构造时 seed，
 * 平台执行原语，assemble 自动并入每个 agent，与领域工具隔离（不可注册同名、不可注销）。
 */
export default class CapabilityService extends Service {
  static Config = z
    .object({
      /** 文件工具沙箱根目录（默认 data/workspace，相对 process.cwd() 解析） */
      root: z.string().optional(),
      /** run_command 工作目录（默认 process.cwd()） */
      cwd: z.string().optional(),
      /** run_command 命令白名单前缀（默认空 = 禁用 run_command） */
      commands: z.array(z.string()).optional(),
      /** run_command 超时（毫秒，默认 30s） */
      timeoutMs: z.number().optional(),
      /** 是否启用 run_skill_script（执行技能 scripts/ 脚本；默认 false，构造器兜底） */
      enableSkillScripts: z.boolean().optional()
    })
    .default({})

  private readonly prompts = new Map<string, string>()
  private readonly tools = new Map<string, ClientTool>()
  private readonly skills = new Map<string, Skill>()
  private readonly definitions = new Map<string, AgentDefinition>()
  private readonly systemTools = new Map<string, ClientTool>()
  private readonly enableSkillScripts: boolean
  private readonly timeoutMs: number
  private _version = 0

  constructor(ctx: Context, options: CapabilityOptions = {}) {
    super(ctx, 'capability')
    // 构造器参数形状与 Config 一致（cordis 已按 Config 校验后传入），未配置的项在 createSystemTools 里落默认值
    for (const t of createSystemTools(options)) {
      this.systemTools.set(t.name, t)
    }
    this.enableSkillScripts = options.enableSkillScripts ?? false
    this.timeoutMs = options.timeoutMs ?? 30_000
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
    if (this.systemTools.has(tool.name)) {
      throw new Error(`[capability] tool 与系统工具重名: ${tool.name}`)
    }
    this.assertUnique(this.tools, tool.name, 'tool')
    this.tools.set(tool.name, tool)
    this._version++
  }

  unregisterTool(name: string) {
    if (this.systemTools.has(name)) {
      throw new Error(`[capability] 系统工具不可注销: ${name}`)
    }
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

  /** skill 是否存在（skill-loader 冲突策略用：同名文件技能覆盖代码技能） */
  hasSkill(name: string): boolean {
    return this.skills.has(name)
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

  /** 已注册的全部 AgentDefinition（路由识别 / 管理用） */
  listDefinitions(): AgentDefinition[] {
    return [...this.definitions.values()]
  }

  /** definition 是否存在（路由识别结果校验用，防止识别到不存在的 agent） */
  hasDefinition(id: string): boolean {
    return this.definitions.has(id)
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

    if (def.skillMode === 'full') {
      // full 模式保持 opt-in：只把 def.skills 显式声明的技能 instructions 编译进 prompt
      for (const name of def.skills ?? []) {
        const skill = this.getSkill(name)
        parts.push(`## 技能：${skill.name}\n\n${skill.instructions}`)
      }
    } else if (this.skills.size > 0) {
      // catalog 模式注册表驱动：列出全部已注册技能（代码注册 + 文件技能），
      // 往 skills/ 丢一个技能即对所有 catalog 模式的 agent 可发现（load_skill 同源）
      const lines = ['## 可用技能\n\n需要时调用 load_skill(name) 加载技能详细说明：']
      for (const skill of this.skills.values()) {
        const trigger = skill.trigger ? `（触发：${skill.trigger}）` : ''
        lines.push(`- ${skill.name}：${skill.description}${trigger}`)
      }
      parts.push(lines.join('\n'))
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

    // 系统工具 = 平台执行原语，默认进所有 agent（安全收口交给 P1 guardrails）
    for (const t of this.systemTools.values()) add(t)
    for (const name of def.tools ?? []) add(this.getTool(name))
    for (const skillName of def.skills ?? []) {
      for (const toolName of this.getSkill(skillName).tools ?? []) {
        add(this.getTool(toolName))
      }
    }

    // catalog 模式：注册表有技能即注入 load_skill（与目录行同源，文件技能无需 definition 引用）
    if ((def.skillMode ?? 'catalog') === 'catalog' && this.skills.size > 0) {
      add(this.createLoadSkillTool())
    }

    // 技能脚本执行（显式开关，默认关）
    if (this.enableSkillScripts) {
      add(this.createRunSkillScriptTool())
    }

    return tools
  }

  private createLoadSkillTool(): ClientTool {
    return tool(
      async ({ name, resource }: { name: string; resource?: string }) =>
        this.renderSkill(name, resource),
      {
        name: 'load_skill',
        description:
          '加载技能详细说明（技能名从系统提示的"可用技能"目录中选取）。不传 resource 返回技能说明与可加载文件索引；传 resource（如 references/REFERENCE.md）返回该文件内容。',
        schema: z.object({
          name: z.string().describe('技能名'),
          resource: z
            .string()
            .optional()
            .describe(
              '技能文件相对路径（从 load_skill 返回的文件索引中选取），不传则只返回说明与索引'
            )
        })
      }
    )
  }

  /**
   * load_skill 实现（渐进披露，对齐 agentskills.io 规范）：
   * - 不传 resource：技能说明 + 可加载文件索引（不内联文件内容，省 token）
   * - 传 resource：返回该文件内容
   * 技能/文件不存在时返回可恢复提示，不 throw，模型可自行纠正。
   */
  private renderSkill(name: string, resource?: string): string {
    const skill = this.skills.get(name)
    if (!skill) {
      return `未找到技能：${name}。可用技能：${[...this.skills.keys()].join('、') || '无'}。`
    }
    const files = this.skillFileIndex(skill)

    if (resource) {
      const content = skill.resources?.[resource]
      if (content === undefined) {
        return `技能 ${name} 没有文件：${resource}。可加载文件：${files.join('、') || '无'}。`
      }
      return `# 技能：${skill.name} › ${resource}\n\n${content}`
    }

    const lines = [`# 技能：${skill.name}`, skill.instructions]
    if (files.length) {
      lines.push(
        `## 文件\n\n需要时用 load_skill(name, resource) 加载具体文件内容：\n${files
          .map(f => `- ${f}`)
          .join('\n')}`
      )
    }
    return lines.join('\n\n')
  }

  /** 技能可加载文件索引（references/ assets/ scripts/ 下文本文件；scripts 可读暂不可执行） */
  private skillFileIndex(skill: Skill): string[] {
    return Object.keys(skill.resources ?? {})
  }

  private createRunSkillScriptTool(): ClientTool {
    return tool(
      async ({ skill, script }: { skill: string; script: string }) =>
        this.runSkillScript(skill, script),
      {
        name: 'run_skill_script',
        description:
          '执行技能 scripts/ 目录下的脚本（技能名 + scripts/ 下相对路径，从 load_skill 返回的文件索引中选取）。' +
          '仅限该技能目录内的脚本，解释器白名单：bash/sh、python3、node，有超时限制。',
        schema: z.object({
          skill: z.string().describe('技能名（从系统提示的"可用技能"目录中选取）'),
          script: z.string().describe('技能 scripts/ 下脚本的相对路径，如 scripts/summarize.sh')
        })
      }
    )
  }

  /**
   * run_skill_script 实现：仅执行技能 scripts/ 白名单索引内的脚本。
   * 路径锁定（索引即白名单）+ 解释器白名单 + 超时 + 输出截断；
   * 与 run_command 相同，只是演示级护栏，真隔离需 OS 沙箱/容器。
   */
  private async runSkillScript(skillName: string, script: string): Promise<string> {
    const skill = this.skills.get(skillName)
    if (!skill) {
      return `未找到技能：${skillName}。可用技能：${[...this.skills.keys()].join('、') || '无'}。`
    }
    if (!skill.root || !skill.scripts?.includes(script)) {
      return `技能 ${skillName} 不可执行：${script}。可执行文件（scripts/ 下）：${
        skill.scripts?.join('、') || '无'
      }。`
    }
    const interpreter = SCRIPT_INTERPRETERS[extname(script)]
    if (!interpreter) {
      return `不支持脚本类型：${script}。支持：.sh/.bash（bash）、.py（python3）、.js/.mjs/.cjs（node）。`
    }

    try {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
        (resolveExec, rejectExec) => {
          // execFile 不走 shell，参数数组传递，无命令注入面
          execFile(
            interpreter,
            [join(skill.root!, script)],
            { cwd: skill.root!, timeout: this.timeoutMs, maxBuffer: 1_000_000 },
            (error, stdout, stderr) => {
              if (error) rejectExec(Object.assign(error, { stdout, stderr }))
              else resolveExec({ stdout, stderr })
            }
          )
        }
      )
      const out = `${stdout}${stderr}`.trim() || '(无输出)'
      return out.length > MAX_OUTPUT_CHARS
        ? `${out.slice(0, MAX_OUTPUT_CHARS)}\n…[输出已截断]`
        : out
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean }
      const detail = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message
      return `[skill-script] 执行失败: ${detail.slice(0, MAX_OUTPUT_CHARS)}${
        e.killed ? '（超时被终止）' : ''
      }`
    }
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
