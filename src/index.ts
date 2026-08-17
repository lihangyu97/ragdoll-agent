/**
 * ragdoll — 入口文件
 * 目前只是一个最小可运行示例，用来验证 TS 环境：
 *   pnpm dev        开发模式（tsx watch，改代码自动重跑）
 *   pnpm typecheck  只做类型检查，不产出文件
 *   pnpm build      编译到 dist/
 *   pnpm start      运行编译产物
 */

interface Agent {
  name: string
  version: string
}

const agent: Agent = {
  name: "ragdoll",
  version: "0.1.0"
}

function describe(a: Agent): string {
  return `${a.name} v${a.version} — a TypeScript agent project for learning`
}

console.log(describe(agent))
console.log(`Node ${process.version}`)
