import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import DatabaseService from '../src/services/data/database/DatabaseService'
import CapabilityService from '../src/services/agent/capability/CapabilityService'
import skillLoader, {
  loadSkillsFromDir,
  parseSkillFile,
  skillFromFile
} from '../src/plugins/skill-loader'
import type { Skill } from '../src/services/agent/capability/CapabilityService'

/** 造技能根目录：files 的 key 为相对路径（含 SKILL.md） */
function makeRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'skills-'))
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  return dir
}

const GOOD_SKILL_MD = `---
name: demo-skill
description: 处理 demo 任务的技能。Use when handling demos.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"
---
按以下步骤执行 demo 任务：
1. 先看 references/REFERENCE.md
2. 再调用脚本 scripts/run.sh
`

test('parseSkillFile：frontmatter 与正文分离；无 frontmatter 返回 null', () => {
  const parsed = parseSkillFile(GOOD_SKILL_MD)!
  assert.equal(parsed.frontmatter.name, 'demo-skill')
  assert.equal((parsed.frontmatter.metadata as Record<string, string>).author, 'example-org')
  assert.ok(parsed.body.includes('按以下步骤执行'))

  assert.equal(parseSkillFile('no frontmatter here'), null)
  assert.equal(parseSkillFile('---\nname: x'), null) // 未闭合
})

test('skillFromFile：合法 frontmatter → 内部 Skill（宿主字段存而不进渲染路径）', () => {
  const { skill } = skillFromFile('demo-skill', GOOD_SKILL_MD) as { skill: Skill }
  assert.equal(skill.name, 'demo-skill')
  assert.equal(skill.description, '处理 demo 任务的技能。Use when handling demos.')
  assert.ok(skill.instructions.includes('按以下步骤执行'))
  assert.equal(skill.source, 'file')
  assert.equal(skill.license, 'Apache-2.0') // 存着，renderSkill 不渲染
  assert.deepEqual(skill.metadata, { author: 'example-org', version: '1.0' })
})

test('skillFromFile：合规校验（name 与目录名/字符集、必填字段、正文非空）', () => {
  // name 与目录名不一致
  const mismatch = skillFromFile('other-dir', GOOD_SKILL_MD)
  assert.ok('error' in mismatch && mismatch.error.includes('不一致'))

  // name 非法字符（大写）
  const badName = skillFromFile(
    'demo-skill',
    GOOD_SKILL_MD.replace('name: demo-skill', 'name: Demo-Skill')
  )
  assert.ok('error' in badName && badName.error.includes('不合法'))

  // 缺 description
  const noDesc = skillFromFile('demo-skill', '---\nname: demo-skill\n---\nbody here\n')
  assert.ok('error' in noDesc && noDesc.error.includes('description'))

  // 空正文
  const emptyBody = skillFromFile('demo-skill', '---\nname: demo-skill\ndescription: d\n---\n\n')
  assert.ok('error' in emptyBody && emptyBody.error.includes('正文为空'))
})

test('loadSkillsFromDir：加载合法技能（references/assets/scripts 进 resources，scripts 另有执行索引）', async t => {
  const root = makeRoot({
    'demo-skill/SKILL.md': GOOD_SKILL_MD,
    'demo-skill/references/REFERENCE.md': '# 参考文档\n细节在此',
    'demo-skill/assets/template.txt': '模板内容',
    'demo-skill/scripts/run.sh': '#!/bin/sh\necho hi'
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const registered: Skill[] = []
  const result = await loadSkillsFromDir(root, s => registered.push(s))

  assert.deepEqual(result.loaded, ['demo-skill'])
  assert.deepEqual(result.skipped, [])
  assert.equal(registered.length, 1)
  const skill = registered[0]!
  assert.deepEqual(skill.resources, {
    'references/REFERENCE.md': '# 参考文档\n细节在此',
    'assets/template.txt': '模板内容',
    'scripts/run.sh': '#!/bin/sh\necho hi' // scripts 内容可读（不可执行）
  })
  assert.deepEqual(skill.scripts, ['scripts/run.sh']) // 执行索引单独保留
  assert.equal(skill.source, 'file')
})

test('loadSkillsFromDir：不合规技能跳过并说明原因，不炸加载', async t => {
  const root = makeRoot({
    'name-mismatch/SKILL.md': GOOD_SKILL_MD, // name=demo-skill ≠ 目录名
    'no-frontmatter/SKILL.md': 'plain markdown without frontmatter',
    'empty-body/SKILL.md': '---\nname: empty-body\ndescription: d\n---\n\n'
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const registered: Skill[] = []
  const result = await loadSkillsFromDir(root, s => registered.push(s))

  assert.deepEqual(result.loaded, [])
  assert.deepEqual(result.skipped.map(s => s.name).sort(), [
    'empty-body',
    'name-mismatch',
    'no-frontmatter'
  ])
  assert.ok(result.skipped.some(s => s.name === 'name-mismatch' && s.reason.includes('不一致')))
  assert.ok(
    result.skipped.some(s => s.name === 'no-frontmatter' && s.reason.includes('frontmatter'))
  )
})

test('loadSkillsFromDir：skillsRoot 不存在返回空结果，不报错', async () => {
  const result = await loadSkillsFromDir('/nonexistent/skills-dir', () => {})
  assert.deepEqual(result, { loaded: [], skipped: [] })
})

test('插件级：文件技能覆盖代码注册的同名技能', async t => {
  const root = makeRoot({
    'demo-skill/SKILL.md': GOOD_SKILL_MD,
    'demo-skill/references/REFERENCE.md': '# 参考文档\n细节在此'
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const ctx = new Context()
  await ctx.plugin(DatabaseService, { dbPath: ':memory:' })
  await ctx.plugin(CapabilityService)
  ctx.capability.registerSkill({
    name: 'demo-skill',
    description: '代码注册版',
    instructions: 'code instructions',
    source: 'code'
  })

  await ctx.plugin(skillLoader, { skillsRoot: root })

  // 文件版覆盖：instructions 来自 SKILL.md 正文，source=file
  const spec = await ctx.capability.assemble({ id: 'x', basePrompt: 'p', skills: ['demo-skill'] })
  const loadSkill = spec.tools.find(t => t.name === 'load_skill')!

  // 不传 resource：说明 + 文件索引；宿主字段（license 等）不渲染；文件内容不内联
  const text = await loadSkill.invoke({ name: 'demo-skill' })
  assert.ok(text.includes('按以下步骤执行'))
  assert.ok(text.includes('- references/REFERENCE.md'))
  assert.ok(!text.includes('参考文档'))
  assert.ok(!text.includes('license'))
  assert.ok(!text.includes('Apache-2.0'))

  // 传 resource：按需加载文件内容
  const ref = await loadSkill.invoke({ name: 'demo-skill', resource: 'references/REFERENCE.md' })
  assert.ok(ref.includes('参考文档'))
})
