import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { Context } from 'cordis'
import type { Skill } from '@/services/agent/capability/CapabilityService'
import logger from '@/utils/logger'

/**
 * skill-loader 插件：从 skillsRoot 扫描 agentskills.io 标准格式的技能目录
 * （<name>/SKILL.md + 可选 references/ assets/ scripts/），校验后注册进 capability。
 *
 * 标准格式与内部 Skill 的映射：
 * - name / description / SKILL.md 正文 → Skill.name / description / instructions
 * - references/ + assets/ 文本文件 → Skill.resources（key = 相对路径）
 * - scripts/ 文件 → Skill.scripts（仅索引路径，执行能力后续再加）
 * - license / compatibility / metadata → Skill 宿主侧字段（存而不渲染，不进 prompt）
 *
 * 校验（对齐规范）：name 仅小写字母/数字/连字符、须等于目录名、description 非空、
 * 正文非空。不合规的技能记 warn 跳过，不炸启动。同名冲突：文件版覆盖代码注册版。
 */

/** 规范约束：name 1-64 字符，仅小写字母/数字/连字符，首尾不能是连字符，不能有连续连字符 */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_NAME = 64
const MAX_DESCRIPTION = 1024
/** 单资源文件读取上限（跳过超大文件，防止把仓库灌进内存/上下文） */
const MAX_RESOURCE_BYTES = 1_000_000

export interface LoadResult {
  loaded: string[]
  skipped: { name: string; reason: string }[]
}

/**
 * 解析 SKILL.md：YAML frontmatter + Markdown 正文。
 * 无合法 frontmatter（必须以 --- 开头）返回 null。
 */
export function parseSkillFile(
  content: string
): { frontmatter: Record<string, unknown>; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = parseYaml(match[1] ?? '')
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  return { frontmatter: parsed as Record<string, unknown>, body: content.slice(match[0].length) }
}

/** 校验 frontmatter 并归一化为内部 Skill；不合规返回 { error } */
export function skillFromFile(
  dirName: string,
  content: string
): { skill: Skill } | { error: string } {
  const parsed = parseSkillFile(content)
  if (!parsed) return { error: 'SKILL.md 缺少 YAML frontmatter（需 --- 开头）' }
  const { frontmatter: fm, body } = parsed

  const name = fm.name
  const description = fm.description
  const license = fm.license
  const compatibility = fm.compatibility
  const metadata = fm.metadata

  if (typeof name !== 'string' || !name) return { error: 'frontmatter 缺少 name' }
  if (name.length > MAX_NAME || !NAME_RE.test(name)) {
    return {
      error: `name 不合法（${name}）：需 1-${MAX_NAME} 字符，仅小写字母/数字/连字符，首尾不能是连字符`
    }
  }
  if (name !== dirName) return { error: `name（${name}）与目录名（${dirName}）不一致` }
  if (typeof description !== 'string' || !description.trim()) {
    return { error: 'frontmatter 缺少 description' }
  }
  if (description.length > MAX_DESCRIPTION)
    return { error: `description 超过 ${MAX_DESCRIPTION} 字符` }
  if (!body.trim()) return { error: 'SKILL.md 正文为空' }
  if (license !== undefined && typeof license !== 'string') return { error: 'license 必须是字符串' }
  if (compatibility !== undefined && typeof compatibility !== 'string') {
    return { error: 'compatibility 必须是字符串' }
  }
  if (
    metadata !== undefined &&
    (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
  ) {
    return { error: 'metadata 必须是 key-value 映射' }
  }

  const skill: Skill = {
    name,
    description: description.trim(),
    instructions: body.trim(),
    source: 'file',
    ...(typeof license === 'string' ? { license } : {}),
    ...(typeof compatibility === 'string' ? { compatibility } : {}),
    ...(typeof metadata === 'object' && metadata !== null
      ? { metadata: metadata as Record<string, string> }
      : {})
  }
  return { skill }
}

/** 递归收集目录下文件相对路径（目录不存在 → 空；跳过隐藏项） */
async function collectFiles(dir: string, rel: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await collectFiles(join(dir, entry.name), entryRel, out)
    } else {
      out.push(entryRel)
    }
  }
}

/** 读取文本资源；超大/二进制/读取失败 → null（跳过） */
async function readTextOrNull(abs: string): Promise<string | null> {
  try {
    const info = await stat(abs)
    if (info.size > MAX_RESOURCE_BYTES) return null
    const content = await readFile(abs, 'utf-8')
    if (content.includes('\u0000')) return null
    return content
  } catch {
    return null
  }
}

/** 加载单个技能目录（SKILL.md + 资源/脚本索引），返回内部 Skill 或跳过原因 */
async function loadSkillDir(
  root: string,
  dirName: string
): Promise<{ skill: Skill } | { error: string }> {
  const skillDir = join(root, dirName)
  let content: string
  try {
    content = await readFile(join(skillDir, 'SKILL.md'), 'utf-8')
  } catch {
    return { error: '缺少 SKILL.md' }
  }

  const parsed = skillFromFile(dirName, content)
  if ('error' in parsed) return parsed

  const refs: string[] = []
  const assets: string[] = []
  const scripts: string[] = []
  await collectFiles(join(skillDir, 'references'), 'references', refs)
  await collectFiles(join(skillDir, 'assets'), 'assets', assets)
  await collectFiles(join(skillDir, 'scripts'), 'scripts', scripts)

  const resources: Record<string, string> = {}
  // scripts 内容也进 resources（模型可读）；执行能力 P2 再上
  for (const rel of [...refs, ...assets, ...scripts]) {
    const text = await readTextOrNull(join(skillDir, rel))
    if (text !== null) resources[rel] = text
  }

  const skill: Skill = {
    ...parsed.skill,
    ...(Object.keys(resources).length ? { resources } : {}),
    ...(scripts.length ? { scripts } : {})
  }
  return { skill }
}

/** 扫描 skillsRoot 下全部技能目录，逐个调 register 注册；返回加载/跳过汇总 */
export async function loadSkillsFromDir(
  root: string,
  register: (skill: Skill) => void
): Promise<LoadResult> {
  const result: LoadResult = { loaded: [], skipped: [] }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return result // 目录不存在 → 空
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const out = await loadSkillDir(root, entry.name)
    if ('error' in out) {
      result.skipped.push({ name: entry.name, reason: out.error })
      continue
    }
    register(out.skill)
    result.loaded.push(entry.name)
  }
  return result
}

const SkillLoaderConfig = z.object({
  /** 技能根目录（默认 skills，相对 process.cwd() 解析） */
  skillsRoot: z.string().default('skills')
})

export default {
  name: 'skill-loader',
  inject: ['capability'],
  Config: SkillLoaderConfig,
  async apply(ctx: Context, config: z.infer<typeof SkillLoaderConfig>) {
    const result = await loadSkillsFromDir(config.skillsRoot, skill => {
      if (ctx.capability.hasSkill(skill.name)) {
        logger.warn(`[skill-loader] 同名技能已存在（代码注册），文件版覆盖: ${skill.name}`)
        ctx.capability.unregisterSkill(skill.name)
      }
      ctx.capability.registerSkill(skill)
    })

    if (result.loaded.length) {
      logger.info(`[skill-loader] 加载 ${result.loaded.length} 个技能: ${result.loaded.join('、')}`)
    }
    for (const s of result.skipped) {
      logger.warn(`[skill-loader] 跳过技能 ${s.name}: ${s.reason}`)
    }
  }
}
