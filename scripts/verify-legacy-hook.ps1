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
  param([string]$Name, [bool]$WithUninstaller, [bool]$WithMainApp)
  Remove-Item $sim -Recurse -Force -ErrorAction SilentlyContinue
  if ($WithUninstaller -or $WithMainApp) { New-Item -ItemType Directory -Force -Path $sim | Out-Null }
  if ($WithUninstaller) { Copy-Item "$env:SystemRoot\System32\where.exe" (Join-Path $sim 'uninstall.exe') -Force }
  if ($WithMainApp)     { Copy-Item "$env:SystemRoot\System32\where.exe" (Join-Path $sim 'dsh-desktop.exe') -Force }
  Remove-Item (Join-Path $dir 'result.txt') -Force -ErrorAction SilentlyContinue

  & (Join-Path $dir 'probe2.exe')
  Start-Sleep -Milliseconds 900

  $res = if (Test-Path (Join-Path $dir 'result.txt')) { (Get-Content (Join-Path $dir 'result.txt') -Raw).Trim() } else { 'NO-RESULT' }
  $mainAfter = Test-Path (Join-Path $sim 'dsh-desktop.exe')
  Write-Output ("[" + $Name + "] " + $res + "  main-app-after=" + $mainAfter)
}

Write-Output "--- scenario 1: orphan uninstaller (no legacy main exe) -> expect GONE"
Invoke-Scenario -Name 'orphan' -WithUninstaller $true -WithMainApp $false

Write-Output "--- scenario 2: legacy app present + production shell RUNNING -> expect PRESENT (uninstaller NOT executed)"
Invoke-Scenario -Name 'legacy-app+shell-running' -WithUninstaller $true -WithMainApp $true

Write-Output "--- scenario 3: no legacy leftovers -> expect GONE (no-op)"
Invoke-Scenario -Name 'no-legacy' -WithUninstaller $false -WithMainApp $false

Remove-Item $sim -Recurse -Force -ErrorAction SilentlyContinue
