# Agent Note: audit-content-level-check

Status: implemented

## Problem

`scripts/audit-preinstalled.mjs` 只比版本号：读随包 `package.json` 的 version，与 npm `dist-tags.latest` 对比。这留了两个盲区：

1. **手工同步拷错/拷漏时版本号照样相等**。预装插件的同步是手工步骤（`npm pack` → 按壳内精简约定拷文件），最容易错的正是这一步；拷错之后 audit 判 `up-to-date`，技能 §3 又明令"任何已是最新的插件不要动"，于是错误内容永远不被发现。2026-09-20 排查 dsh-kanban 漂移时，正是靠人工 `md5sum` 才发现随包副本与 tarball 的关系，脚本本身给不出这个信息。
2. **随包技能的可解析性没人查**。随包 `skills/kanban-use/SKILL.md` 的 `description` 未加引号且含 ASCII `": "` → YAML 解析失败 → DSH 静默丢弃整个技能（只写一条服务端 warn）。这与版本、与同步是否"正确"都无关，是上游包自身的缺陷。

## Decision

给 audit 增加两层报告，同时**严格保留它既有的契约**：只读、不写任何文件、永远 exit 0、绝不当门禁、不用 `npm view`。

> **部分被取代（2026-09-22）**：本文选定的 tarball 获取方式（`dist.tarball` + `fetch`、不落临时文件）已改为 npm CLI
> （`npm view` + `npm pack`），见 [audit-registry-transport-and-verdict](2026-09-22-audit-registry-transport-and-verdict.md)：`fetch` 不读 npm 的代理配置，
> 在代理网络上会让整份报告建立在未知数据上。内容级比对**本身**（比什么、怎么比、为什么当报告而非门禁）仍按本文执行。

- **内容级比对**：对随包逐字拷贝的资产（`lib/*.js`、`cordis.patch.yml`、`skills/*/SKILL.md`）与**同版本**的已发布 tarball 做 sha256 比对。tarball 由 `versions[latest].dist.tarball` 取得（权威 URL，天然处理 scoped 包名），在内存里 `gunzipSync` + 极简 tar 解析（512 字节头、`size` 八进制、typeflag、ustar prefix），不落临时文件、不加依赖。版本相同时**也**比对——那正是这个检查存在的理由。报告 `content: N/N verbatim assets match` 或 `content: ⚠️ <file> DRIFT`。
- **技能 frontmatter 报告**：随包 `skills/*/SKILL.md` 若 frontmatter 不可解析，报 `skill: ⚠️ …`，并明确标注"上游包缺陷，需要新版本而非同步"。
- **网络加固**：registry 探测包了 try/catch —— 瞬时超时降级为一条报告行（`⚠️ Connect Timeout`），不再让脚本崩溃。这是实测踩到的：加固前一次 connect timeout 直接把脚本打崩（report 工具崩溃比报告缺失更糟）。汇总行同时统计版本更新与内容漂移两类。

## Alternatives considered

**用 `npm pack` 落盘再解包**（即技能 §3 的手工路径）：被否——audit 的契约是只读且不写任何文件，落盘会写进工作区、还需要指定 cache 目录规避只读 `~/.npm`，比内存解析更慢更脏。

**从 unpkg / jsdelivr 按单文件拉取**：实现最短，但把校验建立在第三方 CDN 之上（与"基准 = npm 已发布 tarball"的既有决策不一致），且引入新的信任路径与可用性依赖。

**引入 tar 解析依赖**：被否——只需 ~40 行读固定偏移，为它加一个运行时依赖不划算；仓库也一直保持 audit 零依赖。

**把它变成门禁（非 0 退出）**：被否——脚本头部明确写着"report-only; never a gate"，且内容漂移需要人来判断哪一侧是权威（是随包副本错了，还是 tarball 里就是坏的），自动失败会逼着人绕过门禁。真正该当门禁的是仓库内可控的不变量，那已由 `scripts/test-copy-consistency.mjs` 覆盖。

## Consequences

买了：手工同步这一步现在有机器复核（版本相同也能发现内容不一致）；随包技能的"会被 DSH 静默丢弃"从无人知晓变成每次 audit 都会报；网络抖动不再让报告工具崩溃。实测：四个预装包 12/12 资产与已发布 tarball 逐字节一致；反向验证（往 `plugins/preinstalled/dsh-kanban/lib/index.js` 追加一个字节）在版本仍显示 `up-to-date` 的同时报出 `content: ⚠️ lib/index.js DRIFT`，退出码保持 0。

代价与边界：**查不出"仓库 HEAD 有未发布的修复"**——audit 只认 npm 已发布版本，跨仓库的"源码已修但未发版"它看不见（dsh-kanban 当前正是这个状态：修复已提交、0.2.6 tarball 仍是坏的，audit 报的是"上游包缺陷"，要发 0.2.7 才能清掉）。tarball 解析只处理常规文件（typeflag `0`/空），不处理 GNU 长名与 PAX 扩展头——npm 的包路径都短，当前足够；真遇到长路径会表现为 `not in tarball` 而非静默通过。

同提交的文档同步：技能 `dsh-preinstalled-plugin-sync` §2 的 audit 说明改为"两层比对 + 技能 frontmatter 报告"，并写明各自的语义与边界。
