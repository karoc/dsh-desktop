# Branch-logic test for the fixed NSIS legacy-takeover hook (pure ASCII: PS 5.1
# decodes BOM-less UTF-8 as ANSI and would mangle non-ASCII literals).
# Uses a SIMULATED legacy dir under $env:TEMP; the real %LOCALAPPDATA%\dsh Desktop
# is never touched. Only copies where.exe into a temp folder and runs a locally
# built probe exe.
param(
  [Parameter(Mandatory = $true)][string]$Nsh,
  [Parameter(Mandatory = $true)][string]$TestNsi
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:TEMP 'nsi-hook-test'
$sim = Join-Path $env:TEMP 'legacy-sim'
$makensis = 'C:\Users\qqwto\AppData\Local\tauri\NSIS\Bin\makensis.exe'

Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item $Nsh (Join-Path $dir 'legacy-takeover.nsh') -Force
Copy-Item $TestNsi (Join-Path $dir 'test.nsi') -Force

Push-Location $dir
& $makensis -INPUTCHARSET UTF8 'test.nsi' | Select-Object -Last 1
$mk = $LASTEXITCODE
Pop-Location
Write-Output ("makensis-exit=" + $mk)
if ($mk -ne 0) { exit 1 }

function Invoke-Scenario {
  param([string]$Name, [bool]$WithUninstaller, [bool]$WithMainApp, [bool]$MainAppRunning = $false)
  # A leftover probe process from the previous scenario can hold files in the sim
  # dir; wait for it to exit before recreating the tree.
  Get-Process probe2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  Remove-Item $sim -Recurse -Force -ErrorAction SilentlyContinue
  $simDesktop = Join-Path $env:TEMP 'legacy-sim-desktop'
  Remove-Item $simDesktop -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $simDesktop | Out-Null
  if ($WithUninstaller -or $WithMainApp) { New-Item -ItemType Directory -Force -Path $sim | Out-Null }
  if ($WithUninstaller) { Copy-Item "$env:SystemRoot\System32\where.exe" (Join-Path $sim 'uninstall.exe') -Force }
  if ($WithMainApp)     { Copy-Item "$env:SystemRoot\System32\where.exe" (Join-Path $sim 'dsh-desktop.exe') -Force }
  # A shortcut that the hook would delete if it reaches the shared cleanup tail.
  Set-Content -Path (Join-Path $simDesktop 'DSH Desktop.lnk') -Value 'probe' -Encoding ASCII

  # Simulate "a same-named process is running": the hook's predicate is image name
  # + current-user SID, so a same-named copy under another path works.
  $fake = $null
  if ($MainAppRunning) {
    $fakeDir = Join-Path $env:TEMP 'legacy-sim-running'
    Get-Process dsh-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*legacy-sim-running*' } | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item $fakeDir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $fakeDir | Out-Null
    Copy-Item "$env:SystemRoot\System32\timeout.exe" (Join-Path $fakeDir 'dsh-desktop.exe') -Force
    $fake = Start-Process -FilePath (Join-Path $fakeDir 'dsh-desktop.exe') -ArgumentList '/T','30' -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 900
  }

  Remove-Item (Join-Path $dir 'result.txt') -Force -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath (Join-Path $dir 'probe2.exe') -PassThru -Wait
  # The probe writes result.txt itself; wait until it is readable (the exe may
  # still hold the handle for a moment after the process exits).
  $resPath = Join-Path $dir 'result.txt'
  $waited = 0
  while (-not (Test-Path $resPath) -and $waited -lt 40) { Start-Sleep -Milliseconds 100; $waited++ }
  $res = 'NO-RESULT'
  for ($i = 0; $i -lt 20; $i++) {
    try { $res = (Get-Content $resPath -Raw).Trim(); break } catch { Start-Sleep -Milliseconds 150 }
  }

  $mainAfter = Test-Path (Join-Path $sim 'dsh-desktop.exe')
  $lnkAfter = Test-Path (Join-Path $simDesktop 'DSH Desktop.lnk')
  $flat = ($res -replace "`r`n", ' ').Trim()
  Write-Output ("[" + $Name + "] " + $flat + "  main-app-after=" + $mainAfter + " shortcut-after=" + $lnkAfter)

  if ($null -ne $fake) { Stop-Process -Id $fake.Id -Force -ErrorAction SilentlyContinue }
}

Write-Output "--- scenario 1: orphan uninstaller (no legacy main exe) -> expect GONE"
Invoke-Scenario -Name 'orphan' -WithUninstaller $true -WithMainApp $false

Write-Output "--- scenario 2: legacy app present, no same-named process -> expect PRESENT + shortcut GONE (cleanup tail runs)"
Invoke-Scenario -Name 'legacy-app-idle' -WithUninstaller $true -WithMainApp $true

Write-Output "--- scenario 3: legacy app present AND same-named process RUNNING -> expect PRESENT + shortcut PRESENT (refuse takeover, touch nothing)"
Invoke-Scenario -Name 'legacy-app-running' -WithUninstaller $true -WithMainApp $true -MainAppRunning $true

Write-Output "--- scenario 4: no legacy leftovers -> expect GONE (no-op)"
Invoke-Scenario -Name 'no-legacy' -WithUninstaller $false -WithMainApp $false

# ── L0 uninstall notice: must never block silent or /UPDATE runs ────────────
# The hook is inserted at the top of Section Uninstall, BEFORE CheckIfAppIsRunning,
# and auto-update calls `uninstall.exe /UPDATE`. A MessageBox there would hang an
# unattended update, so silent and UPDATE modes must both fall straight through.
function Invoke-UninstallNoticeProbe {
  param([string]$Name, [bool]$UpdateMode)
  $probeDir = Join-Path $env:TEMP 'nsi-l0-probe'
  Remove-Item $probeDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $probeDir | Out-Null
  Copy-Item $Nsh (Join-Path $probeDir 'legacy-takeover.nsh') -Force
  $um = if ($UpdateMode) { 1 } else { 0 }
  $nsi = @"
!addplugindir "C:\Users\qqwto\AppData\Local\tauri\NSIS\Plugins\x86-unicode\additional"
!define MAINBINARYNAME "dsh-desktop"
OutFile "probe-l0.exe"
RequestExecutionLevel user
SilentInstall silent
Var UpdateMode
!include "legacy-takeover.nsh"
Section
  StrCpy `$UpdateMode $um
  !insertmacro NSIS_HOOK_PREUNINSTALL
  FileOpen `$9 "`$EXEDIR\l0.txt" w
  FileWrite `$9 "PASSED"
  FileClose `$9
SectionEnd
"@
  Set-Content -Path (Join-Path $probeDir 'probe.nsi') -Value $nsi -Encoding UTF8
  Push-Location $probeDir
  & $makensis -INPUTCHARSET UTF8 'probe.nsi' | Out-Null
  $mk = $LASTEXITCODE
  Pop-Location
  if ($mk -ne 0) { Write-Output ("[" + $Name + "] COMPILE-FAILED"); return }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Start-Process -FilePath (Join-Path $probeDir 'probe-l0.exe') -Wait
  $sw.Stop()
  $ok = Test-Path (Join-Path $probeDir 'l0.txt')
  $verdict = if ($ok -and $sw.ElapsedMilliseconds -lt 5000) { 'NO-BLOCK' } else { 'BLOCKED-OR-FAILED' }
  Write-Output ("[" + $Name + "] " + $verdict + " elapsed-ms=" + $sw.ElapsedMilliseconds)
}

Write-Output "--- scenario 5: uninstall notice, silent mode -> expect NO-BLOCK"
Invoke-UninstallNoticeProbe -Name 'notice-silent' -UpdateMode $false

Write-Output "--- scenario 6: uninstall notice, /UPDATE mode -> expect NO-BLOCK (auto-update must not hang)"
Invoke-UninstallNoticeProbe -Name 'notice-update' -UpdateMode $true

Remove-Item $sim -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:TEMP 'legacy-sim-desktop') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:TEMP 'legacy-sim-running') -Recurse -Force -ErrorAction SilentlyContinue
