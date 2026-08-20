# Agent Note: nsis-delete-data-checkbox-accepted

Status: implemented

## Problem

用户升级 0.2.0→0.3.0 时在安装向导里勾选了「删除应用程序数据」，随后冷安装卡死。排查确认该勾选框来源是 Tauri 2 默认 NSIS 卸载器模板（无条件显示，无配置开关），并会在升级流程中出现（向导默认「安装前卸载」→ 交互式运行旧卸载器 → 卸载器确认页带此勾选框）。需要决定：是否值得为此 fork 自定义 NSIS 模板来移除/规避该选项。

## Decision

「删除应用程序数据」勾选框是 Tauri 2 默认 NSIS 卸载器模板（installer.nsi 的 un.ConfirmShow，2.11.5 中无条件显示）的固定行为，非本壳自定义代码；NsisConfig 无任何开关可禁用它。用户选择方案 C：不改安装器、接受现状。配套落地：README 增加「Windows 安装/升级须知」章节，写明 (a) 勾选框默认未勾选、普通升级保留全部数据；(b) 勾选 = 清空 DSH_HOME + dsh 本体 + 设置并触发冷安装（0.3.2 起不再卡死）；(c) 升级后如见 launch failed 由 0.3.2 自动修复。未做：不 fork NSIS 模板、不新增自更新器。
## Alternatives considered

**自定义 NSIS 模板（bundle.windows.nsis.template，fork 上游 installer.nsi 约 977 行）**：可彻底移除「删除应用程序数据」勾选框或把升级页默认改为「请勿卸载」——被用户否决（方案 C），原因是维护成本：fork 会随 Tauri 升级漂移、需持续同步，且改动卸载器行为影响面大。**应用内自更新器走 /UPDATE 模式**：Tauri 模板已内置 UpdateMode（/UPDATE 下跳过 reinstall 页、不运行旧卸载器、不删数据），但我们没有自更新流程（用户手动下载 setup.exe），做自更新器工作量大且改变分发模型，否决。**配置开关 deleteAppDataOnUninstall**：经核实 2.11.5 的 NsisConfig 已无此字段，模板里勾选框无条件显示，不存在此开关。
## Consequences

勾选框继续存在：升级时（默认走「安装前卸载」）会弹出旧卸载器的「删除应用程序数据」勾选框，用户误勾会清空全部本地数据。缓解已落地：(1) 0.3.2 起勾选后的冷安装不再卡死（fetch 快失败 + 半截安装自动修复）；(2) README 新增「Windows 安装/升级须知」说明勾选框含义与普通升级的默认行为。后续触发点：若用户再次误勾、或引入应用内自更新器、或升级 Tauri 大版本时，应重新评估是否 fork 模板（届时优先只做「升级默认请勿卸载」这一处最小改动）。

