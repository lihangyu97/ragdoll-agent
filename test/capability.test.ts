import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import CapabilityService from '../src/services/capability/CapabilityService'
import type {
  AgentDefinition,
  AgentSpec,
  Skill
} from '../src/services/capability/CapabilityService'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(CapabilityService)
  return ctx
}

const SYSTEM_TOOLS = [
  'read_file',
  'write_file',
  'list_dir',
  'glob',
  'grep',
  'edit_file',
  'run_command'
]

/** 断言系统工具必在（平台原语默认进所有 agent），并过滤出领域工具名 */
function domainTools(spec: AgentSpec): string[] {
  for (const name of SYSTEM_TOOLS) {
    assert.ok(
      spec.tools.some(t => t.name === name),
      `系统工具应默认进每个 agent: ${name}`
    )
  }
  return spec.tools.map(t => t.name).filter(name => !SYSTEM_TOOLS.includes(name))
}

const fakeTool = (name: string) =>
  tool(async () => `result of ${name}`, {
    name,
    description: `Tool ${name}`,
    schema: z.object({})
  })

const weather: Skill = {
  name: 'weather',
  description: '查询天气',
  trigger: '天气、气温',
  instructions: '先 getLocation，再并行 getWeather / getTemperature',
  tools: ['getLocation', 'getWeather']
}

const weatherDef: AgentDefinition = {
  id: 'default',
  basePrompt: 'You are a weather assistant.',
  skills: ['weather']
}

test('未注册任何能力：assemble 走内置默认定义（基础 prompt + 系统工具）', async () => {
  const ctx = await setup()
  const spec = await ctx.capability.assemble()
  assert.ok(spec.systemPrompt.includes('helpful assistant'))
  assert.deepEqual(domainTools(spec), [])
})

test('catalog 模式：技能目录注入 + load_skill 工具', async () => {
  const ctx = await setup()
  ctx.capability.registerTool(fakeTool('getLocation'))
  ctx.capability.registerTool(fakeTool('getWeather'))
  ctx.capability.registerSkill(weather)
  ctx.capability.registerDefinition(weatherDef)

  const spec = await ctx.capability.assemble()
  assert.ok(spec.systemPrompt.includes('You are a weather assistant.'))
  assert.ok(spec.systemPrompt.includes('- weather：查询天气（触发：天气、气温）'))
  assert.ok(spec.systemPrompt.includes('load_skill'))
  assert.deepEqual(domainTools(spec), ['getLocation', 'getWeather', 'load_skill'])
})

test('full 模式：instructions 全量注入，无 load_skill', async () => {
  const ctx = await setup()
  ctx.capability.registerTool(fakeTool('getLocation'))
  ctx.capability.registerTool(fakeTool('getWeather'))
  ctx.capability.registerSkill(weather)
  ctx.capability.registerDefinition({ ...weatherDef, skillMode: 'full' })

  const spec = await ctx.capability.assemble()
  assert.ok(spec.systemPrompt.includes(weather.instructions))
  assert.ok(!spec.systemPrompt.includes('可用技能'))
  assert.deepEqual(domainTools(spec), ['getLocation', 'getWeather'])
})

test('load_skill 返回技能全文（含 resources）；未知技能返回可恢复提示', async () => {
  const ctx = await setup()
  ctx.capability.registerTool(fakeTool('getLocation'))
  ctx.capability.registerTool(fakeTool('getWeather'))
  ctx.capability.registerSkill({
    ...weather,
    resources: { faq: '常见问题：天气接口偶发超时，重试一次即可。' }
  })
  ctx.capability.registerDefinition(weatherDef)

  const spec = await ctx.capability.assemble()
  const loadSkill = spec.tools.find(t => t.name === 'load_skill')!
  const text = await loadSkill.invoke({ name: 'weather' })
  assert.ok(text.includes(weather.instructions))
  assert.ok(text.includes('faq'))
  assert.ok(text.includes('天气接口偶发超时'))

  const missing = await loadSkill.invoke({ name: 'nope' })
  assert.ok(missing.includes('未找到技能：nope'))
  assert.ok(missing.includes('可用技能：weather'))
})

test('personas：具名 prompt 段按顺序拼接；未知段组装抛错', async () => {
  const ctx = await setup()
  ctx.capability.registerPrompt('polite', '说话要礼貌。')
  ctx.capability.registerDefinition({
    id: 'default',
    basePrompt: 'You are a helper.',
    personas: ['polite']
  })

  const spec = await ctx.capability.assemble()
  assert.ok(spec.systemPrompt.includes('You are a helper.'))
  assert.ok(spec.systemPrompt.includes('说话要礼貌。'))

  ctx.capability.registerDefinition({
    id: 'default',
    basePrompt: 'You are a helper.',
    personas: ['nope']
  })
  await assert.rejects(() => ctx.capability.assemble(), /prompt 不存在: nope/)
})

