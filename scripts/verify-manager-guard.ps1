# Real-machine verification for the shell's manager guard (no auto-restart).
#
# Proves, against a RUNNING shell (dev identity by default), that killing the
# server-manager process is:
#   1. DETECTED   - session.log "manager exit: gen=" + /shell/status.lastManagerExit
#   2. FORENSIC   - a new <runtime>\reports\manager-crash-*-genN dir containing
#                   summary.json (exitCode 1 / 0x00000001), manager.log.tail,
#                   shell-session.log.tail, orphans.txt, wer.txt
#   3. NOT AUTO-RESTARTED - no new server-manager process appears afterwards
#   4. RECOVERABLE - POST /restart brings a fresh manager back
#
# ASCII only: PowerShell 5.1 decodes BOM-less UTF-8 files as ANSI, so non-ASCII
# literals would be mangled (see .dsh/skills/dsh-desktop-shell-dev).
#
# Usage (from WSL, after copying this file to a Windows-readable path):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\Dev\_scripts\verify-manager-guard.ps1 -Action all
param(
  [Parameter(Mandatory = $true)][ValidateSet("kill", "check", "status", "restart", "cleanup", "all")][string]$Action,
  [string]$Ident = "dsh.smoothly.desktop.dev",
  [int]$WaitSec = 10
)

$ErrorActionPreference = "Stop"
$appdata = Join-Path $env:APPDATA $Ident
$runtime = Join-Path $appdata "runtime"
$reports = Join-Path $runtime "reports"
$sessionLog = Join-Path $appdata "dsh-desktop-session.log"
$script:fail = 0

function Say([bool]$ok, [string]$msg) {
  if ($ok) { Write-Output ("PASS  " + $msg) } else { Write-Output ("FAIL  " + $msg); $script:fail++ }
}

function Get-ManagerProcs {
  # NOTE: call sites MUST wrap this in @(): PowerShell 5.1 CimInstance scalars
  # have no .Count, so a single match would otherwise read as "none".
  $marker = $runtime.Replace("/", "\")
  return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and $_.CommandLine -match "server-manager\.mjs" -and $_.CommandLine -like ("*" + $marker + "*")
    })
}

function Get-BridgePort {
  if (-not (Test-Path $sessionLog)) { return 0 }
  $m = Select-String -Path $sessionLog -Pattern "bridge on 127\.0\.0\.1:(\d+)" | Select-Object -Last 1
  if ($m) { return [int]$m.Matches[0].Groups[1].Value }
  return 0
}

function Get-ShellStatus {
  $port = Get-BridgePort
  if ($port -le 0) { return $null }
  try { return Invoke-RestMethod -Method Get -Uri ("http://127.0.0.1:{0}/shell/status" -f $port) -TimeoutSec 5 } catch { return $null }
}

function Invoke-Kill {
  $procs = @(Get-ManagerProcs)
  if ($procs.Count -ne 1) { Write-Output ("MANAGER-COUNT " + $procs.Count); exit 1 }
  $mgrPid = $procs[0].ProcessId
  Write-Output ("MANAGER pid=" + $mgrPid)
  taskkill /PID $mgrPid /F | Out-Null
  Write-Output ("KILLED at " + (Get-Date).ToString("o"))
}

function Invoke-Check {
  Start-Sleep -Seconds $WaitSec
  $procs = @(Get-ManagerProcs)
  Say ($procs.Count -eq 0) ("no auto-restart: manager processes now = " + $procs.Count)

  $dirs = @(Get-ChildItem $reports -Directory -Filter "manager-crash-*" -ErrorAction SilentlyContinue | Sort-Object Name)
  Say ($dirs.Count -ge 1) ("evidence dir exists (count=" + $dirs.Count + ")")
  if ($dirs.Count -ge 1) {
    $d = $dirs[-1].FullName
    Write-Output ("EVIDENCE " + $d)
    $sum = Get-Content (Join-Path $d "summary.json") -Raw | ConvertFrom-Json
    Say ($sum.exitCode -eq 1) ("summary exitCode = " + $sum.exitCode)
    Say ($sum.exitCodeHex -eq "0x00000001") ("summary exitCodeHex = " + $sum.exitCodeHex)
    Say (($sum.detectedBy -eq "stdout-eof") -or ($sum.detectedBy -eq "watchdog")) ("detectedBy = " + $sum.detectedBy)
    Say ($sum.generation -ge 1) ("generation = " + $sum.generation)
    foreach ($f in @("manager.log.tail", "shell-session.log.tail", "orphans.txt", "wer.txt")) {
      Say (Test-Path (Join-Path $d $f)) ("evidence file " + $f)
    }
    $orphans = Get-Content (Join-Path $d "orphans.txt") -Raw
    Say ($orphans -match "pid=") "orphans.txt lists the surviving dsh web node(s)"
  }

  $hit = $null
  if (Test-Path $sessionLog) { $hit = Select-String -Path $sessionLog -Pattern "manager exit: gen=" | Select-Object -Last 1 }
  Say ($null -ne $hit) "session.log records the exit"

  $st = Get-ShellStatus
  if ($null -eq $st) {
    Say $false "bridge /shell/status reachable"
  } else {
    Say (-not $st.managerAlive) ("/shell/status managerAlive=" + $st.managerAlive)
    Say ($null -ne $st.lastManagerExit) "/shell/status lastManagerExit present"
    if ($st.lastManagerExit) {
      Say ($st.lastManagerExit.hex -eq "0x00000001") ("lastManagerExit.hex = " + $st.lastManagerExit.hex)
    }
  }

  if ($script:fail -gt 0) { Write-Output ("RESULT FAIL (" + $script:fail + ")"); exit 1 }
  Write-Output "RESULT PASS"
}

switch ($Action) {
  "kill" { Invoke-Kill }
  "check" { Invoke-Check }
  "status" {
    $st = Get-ShellStatus
    if ($null -eq $st) { Write-Output "STATUS unreachable"; exit 1 }
    $st | ConvertTo-Json -Depth 6
  }
  "cleanup" {
    # Orphans left by the kill (dsh web) - kill them BEFORE a restart so the
    # new tree does not coexist with a stale port holder.
    $procs = @(Get-ManagerProcs)
    $killed = 0
    foreach ($p in $procs) { taskkill /PID $p.ProcessId /T /F | Out-Null; $killed++ }
    Write-Output ("CLEANUP killed " + $killed + " node process tree(s) for " + $Ident)
  }
  "restart" {
    $port = Get-BridgePort
    if ($port -le 0) { Write-Output "NO-BRIDGE-PORT"; exit 1 }
    try {
      Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:{0}/restart" -f $port) -ContentType "application/json" -Body "{}" -TimeoutSec 10 | Out-Null
    } catch { Write-Output ("RESTART-REQUEST-FAILED " + $_.Exception.Message); exit 1 }
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      if ((@(Get-ManagerProcs)).Count -ge 1) { $ok = $true; break }
    }
    Say $ok "POST /restart brought the manager back"
    if (-not $ok) { exit 1 }
  }
  "all" {
    Invoke-Kill
    Invoke-Check
  }
}
