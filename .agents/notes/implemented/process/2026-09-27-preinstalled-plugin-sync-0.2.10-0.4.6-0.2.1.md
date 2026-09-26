# 预装插件同步：kanban 0.2.8→0.2.10、turn-nav 0.4.4→0.4.6、opencode-session 0.2.0→0.2.1

## 问题

四个预装 bundle 随壳发版锁定，而 npm 上已经有更新的已发布版本：壳里是 kanban 0.2.8 / turn-nav 0.4.4 / opencode-session 0.2.0，npm latest 分别是 0.2.10 / 0.4.6 / 0.2.1（model-reasoning 已由并行会话同步到 0.2.6）。差距不只是版本号：0.1.7 移除了客户端服务 `settingsScope`（改用 `settingsSchema` + `configForms`），旧插件的客户端半区在新 dsh 上会 pending，而 web boot 对未激活条目是 **fail-closed** —— 一个插件 pending 就会让整个 Web UI 停在「Failed to load plugins」。壳已把 `MIN_DSH_VERSION` 抬到 `0.1.7-rc.2`（并行会话提交），因此**预装插件必须同步到适配 0.1.7 的版本**，否则"新壳 + 旧 bundle"装出来就是打不开的界面。`scripts/test-plugin-dsh-compat.mjs` 此前对 model-reasoning 0.2.4 是**刻意红**的，正是这道耦合的门禁。

## 决策

同步基准 = **npm 已发布 latest 的官方 tarball**，一律走仓库自己的脚本 `npm run sync:plugin -- <pkg> <ver>`（`scripts/sync-preinstalled-plugin.mjs`），不再手工拷贝。本次三个包：`dsh-kanban@0.2.10`、`dsh-turn-navigator@0.4.6`、`@karoc/dsh-smoothly-opencode-session@0.2.1`（scoped 包名要传 npm 名，不能传目录名——传目录名会 404）。

同步后四个包全部达到技能里定义的判据 **`--check` 零 diff**（"同步已发布且已是最新的版本应当零 diff"）：kanban 4/4、model-reasoning 6/6、turn-nav 3/3、opencode-session 2/2 逐字资产与已发布 tarball 一致。README 的双语链接行按"删含 `README.zh.md` 的整行"这一通用规则裁剪，三类格式（管道式 / 粗体·式 / 根本没有该行）都实测无残留。

## 被放弃的方案

- **以插件仓库 HEAD 为基准**：`package.json` 的 `files` 白名单之外还有未发布提交的风险，且"最新版"的权威定义是 npm 发布版；本轮三仓 HEAD 恰好都在发布 tag 上，两条基准收敛，但脚本仍固定取 registry。
- **手工 `npm pack` + 逐文件拷贝**：技能 §3 的手工流程已被 §3.5 的脚本替代；手工拷贝正是历史上丢掉 dsh-kanban 技能资产（`skills/kanban-use/SKILL.md`、`scripts/install-skill.mjs`）和删错 README 空行的原因。
- **只改源树、不重跑 resources**：`sync-resources.mjs` 是打包链的一环（`bundle.resources` 读的是 `src-tauri/resources/preinstalled`），漏跑会让安装包与源树不一致；一致性门禁会红。本次脚本内已自动跑，`diff -r` 实测 IDENTICAL。
- **顺手同步"已是最新"的包**：不做——版本与运行内容一致即视为已最新，差异只是壳内精简。

## 后果

- 壳的下一个版本将随包分发这四个新 bundle；**已安装桌面应用的 runtime 拷贝不受本次影响**（那走控制台「检查预装插件更新」的用户门控路径，从 npm 取）。
- `test-plugin-dsh-compat.mjs` 从红转绿（4 个预装插件 0 警告），`test-copy-consistency.mjs` PASS，全量 `npm test`（15 套）exit 0，独立 `audit-preinstalled.mjs` 报四个包 `up-to-date` 且内容匹配。
- 新增的运行时地板守卫（并行会话的 `plugin-floor.mjs`）与本次同步互补：守卫拦"地板不满足的插件装进 runtime"，同步保证"随包版本本来就满足地板"。
- 未做：把 `quarantinedPlugins` 呈现到界面、不一致态下守卫的 E2E（仍在并行会话的待办里）。
