import { tool, type ClientTool } from '@langchain/core/tools'
import { z } from 'zod'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { exec } from 'node:child_process'

export interface SystemToolsOptions {
  /** 文件工具沙箱根目录（默认 data/workspace，相对 process.cwd() 解析） */
  root?: string
  /** run_command 工作目录（默认 process.cwd()） */
  cwd?: string
  /** run_command 命令白名单前缀（默认空 = 禁用 run_command） */
  commands?: string[]
  /** run_command 超时（毫秒，默认 30s） */
  timeoutMs?: number
}

/** 单次读取/返回的最大字符数（控制 token 占用，超长用 offset 续读） */
const MAX_CHARS = 4000
/** 搜索结果条数上限 */
const MAX_RESULTS = 100
/** 遍历时跳过的目录/文件（仓库噪音） */
const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.DS_Store'])

/**
 * 系统级工具（平台执行原语）：任何 agent 天生可用，与业务/领域无关。
 * 由 CapabilityService 构造时 seed，assemble 自动并入每个 agent。
 * 注意：沙箱路径校验 + 命令白名单只是演示级护栏，不是真正的安全边界（真边界 = OS 沙箱/容器）。
 * todo：tools_call 前后 hook，拦截敏感操作
 */
export function createSystemTools(options: SystemToolsOptions = {}): ClientTool[] {
  const root = resolve(options.root ?? 'data/workspace')
  const cwd = resolve(options.cwd ?? process.cwd())
  const commands = options.commands ?? []
  const timeoutMs = options.timeoutMs ?? 30_000

  // 确保沙箱根存在（write_file 会建子目录，但根目录本身要预建）
  mkdirSync(root, { recursive: true })

  /** 沙箱路径校验：输入相对 root 解析，禁止越界（含绝对路径/../ 逃逸） */
  const safePath = (input: string): string => {
    const abs = resolve(root, input)
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`[system-tool] 路径越界（仅允许 ${root} 内）: ${input}`)
    }
    return abs
  }

  /** 收集目录树内全部相对路径（跳过 IGNORED 与隐藏项） */
  const collectFiles = async (dir: string, rel: string, out: string[]): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      const abs = resolve(dir, entry.name)
      if (entry.isDirectory()) await collectFiles(abs, entryRel, out)
      else out.push(entryRel)
    }
  }

  /** glob 段匹配：** 匹配任意层级，* 匹配单段内任意字符 */
  const matchPattern = (relPath: string, pattern: string): boolean => {
    const segs = relPath.split('/')
    const pats = pattern.split('/')
    const segRe = (seg: string) =>
      new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
    const matchSegs = (s: string[], p: string[]): boolean => {
      if (p.length === 0) return s.length === 0
      const head = p[0]!
      if (head === '**') {
        for (let i = 0; i <= s.length; i++) {
          if (matchSegs(s.slice(i), p.slice(1))) return true
        }
        return false
      }
      if (s.length === 0) return false
      return segRe(head).test(s[0]!) && matchSegs(s.slice(1), p.slice(1))
    }
    return matchSegs(segs, pats)
  }

  const readFileTool = tool(
    async ({ path, offset = 0 }: { path: string; offset?: number }) => {
      const abs = safePath(path)
      const info = await stat(abs)
      if (!info.isFile()) return `[system-tool] 不是文件: ${path}`
      const content = await readFile(abs, 'utf-8')
      const slice = content.slice(offset, offset + MAX_CHARS)
      const truncated = content.length > offset + MAX_CHARS
      return truncated
        ? `${slice}\n…[已截断：共 ${content.length} 字符，用 offset=${offset + MAX_CHARS} 继续读]`
        : slice
    },
    {
      name: 'read_file',
      description:
        '读取文件内容（UTF-8）。默认返回前 4000 字符，大文件用 offset 参数继续读（返回里会提示下一个 offset）。',
      schema: z.object({
        path: z.string().describe('相对沙箱根目录的文件路径'),
        offset: z.number().int().min(0).optional().describe('从第几个字符开始读')
      })
    }
  )

  const writeFileTool = tool(
    async ({ path, content }: { path: string; content: string }) => {
      const abs = safePath(path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf-8')
      return `已写入 ${path}（${content.length} 字符）`
    },
    {
      name: 'write_file',
      description:
        '写入/覆盖文件（UTF-8，自动创建父目录）。用于新建文件或整体重写小文件；修改大文件请用 edit_file。',
      schema: z.object({
        path: z.string().describe('相对沙箱根目录的文件路径'),
        content: z.string().describe('完整文件内容')
      })
    }
  )

  const listDirTool = tool(
    async ({ path = '.', depth = 2 }: { path?: string; depth?: number }) => {
      const abs = safePath(path)
      const lines: string[] = []
      const walk = async (dir: string, rel: string, level: number): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true })
        entries.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
          if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
          const entryRel = rel === '.' ? entry.name : `${rel}/${entry.name}`
          lines.push(entry.isDirectory() ? `${entryRel}/` : entryRel)
          if (entry.isDirectory() && level < depth) {
            await walk(resolve(dir, entry.name), entryRel, level + 1)
          }
        }
      }
      try {
        await walk(abs, relative(root, abs) || '.', 0)
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'ENOENT') return `[system-tool] 目录不存在: ${path}`
        throw err
      }
      return lines.join('\n') || '(空目录)'
    },
    {
      name: 'list_dir',
      description:
        '列出目录内容（跳过 node_modules/.git 等噪音）。depth 控制子目录递归层数，默认 2，最大 4。',
      schema: z.object({
        path: z.string().optional().describe('相对沙箱根目录的目录路径，默认根目录'),
        depth: z.number().int().min(0).max(4).optional()
      })
    }
  )

  const globTool = tool(
    async ({ pattern }: { pattern: string }) => {
      const files: string[] = []
      await collectFiles(root, '', files)
      const all = files.filter(f => matchPattern(f, pattern))
      if (!all.length) return '(无匹配文件)'
      const matches = all.slice(0, MAX_RESULTS)
      return (
        matches.join('\n') +
        (all.length > MAX_RESULTS ? `\n…[共 ${all.length} 个匹配，已截断]` : '')
      )
    },
    {
      name: 'glob',
      description:
        '按 glob 模式查找文件（相对沙箱根），支持 ** 匹配任意层级、* 匹配单段内任意字符。跳过 node_modules/.git 与隐藏文件。',
      schema: z.object({ pattern: z.string().describe('如 **/*.ts、src/**/*.test.ts') })
    }
  )

  const grepTool = tool(
    async ({ pattern, include }: { pattern: string; include?: string }) => {
      let re: RegExp
      try {
        re = new RegExp(pattern)
      } catch {
        return `[system-tool] 非法正则: ${pattern}`
      }
      const matches: string[] = []
      const search = async (dir: string, rel: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (matches.length >= MAX_RESULTS) return
          if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue
          const entryRel = rel ? `${rel}/${entry.name}` : entry.name
          const abs = resolve(dir, entry.name)
          if (entry.isDirectory()) {
            await search(abs, entryRel)
            continue
          }
          if (include && !matchPattern(entryRel, include)) continue
          const info = await stat(abs)
          if (!info.isFile() || info.size > 1_000_000) continue
          let content: string
          try {
            content = await readFile(abs, 'utf-8')
          } catch {
            continue
          }
          if (content.includes('\u0000')) continue // 二进制
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!
            if (re.test(line)) {
              matches.push(`${entryRel}:${i + 1}: ${line.trim().slice(0, 200)}`)
              if (matches.length >= MAX_RESULTS) return
            }
          }
        }
      }
      await search(root, '')
      if (!matches.length) return '(无匹配)'
      return (
        matches.join('\n') + (matches.length >= MAX_RESULTS ? '\n…[结果超过 100 条，已截断]' : '')
      )
    },
    {
      name: 'grep',
      description:
        '在文件内容中搜索正则（跳过 node_modules/.git 与二进制/超大文件）。include 可选过滤文件名 glob。返回 文件:行号: 内容。',
      schema: z.object({
        pattern: z.string().describe('正则表达式'),
        include: z.string().optional().describe('文件名过滤 glob，如 *.ts')
      })
    }
  )

  const editFileTool = tool(
    async ({
      path,
      old_string,
      new_string
    }: {
      path: string
      old_string: string
      new_string: string
    }) => {
      const abs = safePath(path)
      const info = await stat(abs)
      if (info.size > 1_000_000) {
        return `[system-tool] 文件过大（${info.size} 字节 > 1MB），edit_file 不支持，请用 read_file + write_file 分段处理`
      }
      const content = await readFile(abs, 'utf-8')
      const count = content.split(old_string).length - 1
      if (count === 0) {
        return '[system-tool] 未找到目标内容（old_string 必须逐字匹配，含缩进/换行）'
      }
      if (count > 1) {
        return `[system-tool] 目标内容匹配到 ${count} 处，请带上更多上下文使其唯一`
      }
      await writeFile(abs, content.replace(old_string, new_string), 'utf-8')
      return `已替换 1 处\n- ${old_string.split('\n')[0]!.slice(0, 60)}\n+ ${new_string.split('\n')[0]!.slice(0, 60)}`
    },
    {
      name: 'edit_file',
      description:
        '精准替换文件中的一段内容（search-replace）。old_string 必须唯一匹配（含缩进/换行）；匹配不到或多处匹配都会返回错误提示让模型重试。改大文件用这个，别用 write_file 整体重写。',
      schema: z.object({
        path: z.string().describe('相对沙箱根目录的文件路径'),
        old_string: z.string().min(1).describe('要替换的原文（必须逐字唯一匹配）'),
        new_string: z.string().describe('替换后的内容')
      })
    }
  )

  const runCommandTool = tool(
    async ({ command }: { command: string }) => {
      const cmd = command.trim()
      if (!commands.length) {
        return '[system-tool] 未配置允许执行的命令（CapabilityService systemTools.commands）'
      }
      // 前缀需带空格边界（cmd === prefix 或 cmd 以 "prefix " 开头），防止 pnpm test-evil 这类前缀绕过
      if (!commands.some(prefix => cmd === prefix || cmd.startsWith(prefix + ' '))) {
        return `[system-tool] 命令不在白名单: ${cmd}\n允许的前缀: ${commands.join(' / ')}`
      }
      if (/&&|\|\||;|\||`|\$\(|\$\{/.test(cmd)) {
        return '[system-tool] 命令包含链式/注入操作符（&& || ; | 反引号 $() ${}），已拒绝'
      }
      try {
        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
          (resolvePromise, rejectPromise) => {
            exec(
              cmd,
              { cwd, timeout: timeoutMs, maxBuffer: 1_000_000 },
              (error, stdout, stderr) => {
                if (error) rejectPromise(Object.assign(error, { stdout, stderr }))
                else resolvePromise({ stdout, stderr })
              }
            )
          }
        )
        const out = `${stdout}${stderr}`.trim() || '(无输出)'
        return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS)}\n…[输出已截断]` : out
      } catch (err) {
        const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean }
        const detail = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message
        return `[system-tool] 命令失败: ${detail.slice(0, MAX_CHARS)}${e.killed ? '（超时被终止）' : ''}`
      }
    },
    {
      name: 'run_command',
      description:
        '在沙箱工作目录执行白名单内的命令（cwd + 超时受限），用于验证闭环：跑测试/构建/静态检查/git 状态。',
      schema: z.object({ command: z.string().describe('要执行的命令，必须命中配置的白名单前缀') })
    }
  )

  return [
    readFileTool,
    writeFileTool,
    listDirTool,
    globTool,
    grepTool,
    editFileTool,
    runCommandTool
  ]
}
