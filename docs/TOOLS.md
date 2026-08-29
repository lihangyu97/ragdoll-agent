# 工具链评估：oxlint / oxfmt

> 2026-08-29 实测。当时版本：oxlint 1.80.0（稳定）、oxfmt 0.65.0。

## 结论

**两者都可用，且可以直接替换 prettier + 补上 lint 空缺**：

| 角色   | 工具   | 实测结果                                                                                                                 |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| lint   | oxlint | 默认规则（correctness）在本仓库 **0 报错**，41 文件 10ms；`-D perf/suspicious` 扩展可用，报的都是真问题                  |
| 格式化 | oxfmt  | `oxfmt --migrate=prettier` 一键迁移 `.prettierrc` 后，`oxfmt --check .` **全部通过**，与本仓库现有 prettier 风格完全兼容 |

## 实测细节

### oxlint（lint，替代/补充 ESLint）

- 默认分类（correctness）零噪音，可作为 pre-commit/CI 直接启用
- 扩展分类实测：`-A all -D correctness -D perf -D suspicious` 报 37 条，多为
  `no-await-in-loop`（skill-loader 的顺序读取，此处串行是有意为之，可忽略或改
  `Promise.all`）；`pedantic` 分类 98 条偏风格洁癖（`length` → `length > 0` 等），不建议开
- 支持 `.oxlintrc.json`（ESLint v8 兼容格式）、`--fix`、tsconfig 感知

### oxfmt（格式化，可替代 prettier）

- 本质是 oxc 的 prettier 兼容格式化器，速度远快于 prettier（本仓库 50 文件约 150ms）
- `npx oxfmt --migrate=prettier` 自动读取 `.prettierrc`（semi/singleQuote/printWidth/
  trailingComma/arrowParens）+ `.prettierignore` 生成 `.oxfmtrc.json`，迁移后全仓库
  check 通过，**风格与现有 prettier 产物零差异**
- 支持 `--check` / `--list-different` / `--write` / LSP，忽略文件复用 `.gitignore` 与
  `.prettierignore`

## 接入记录（2026-08-29 已实施）

1. `pnpm add -D oxlint oxfmt`，scripts：`lint: oxlint`、`lint:fix`、`format: oxfmt --write .`、
   `format:check: oxfmt --check .`（prettier 的 format scripts 已替换）
2. lint-staged 按文件类型分工：`*.{ts,js,mjs,cjs,jsx,tsx}` 走 `oxfmt --write` +
   `oxlint --fix`；`*.{json,md,yml,yaml}` 仍走 prettier（oxfmt 对非代码文件报错退出，
   格式能力只覆盖代码）
3. ~~prettier 保留过渡期~~ → 2026-08-29 已移除 prettier（含 `.prettierrc` /
   `.prettierignore`）：实测 oxfmt 对 json/md/yml 的输出与 prettier 零差异，ignore
   规则此前已迁移进 `.oxfmtrc.json` 的 `ignorePatterns`，lint-staged 全部交给 oxfmt
4. CI（若加）跑：`typecheck + lint + test + format:check`

编辑器：VSCode 全局默认 formatter = prettier（读 `.prettierrc`，与 oxfmt 输出一致）。
命令行格式化/lint 用本仓库 scripts（`pnpm format` / `pnpm lint`，走 node_modules 内的
oxfmt/oxlint）。若想编辑器内启用 oxfmt + oxlint 实时诊断，装官方 Oxc 扩展
（`oxc.oxc-vscode`）并在项目 `.vscode/settings.json` 里把 `editor.defaultFormatter`
设为 `oxc.oxc-vscode` 即可（本项目暂未启用，保留 prettier）。

注意：oxfmt 目前 0.x，大版本未到 1.0，格式输出在后续版本可能微调（有 prettier
可回退，风险低）。