test('def.tools 直挂 + skill.tools 引用去重，catalog 仍带 load_skill', async () => {
  const ctx = await setup()
  ctx.capability.registerTool(fakeTool('t1'))
  ctx.capability.registerSkill({ name: 's1', description: 'd', instructions: 'i', tools: ['t1'] })
  ctx.capability.registerDefinition({
    id: 'default',
    basePrompt: 'b',
    tools: ['t1'],
    skills: ['s1']
  })

  const spec = await ctx.capability.assemble()
  assert.deepEqual(domainTools(spec), ['t1', 'load_skill'])
})

test('直接传 AgentDefinition 组装（不经过注册表）', async () => {
  const ctx = await setup()
  const spec = await ctx.capability.assemble({ id: 'inline', basePrompt: 'inline base' })
  assert.ok(spec.systemPrompt.includes('inline base'))
  assert.deepEqual(domainTools(spec), [])
})

test('系统工具隔离：注册同名抛错、不可注销、version 不受 seed 影响', async () => {
  const ctx = await setup()
  assert.throws(() => ctx.capability.registerTool(fakeTool('read_file')), /与系统工具重名/)
  assert.throws(() => ctx.capability.unregisterTool('read_file'), /系统工具不可注销/)
  // seed 发生在构造期，不占 version
  assert.equal(ctx.capability.version, 0)
})

test('重复注册抛错；unregister 缺失抛错', async () => {
  const ctx = await setup()
  ctx.capability.registerTool(fakeTool('t1'))
  assert.throws(() => ctx.capability.registerTool(fakeTool('t1')), /tool 已存在: t1/)

  ctx.capability.registerSkill(weather)
  assert.throws(() => ctx.capability.registerSkill(weather), /skill 已存在: weather/)

  ctx.capability.registerPrompt('p1', 'x')
  assert.throws(() => ctx.capability.registerPrompt('p1', 'y'), /prompt 已存在: p1/)

  assert.throws(() => ctx.capability.unregisterTool('nope'), /tool 不存在: nope/)
  assert.throws(() => ctx.capability.unregisterSkill('nope'), /skill 不存在: nope/)
  assert.throws(() => ctx.capability.unregisterDefinition('nope'), /definition 不存在: nope/)
})

test('unregister 后 assemble 引用缺失抛错', async () => {
  const ctx = await setup()
  ctx.capability.registerTool(fakeTool('getLocation'))
  ctx.capability.registerSkill(weather)
  ctx.capability.registerDefinition(weatherDef)

  ctx.capability.unregisterSkill('weather')
  await assert.rejects(() => ctx.capability.assemble(), /skill 不存在: weather/)

  ctx.capability.registerSkill(weather)
  ctx.capability.unregisterTool('getLocation')
  await assert.rejects(() => ctx.capability.assemble(), /tool 不存在: getLocation/)
})

test('version 随注册/注销递增', async () => {
  const ctx = await setup()
  const v0 = ctx.capability.version
  ctx.capability.registerTool(fakeTool('t1'))
  assert.equal(ctx.capability.version, v0 + 1)
  ctx.capability.registerSkill(weather)
  assert.equal(ctx.capability.version, v0 + 2)
  ctx.capability.registerDefinition(weatherDef)
  assert.equal(ctx.capability.version, v0 + 3)
  ctx.capability.unregisterTool('t1')
  assert.equal(ctx.capability.version, v0 + 4)
})

test('registerDefinition 同 id 覆盖（内置 default 可替换）', async () => {
  const ctx = await setup()
  ctx.capability.registerDefinition({ id: 'default', basePrompt: 'replaced base' })
  const spec = await ctx.capability.assemble()
  assert.ok(spec.systemPrompt.includes('replaced base'))
  assert.ok(!spec.systemPrompt.includes('helpful assistant'))
})

test('waterfall 改写点：插件可在组装期追加 systemPrompt', async () => {
  const ctx = await setup()
  ctx.on(
    'agent/prompt-build',
    async (_prompt, _def, next) => `${(await next()) as string}\n\n[plugin-suffix]`
  )

  const spec = await ctx.capability.assemble()
  assert.ok(spec.systemPrompt.endsWith('[plugin-suffix]'))
})
