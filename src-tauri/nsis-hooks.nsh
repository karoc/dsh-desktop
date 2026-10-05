; dsh-desktop NSIS 安装钩子
;
; 为什么需要：Tauri 的 NSIS 安装器**只覆盖不删除**，上一版安装遗留在
; `<install>\resources\plugin\@dsh-desktop\` 的插件目录会在升级后继续存在，
; 并被 manager 每次启动复制进 runtime（2026-10-04 实测：0.10.1 → 0.14.0 升级后，
; 早已移除的 `@dsh-desktop/plugin-console` 仍被复制、日志里每次出现
; "updated client plugin @dsh-desktop/plugin-console"）。
; 该目录完全由安装包重建，因此在解包前整目录删除是安全的。
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Removing stale shell client plugins (resources\plugin)"
  RMDir /r "$INSTDIR\resources\plugin"
!macroend
