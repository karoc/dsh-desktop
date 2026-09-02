; ── 旧版接管（legacy takeover）───────────────────────────────────────────────
; 0.3.x → 0.4.x 品牌统一后旧安装（%LOCALAPPDATA%\dsh Desktop）可能残留：
; 未运行则静默卸载（/S + _?=，不触发"删除应用数据"页 → AppData 数据保留）；
; 运行中则弹窗提示先退出并中止安装。绝不触碰 dev 版与 %APPDATA% 数据目录。
; 本钩子尽力而为：任何一步失败都继续安装（首启的 Rust 兜底会再检测/清理）。

!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$LOCALAPPDATA\dsh Desktop\uninstall.exe" 0 legacy_done
  ; 旧版是否在运行（wmic 在新 Windows 可能缺省；失败按"未运行"处理，
  ; 卸载器对运行中的 exe 会失败且不删文件，风险可控，L2 首启兜底会复查）
  nsExec::ExecToStack 'cmd /c wmic process where "ExecutablePath=''$LOCALAPPDATA\dsh Desktop\dsh-desktop.exe''" get ProcessId /value'
  Pop $0 ; exit code
  Pop $1 ; output
  StrCpy $2 $1
  StrCmp $2 "" legacy_not_running
  StrCmp $0 "0" 0 legacy_not_running
  MessageBox MB_OK|MB_ICONEXCLAMATION "检测到旧版 DSH Desktop 正在运行。$(^Name) 升级需要接管旧版，请先退出旧版（托盘图标右键 → 退出），再重新运行安装程序。"
  Abort
legacy_not_running:
  ; 静默卸载旧版：/S 静默；_?= 让卸载器不删除自身（NSIS 标准静默卸载）
  ExecWait '"$LOCALAPPDATA\dsh Desktop\uninstall.exe" /S _?=$LOCALAPPDATA\dsh Desktop'
  ; 兜底删除已知旧快捷方式（卸载器通常已删，存在才删）
  Delete "$DESKTOP\DSH Desktop.lnk"
  Delete "$SMPROGRAMS\DSH Desktop.lnk"
  ; 卸载器不会删残留目录；仅当确实已空才回收，非空保留现场
  RMDir "$LOCALAPPDATA\dsh Desktop"
legacy_done:
!macroend