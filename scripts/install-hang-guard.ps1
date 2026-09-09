# Install / uninstall the external dsh-desktop guard as a per-user login
# startup entry (no admin rights needed).
#
#   scripts/dsh-hang-guard.ps1            the guard itself (source of truth)
#   %LOCALAPPDATA%\dsh-hang-guard\        installed copy (stable path that
#                                         survives repo re-checkouts)
#   <Startup>\dsh-hang-guard-<app>.lnk    login shortcut (hidden window)
#
# The guard is DETECT-ONLY by default (decision D1: never restart behind the
# user's back while the root cause is still being hunted). Pass -AutoRestart to
# let it also POST the bridge /restart and relaunch the shell.
#
# ASCII only (PowerShell 5.1 decodes BOM-less UTF-8 as ANSI).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install-hang-guard.ps1
#   powershell -ExecutionPolicy Bypass -File .\install-hang-guard.ps1 -App dev
#   powershell -ExecutionPolicy Bypass -File .\install-hang-guard.ps1 -AutoRestart
#   powershell -ExecutionPolicy Bypass -File .\install-hang-guard.ps1 -Uninstall
param(
  [ValidateSet("prod", "dev")][string]$App = "prod",
  [switch]$AutoRestart,
  [switch]$Uninstall,
  [string]$Source = (Join-Path $PSScriptRoot "dsh-hang-guard.ps1")
)
$ErrorActionPreference = "Stop"

$installDir = Join-Path $env:LOCALAPPDATA "dsh-hang-guard"
$target = Join-Path $installDir "dsh-hang-guard.ps1"
$startup = [Environment]::GetFolderPath("Startup")
$lnkPath = Join-Path $startup ("dsh-hang-guard-" + $App + ".lnk")

if ($Uninstall) {
  Remove-Item $lnkPath -Force -ErrorAction SilentlyContinue
  Remove-Item $target -Force -ErrorAction SilentlyContinue
  Write-Output ("uninstalled (removed shortcut " + $lnkPath + ")")
  exit 0
}

if (-not (Test-Path $Source)) { Write-Output ("source not found: " + $Source); exit 1 }
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item $Source $target -Force

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$guardArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $target + "`" -App " + $App
if ($AutoRestart) { $guardArgs += " -AutoRestart" }
$lnk.Arguments = $guardArgs
$lnk.WorkingDirectory = $installDir
$lnk.WindowStyle = 7
$lnk.Description = "dsh-desktop external guard (process sampler + hang watcher)"
$lnk.Save()

Write-Output ("installed shortcut: " + $lnkPath)
Write-Output ("guard script:       " + $target)
Write-Output ("mode:               " + $(if ($AutoRestart) { "detect + auto-restart" } else { "detect-only (D1)" }))
Write-Output ("guard log:          " + (Join-Path $env:LOCALAPPDATA ("dsh-hang-guard-" + $App + ".log")))
Write-Output "Re-run this installer after updating scripts/dsh-hang-guard.ps1 to refresh the copy."
