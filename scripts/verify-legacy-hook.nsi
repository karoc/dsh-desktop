; Hook logic test: include the REAL fixed hook and exercise its branches with a
; simulated legacy dir ($LOCALAPPDATA\Temp\legacy-sim) — never touches the real
; %LOCALAPPDATA%\dsh Desktop. Writes the post-condition to result.txt.
;
; Also records whether the hook deleted the legacy shortcuts. The 2026-09-17 fix
; separated the "legacy app is RUNNING -> refuse takeover" branch from the shared
; cleanup tail: that branch used to fall through to the shortcut deletes, so a
; still-running legacy app kept running while its entry points vanished. The
; shortcut probes point at a SIMULATED desktop dir (real desktop never touched).
!addplugindir "C:\Users\qqwto\AppData\Local\tauri\NSIS\Plugins\x86-unicode\additional"
!define MAINBINARYNAME "dsh-desktop"
!define LEGACY_DIR "$LOCALAPPDATA\Temp\legacy-sim"
!define SIM_DESKTOP "$LOCALAPPDATA\Temp\legacy-sim-desktop"
; Override the hook's shortcut targets (defaults to the real built-ins).
!define LEGACY_DESKTOP "${SIM_DESKTOP}"
!define LEGACY_PROGRAMS "${SIM_DESKTOP}"
OutFile "probe2.exe"
RequestExecutionLevel user
SilentInstall silent
!include "legacy-takeover.nsh"
Section
  ; Route the hook's shortcut deletes at the simulated desktop dir so the test
  ; can observe them. $DESKTOP / $SMPROGRAMS are NSIS built-ins (not !undef-able),
  ; so the hook reads them through LEGACY_DESKTOP / LEGACY_PROGRAMS, which default
  ; to the real built-ins and are overridden here for the probe only.
  !insertmacro NSIS_HOOK_PREINSTALL
  FileOpen $2 "$EXEDIR\result.txt" w
  IfFileExists "${LEGACY_DIR}\uninstall.exe" res_present res_gone
res_present:
  FileWrite $2 "uninstaller=PRESENT$\r$\n"
  Goto res_done
res_gone:
  FileWrite $2 "uninstaller=GONE$\r$\n"
res_done:
  IfFileExists "${SIM_DESKTOP}\DSH Desktop.lnk" lnk_present lnk_gone
lnk_present:
  FileWrite $2 "shortcut=PRESENT$\r$\n"
  Goto lnk_done
lnk_gone:
  FileWrite $2 "shortcut=GONE$\r$\n"
lnk_done:
  FileClose $2
SectionEnd
