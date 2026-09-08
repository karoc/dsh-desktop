; ── 旧版接管（legacy takeover）───────────────────────────────────────────────
; 0.3.x → 0.4.x 品牌统一后旧安装（%LOCALAPPDATA%\dsh Desktop，productName
; "DSH Desktop"，identifier dev.dsh.desktop）可能残留。本钩子只负责三件事：
;   1) 旧版主程序仍在、且**没有任何 dsh-desktop.exe 在运行**时，静默执行旧版
;      卸载器完成接管（/S + _?= 不触发"删除应用数据"页 → AppData 数据保留）；
;   2) 旧版主程序已不存在时，删除孤儿 uninstall.exe —— 否则每次安装都会重跑
;      一个"按 exe 名杀进程"的旧版卸载器（见下）；
;   3) 兜底删除旧快捷方式 + 空目录回收（非空保留现场，绝不递归删）。
; 绝不触碰 dev 版、%APPDATA% 数据目录与本版安装目录。
;
; ⚠️ 2026-09-09 事故（勿回退成"无条件 ExecWait"）：
; 旧版卸载器（0.3.9）的 Section Uninstall 首句是
;   !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe"
; 旧版 MAINBINARYNAME = dsh-desktop，与**正式版 exe 同名**；静默模式（/S）下
; utils.nsh 的宏直接走 IfSilent → KillProcessCurrentUser，而 nsis-tauri-utils
; 的 get_processes() **只比较 exe 名（不看路径）** → 静默安装 dev 版时把用户
; 正在使用的正式版 TerminateProcess 掉（无提示、无 WER 事件，事后像"无故消失"）。
; 旧钩子的 wmic 探测只查旧版路径（结构上不可能发现正式版），且 Win11 24H2+
; 已移除 WMIC → 探测失败即 fail-open，必然放行。
; 因此执行旧版卸载器前必须用**与卸载器同源**的名字级检测
; （nsis_tauri_utils::FindProcessCurrentUser "dsh-desktop.exe" = 同名 + 同用户
; SID，与旧版卸载器 KillProcessCurrentUser 的谓词完全一致）；命中即绝不执行。
;
; 只用 PREINSTALL：不依赖安装是否成功，也不新增第二个插入点（NSIS 标签是脚本
; 全局的，多插入点必须改名，徒增风险）。

!ifndef LEGACY_DIR
  !define LEGACY_DIR "$LOCALAPPDATA\dsh Desktop"
!endif

!macro NSIS_HOOK_PREINSTALL
  ; 仅正式版安装器接管旧版：正向匹配，名字被改坏时退化为"不接管"（fail-safe）；
  ; dev 版（MAINBINARYNAME=dsh-desktop-dev）不接管——它的存在意义就是与正式版
  ; 同机并存，绝不能替正式版做任何"按名杀进程"的动作。
  !if "${MAINBINARYNAME}" == "dsh-desktop"
    IfFileExists "${LEGACY_DIR}\uninstall.exe" 0 legacy_pre_done

    IfFileExists "${LEGACY_DIR}\dsh-desktop.exe" legacy_pre_has_app legacy_pre_orphan

    ; ── 旧版主程序仍在：只有确认"没有同名进程在跑"才执行旧版卸载器 ──
    legacy_pre_has_app:
      nsis_tauri_utils::FindProcessCurrentUser "dsh-desktop.exe"
      Pop $R0
      StrCmp $R0 0 legacy_pre_done
      ; 到这里才安全：旧版装过、主程序在、且没有任何 dsh-desktop.exe 在运行
      ExecWait '"${LEGACY_DIR}\uninstall.exe" /S "_?=${LEGACY_DIR}"' $R1
      Goto legacy_pre_done

    ; ── 旧版主程序已不存在：卸载器是孤儿，删除它切断"每次安装按名杀进程" ──
    legacy_pre_orphan:
      Delete "${LEGACY_DIR}\uninstall.exe"

    legacy_pre_done:
      ; 兜底删除已知旧快捷方式（存在才删）；空目录才回收，非空保留现场
      Delete "$DESKTOP\DSH Desktop.lnk"
      Delete "$SMPROGRAMS\DSH Desktop.lnk"
      RMDir "${LEGACY_DIR}"
  !endif
!macroend
