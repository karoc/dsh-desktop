# 工程记录（踩过的坑 → 应对机制）

本文件记录本项目踩过的真实问题与对应机制，避免重犯。每类问题对应一条可执行的防线。

## 1. 平台运行时语义不能靠"查文档"，只能靠"跑"

- 坑：Tauri `resource_dir()` 在 **Windows 返回 exe 目录**，不是 `resources/` 子目录；
  打包布局必须按 `resource_dir()/resources` / `exe_dir()/resources` 探测，不能假设。
- 机制：`src-tauri/src/lib.rs::resource_paths()` 多候选探测 + 启动时打印 `resources root: ...`；
  CI `linux-smoke` 真跑打包后的二进制并断言该路径下的 `node/<plat>/node` 存在。

## 2. "能编译" ≠ "能跑"

- 坑：E0382（借用已移动的 `line`）、E0599（PathResolver 无 `exe_dir()`）都只在编译时暴露；
  而"资源探测少拼一层 `node/`""资源根错位"只在运行时暴露，编译全绿也会翻车。
- 机制：CI 三级门禁 = `cargo check`（快，拦编译错）→ `bundle`（拦打包错，含 NSIS/AppImage
  布局断言）→ `linux-smoke`（xvfb 真跑，拦运行时错）。任一红不发新包。

## 3. 交付前没跑过的东西，不能叫"已验证"

- 坑：JS 侧（manager/插件/patch）本地全验过、问题最少；Rust 壳没编译没运行，问题全堆在用户侧。
- 机制：交付声明区分「真跑过 / 仅编译 / 仅推断」；用户拿到的包 = 全部门禁绿。
  新平台/新框架先做 spike（最小可运行 + 打印关键路径）再写全量。

## 4. API 名靠记忆 = 高危

- 坑：`exe_dir()` 是编出来的名字（实际在 `std::env::current_exe()`）。
- 机制：不熟的 API 落笔前查源码/生成文档并记入本文件。

## 5. 首次启动的慢网络体验

- 坑：国内网络拉官方 registry 530 个包能"卡死"级慢，且旧版无进度无错误。
- 机制：`DSH_DESKTOP_REGISTRY`/`--registry` 镜像可配 + 双源回退 + 安装进度实时上屏 +
  600s 超时 + `首次安装需几分钟` 提示。

## 6. 可观测性是定位的放大器

- 坑：早期所有失败静默（stderr 不可见），用户等 5 分钟只看到转圈。
- 机制：manager 日志落盘 `<runtime>/manager.log`；Rust 把协议镜像到 stderr（smoke 可抓）；
  UI 红色错误 + 重试 + 打开数据目录；`scripts/diagnose.ps1|.sh` 一键收集。

## 7. 用户侧摩擦有成本

- 坑：我给的 PowerShell 出现过丢 `&`、默认安装目录猜错；用户还踩过没装 Rust 的本地构建。
- 机制：命令一律单行/自定位；本地构建前置写进 README；“推荐用 CI 安装包”放第一位。

## 8. 交付门禁必须真的挡住"用户侧编译失败"

- 坑：CI 加了 `cargo check` 门禁，但我没等它绿就让用户 pull+bundle，E0599/Notification::new/E0505 连烧用户三轮本地编译。
- 机制：**任何 Rust 改动 push 后，先轮询 check job 变绿，再通知用户**。check 是用户流程的硬闸门，不是装饰。
- 写插件 API 前先查 docs.rs 签名（`NotificationExt::notification().builder()` 而非 `Notification::new`），不靠记忆。

## 平台专属项仍要真机验证（机制覆盖不到的部分）

Windows 的 NSIS 安装行为、toast 渲染、AUMID、事件投递——Linux smoke 覆盖不到，
靠 error-visibility + manager.log + diagnose 把定位时间压到分钟级。