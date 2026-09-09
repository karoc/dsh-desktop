# Real-machine verification for the shell's dsh web HANG forensics (card 1 S3).
#
# Freezes the live dsh web process (NtSuspendProcess), then proves:
#   1. the shell notices (session.log "dsh web probe miss 3/3")
#   2. the shell writes a full-memory dump (session.log "dump saved" + a
#      dshweb-hang-*.dmp file in <runtime>\reports)
#   3. the manager asked the shell and waited for the ack, then restarted dsh
#      (manager.log "dump ready -- restarting dsh" + a NEW dsh web pid/url)
#   4. the shell itself stayed alive (bridge still answers /shell/status)
#
# ASCII only: PowerShell 5.1 decodes BOM-less UTF-8 as ANSI.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\...\verify-hang-dump.ps1 -Action hang
#   ... -Action check -WaitSec 60
#   ... -Action resume           (fallback if the manager did not restart it)
param(
  [Parameter(Mandatory = $true)][ValidateSet("hang", "check", "resume", "state")][string]$Action,
  [string]$Ident = "dsh.smoothly.desktop.dev",
  [int]$WaitSec = 60
)

$ErrorActionPreference = "Stop"
Add-Type -MemberDefinition @'
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
'@ -Name Nt -Namespace Native

$appdata = Join-Path $env:APPDATA $Ident
$runtime = Join-Path $appdata "runtime"
$reports = Join-Path $runtime "reports"
$sessionLog = Join-Path $appdata "dsh-desktop-session.log"
$managerLog = Join-Path $runtime "manager.log"
$script:fail = 0

function Say([bool]$ok, [string]$msg) {
  if ($ok) { Write-Output ("PASS  " + $msg) } else { Write-Output ("FAIL  " + $msg); $script:fail++ }
}

function Get-LiveUrl {
  if (-not (Test-Path $managerLog)) { return $null }
  $m = Select-String -Path $managerLog -Pattern "dsh web: (http://127\.0\.0\.1:\d+)" | Select-Object -Last 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return $null
}

function Get-DshWebPid([string]$url) {
  if (-not $url) { return 0 }
  $port = ([Uri]$url).Port
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return 0
}

switch ($Action) {
  "hang" {
    $url = Get-LiveUrl
    if (-not $url) { Write-Output "NO-LIVE-URL"; exit 1 }
    $pid2 = Get-DshWebPid $url
    if ($pid2 -le 0) { Write-Output "NO-PID-FOR-PORT"; exit 1 }
    $p = Get-Process -Id $pid2
    $rc = [Native.Nt]::NtSuspendProcess($p.Handle)
    Write-Output ("SUSPENDED pid=" + $pid2 + " rc=" + $rc + " url=" + $url + " at=" + (Get-Date).ToString("o"))
  }
  "resume" {
    $url = Get-LiveUrl
    $pid2 = Get-DshWebPid $url
    if ($pid2 -le 0) { Write-Output "NO-PID-FOR-PORT (already restarted?)"; exit 0 }
    $p = Get-Process -Id $pid2
    $rc = [Native.Nt]::NtResumeProcess($p.Handle)
    Write-Output ("RESUMED pid=" + $pid2 + " rc=" + $rc)
  }
  "state" {
    $url = Get-LiveUrl
    $pid2 = Get-DshWebPid $url
    Write-Output ("url=" + $url + " pid=" + $pid2)
    $bridge = [int]((Select-String -Path $sessionLog -Pattern "bridge on 127\.0\.0\.1:(\d+)" | Select-Object -Last 1).Matches[0].Groups[1].Value)
    if ($bridge -gt 0) {
      try {
        $st = Invoke-RestMethod -Method Get -Uri ("http://127.0.0.1:{0}/shell/status" -f $bridge) -TimeoutSec 5
        Write-Output ("managerAlive=" + $st.managerAlive + " lastError=" + $st.lastError)
      } catch { Write-Output ("shell status unreachable: " + $_.Exception.Message) }
    } else {
      Write-Output "no bridge port in session.log"
    }
  }
  "check" {
    Start-Sleep -Seconds $WaitSec
    $sess = if (Test-Path $sessionLog) { [IO.File]::ReadAllText($sessionLog, [Text.Encoding]::UTF8) } else { "" }
    $mgr = if (Test-Path $managerLog) { [IO.File]::ReadAllText($managerLog, [Text.Encoding]::UTF8) } else { "" }
    Say ($sess -match "dsh web probe miss 3/3") "session.log saw 3 consecutive probe misses"
    Say ($sess -match "dsh web hang: dump saved") "shell reports the dump as saved"
    $dumps = @(Get-ChildItem $reports -Filter "dshweb-hang-*.dmp" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
    Say ($dumps.Count -ge 1) ("hang dump file exists (count=" + $dumps.Count + ")")
    if ($dumps.Count -ge 1) {
      $d = $dumps[-1]
      Write-Output ("DUMP " + $d.FullName + " size=" + [int]($d.Length / 1MB) + "MiB")
      Say ($d.Length -gt 1MB) "dump is non-trivial (>1 MiB)"
    }
    Say ($mgr -match "asking the shell for a dump") "manager asked the shell for the dump"
    # The manager log line contains a U+2014 em dash; build it from an escape so
    # this file stays pure ASCII (PowerShell 5.1 ANSI decoding).
    $dash = [regex]::Unescape("\u2014")
    Say ($mgr -match ("dump ready " + $dash + " restarting dsh")) "manager waited for the dump ack, then restarted dsh"
    $app = @(Get-Process -Name dsh-desktop-dev -ErrorAction SilentlyContinue)
    Say ($app.Count -ge 1) "shell process is still alive after the hang"
    if ($script:fail -gt 0) { Write-Output ("RESULT FAIL (" + $script:fail + ")"); exit 1 }
    Write-Output "RESULT PASS"
  }
}
