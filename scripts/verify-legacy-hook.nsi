; Hook logic test: include the REAL fixed hook and exercise its branches with a
; simulated legacy dir ($LOCALAPPDATA\Temp\legacy-sim) — never touches the real
; %LOCALAPPDATA%\dsh Desktop. Writes the post-condition to result.txt.
!addplugindir "C:\Users\qqwto\AppData\Local\tauri\NSIS\Plugins\x86-unicode\additional"
!define MAINBINARYNAME "dsh-desktop"
!define LEGACY_DIR "$LOCALAPPDATA\Temp\legacy-sim"
OutFile "probe2.exe"
RequestExecutionLevel user
SilentInstall silent
!include "legacy-takeover.nsh"
Section
  !insertmacro NSIS_HOOK_PREINSTALL
  FileOpen $2 "$EXEDIR\result.txt" w
  IfFileExists "${LEGACY_DIR}\uninstall.exe" res_present res_gone
res_present:
  FileWrite $2 "uninstaller=PRESENT$\r$\n"
  Goto res_done
res_gone:
  FileWrite $2 "uninstaller=GONE$\r$\n"
res_done:
  FileClose $2
SectionEnd
