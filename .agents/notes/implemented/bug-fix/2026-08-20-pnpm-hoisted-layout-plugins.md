# Agent Note: pnpm-hoisted-layout-plugins

Status: implemented

## Problem

用户启用预装插件（dsh-kanban）后重启服务黑屏。直读 Windows runtime：manager.log 显示 dsh web 启动崩溃（exit 1）——`failed to import loader entry dsh-kanban: Cannot find package '@deepseek-ai/dsh-tools'`。根因：0.3.3 的 pnpm isolated 布局把 dsh 的内部包收在 .pnpm 虚拟仓库，node_modules 根只有 dsh 自己；预装插件（复制到根目录、自身无依赖、import 宿主 dsh 内部包）与 host bundle（@deepseek-ai/dsh-base/dsh-web-app，web profile 默认 bundles）在 isolated 布局下解析不到 dsh 内部包 → dsh-base/web-app 服务起不来（tools/webServer/systemPrompt/commands 缺失）→ dsh-kanban 等不到服务 → dsh 启动失败黑屏。npm 平铺布局时代无此问题——是 pnpm 切换引入的回归。

## Decision

scripts/server-manager.mjs：dsh 的 pnpm 安装加 `--node-linker=hoisted`（CLI flag，实测 pnpm 11.22 只认 flag、配置文件忽略该键），使 runtime 回到 npm 平铺兼容布局——复制到 node_modules 根的预装插件（dsh-kanban 等）与 host bundle（dsh-base/dsh-web-app）能 import dsh 内部包（@deepseek-ai/dsh-tools 等），修复 0.3.3 isolated 布局导致的"启用插件→重启黑屏"（dsh web ERR_MODULE_NOT_FOUND 崩溃）。新增 isIsolatedPnpmLayout(runtimeDir)（.pnpm 存在且 node_modules/@deepseek-ai/dsh-base 不在根 = isolated 特征）与 main() 迁移分支：检测到 isolated 布局 → 删 node_modules → installDshUpdate() 全新 hoisted 安装（warm store ~6s，避免原地 re-link 的 260s+ 与半转换状态）。installDshUpdate 增 { force } 参数（布局迁移以外的强制重装用）。版本 0.3.3 → 0.3.4。
## Alternatives considered

**hoist-pattern[]=@deepseek-ai/*（只提升 @deepseek-ai scope）**：配置放 .npmrc/pnpm-workspace.yaml 在 pnpm 11.22 里被忽略（实测 config get 返回 undefined、布局不变），只有 CLI flag 生效且无 --hoist-pattern 对应 flag，弃。**node-linker=hoisted 全量提升（最终采用）**：CLI flag 实测生效（root 254 包、dsh-tools/dsh-base 在根），布局回到 npm 平铺兼容，任何插件都能解析宿主包；缺点是 node_modules 变大（全部物理铺开）、冷装略慢。**只给插件需要的 dsh-tools 建符号链接**：够用但脆弱（以后插件 import 别的宿主包又会炸），且要维护链接清单，弃。**迁移用原地 pnpm re-link**：实测 reused 0、260s+ 还没完，且中途被杀留半转换状态；改为删 node_modules 全新安装（warm store ~6s）更稳更快。
## Consequences

购买：预装插件（dsh-kanban）与 host bundle（dsh-base/dsh-web-app）在 hoisted 布局下全部可解析，启用后重启不再黑屏；0.3.3 isolated 存量 runtime 在下次启动自动迁移（检测 .pnpm 存在且 dsh-base 不在根 → 删 node_modules → 全新 hoisted 安装，~6s）；新安装直接 hoisted。代价：node_modules 从 isolated 的精简符号链接变为全量铺开（体积增大、冷装略慢）；hoisted 仍保留 .pnpm 虚拟仓库（pnpm 11.22 行为，符号链接到它）；迁移触发点 isIsolatedPnpmLayout 以 dsh-base 在根为信号，若 pnpm 未来改变 dsh-base 的位置需复核。测试：repro3（新装 hoisted + 启用 dsh-kanban → URL 正常）、migrate（isolated→hoisted 迁移 → URL 正常）均 PASS；control-plane/proxy/broken-install 全绿。

