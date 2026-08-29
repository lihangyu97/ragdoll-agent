import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// 前置检查：panel/dist 缺失时自动构建一次，已存在则静默跳过（挂到 dev/start 前面）
if (!existsSync('panel/dist')) {
  console.error('[preflight] panel/dist 不存在，自动构建前端...')
  execSync('pnpm --filter ragdoll-panel build', { stdio: 'inherit' })
}
