import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientTool } from '@langchain/core/tools'
import CapabilityService from '../src/services/capability/CapabilityService'

async function setup(opts?: { root: string; cwd?: string; commands?: string[] }) {
  const ctx = new Context()
  await ctx.plugin(CapabilityService, opts)
  const spec = await ctx.capability.assemble()
  const tool = (name: string): ClientTool => spec.tools.find(t => t.name === name)!
  return { ctx, tool }
}

/** 造一个测试沙箱：a.txt + sub/b.ts + 5000 字符大文件 */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sys-tools-'))
  mkdirSync(join(dir, 'sub'), { recursive: true })
  writeFileSync(join(dir, 'a.txt'), 'hello world\nline two\n')
  writeFileSync(join(dir, 'sub', 'b.ts'), 'export const x = 1\n// TODO: fix\n')
  writeFileSync(join(dir, 'big.txt'), 'A'.repeat(5000))
  return dir
}

test('read_file：读取内容；大文件截断 + offset 续读', async t => {
  const root = fixture()
  const { tool } = await setup({ root })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(await tool('read_file').invoke({ path: 'a.txt' }), 'hello world\nline two\n')

  const first = await tool('read_file').invoke({ path: 'big.txt' })
  assert.ok(first.includes('已截断'))
  assert.ok(first.includes('offset=4000'))
  assert.equal(await tool('read_file').invoke({ path: 'big.txt', offset: 4000 }), 'A'.repeat(1000))
})

test('read_file：路径越界（../ 与绝对路径）被拒绝', async t => {
  const root = fixture()
  const { tool } = await setup({ root })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  await assert.rejects(() => tool('read_file').invoke({ path: '../outside' }), /路径越界/)
  await assert.rejects(() => tool('read_file').invoke({ path: '/etc/passwd' }), /路径越界/)
})

test('write_file：自动创建父目录，可回读', async t => {
  const root = fixture()
  const { tool } = await setup({ root })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const res = await tool('write_file').invoke({ path: 'nested/deep/c.txt', content: 'hi' })
  assert.ok(res.includes('已写入 nested/deep/c.txt'))
  assert.equal(await tool('read_file').invoke({ path: 'nested/deep/c.txt' }), 'hi')
})

test('list_dir：列出内容，depth 控制递归', async t => {
  const root = fixture()
  const { tool } = await setup({ root })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const full = await tool('list_dir').invoke({})
  assert.ok(full.includes('a.txt'))
  assert.ok(full.includes('sub/'))
  assert.ok(full.includes('b.ts'))

  const shallow = await tool('list_dir').invoke({ path: '.', depth: 0 })
  assert.ok(shallow.includes('sub/'))
  assert.ok(!shallow.includes('b.ts'))

  // 不存在的目录返回可恢复提示，不抛错
  assert.equal(await tool('list_dir').invoke({ path: 'nope' }), '[system-tool] 目录不存在: nope')
})

test('glob：** 匹配任意层级；无匹配返回提示', async t => {
  const root = fixture()
  const { tool } = await setup({ root })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const text = await tool('glob').invoke({ pattern: '**/*.ts' })
  assert.ok(text.includes('sub/b.ts'))
  assert.equal(await tool('glob').invoke({ pattern: '**/*.py' }), '(无匹配文件)')
})

test('grep：按正则搜内容返回 file:line；include 过滤', async t => {
  const root = fixture()
  const { tool } = await setup({ root })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const text = await tool('grep').invoke({ pattern: 'TODO' })
  assert.ok(text.includes('sub/b.ts:2'))
  assert.equal(await tool('grep').invoke({ pattern: 'hello', include: '*.ts' }), '(无匹配)')
})

test('edit_file：唯一匹配替换成功；多处/未找到返回错误提示', async t => {
  const root = fixture()
  const { tool } = await setup({ root })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const res = await tool('edit_file').invoke({
    path: 'a.txt',
    old_string: 'hello world',
    new_string: 'hello there'
  })
  assert.ok(res.includes('已替换 1 处'))
  assert.ok((await tool('read_file').invoke({ path: 'a.txt' })).includes('hello there'))

  await tool('write_file').invoke({ path: 'dup.txt', content: 'aaa\nbbb\naaa\n' })
  const ambiguous = await tool('edit_file').invoke({
    path: 'dup.txt',
    old_string: 'aaa',
    new_string: 'zzz'
  })
  assert.ok(ambiguous.includes('匹配到 2 处'))

  const missing = await tool('edit_file').invoke({
    path: 'a.txt',
    old_string: '不存在的内容',
    new_string: 'x'
  })
  assert.ok(missing.includes('未找到目标内容'))
})

test('run_command：默认禁用（未配置白名单）', async t => {
  const root = fixture()
  const { tool } = await setup({ root })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const res = await tool('run_command').invoke({ command: 'echo hi' })
  assert.ok(res.includes('未配置允许执行的命令'))
})

test('run_command：白名单内可执行；白名单外/链式注入被拒', async t => {
  const root = fixture()
  const { tool } = await setup({ root, cwd: root, commands: ['echo'] })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.ok((await tool('run_command').invoke({ command: 'echo hello' })).includes('hello'))

  const denied = await tool('run_command').invoke({ command: 'ls' })
  assert.ok(denied.includes('不在白名单'))

  const chained = await tool('run_command').invoke({ command: 'echo hi && rm -rf /' })
  assert.ok(chained.includes('已拒绝'))
})
