<#
.SYNOPSIS
  dsh-desktop external guard: process-table sampler + dsh web hang watcher.

.DESCRIPTION
  Runs OUTSIDE the dsh tree (started from the login startup folder), so it keeps
  watching when the shell itself dies. Two jobs:

  1) KILLER CATCHER (500 ms sampler). Keeps a rolling window of the processes
     that matter (node / dsh-desktop / taskkill / powershell / pwsh / cmd). When
     one of them vanishes, the window plus the command lines of any suspects
     that appeared in the previous 2 s are written to the evidence dir. This is
     the only unprivileged way to answer "who killed the tree?" -- the
     TerminateProcess itself leaves no OS record.

  2) HANG WATCHER. Probes the live dsh web URL (read from manager.log) every
     IntervalSec. After MissLimit consecutive misses it snapshots evidence.
     The shell itself already dumps the hung process (MiniDumpWriteDump) and the
     manager restarts it, so this guard defaults to DETECT ONLY (decision D1:
     never restart behind the user's back while we are still hunting the root
     cause). Pass -AutoRestart to also POST the bridge /restart.

  NOTE: the old rundll32 comsvcs dump path was removed -- on this machine it
  hung for its full 20 s timeout and produced nothing (6/6 attempts).

.PARAMETER App
  prod = production identity (default); dev = development build.

.PARAMETER IntervalSec
  dsh web probe interval in seconds (default 3).

.PARAMETER MissLimit
  consecutive probe misses before evidence is captured (default 3, ~9 s).

.PARAMETER GraceSec
  startup grace after a (new) URL appears; slow boot is not a hang (default 30).

.PARAMETER AutoRestart
  Also POST the bridge /restart on a hang, and relaunch the shell exe if the
  shell process disappeared. OFF by default (D1).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\dsh-hang-guard.ps1 -App dev
#>
param(
  [ValidateSet("prod", "dev")][string]$App = "prod",
  [int]$IntervalSec = 3,
  [int]$MissLimit = 3,
  [int]$GraceSec = 30,
  [switch]$AutoRestart
)
$ErrorActionPreference = "Continue"

$Identity = if ($App -eq "dev") { "dsh.smoothly.desktop.dev" } else { "dsh.smoothly.desktop" }
$ExeName = if ($App -eq "dev") { "dsh-desktop-dev" } else { "dsh-desktop" }
$APPD = Join-Path $env:APPDATA $Identity
$managerLog = Join-Path $APPD "runtime\manager.log"
$sessionLog = Join-Path $APPD "dsh-desktop-session.log"
$evidenceRoot = Join-Path $env:LOCALAPPDATA ("dsh-hang-" + $App + "-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$guardLog = Join-Path $env:LOCALAPPDATA ("dsh-hang-guard-" + $App + ".log")
$samplerMs = 500
$suspectWindowSec = 2
# Processes whose DISAPPEARANCE is evidence (the service tree). conhost/cmd are
# sampled as context only -- they churn constantly and would drown the log.
$trackNames = @("node", "dsh-desktop", "dsh-desktop-dev", "msedgewebview2")
# Processes that can be the killer, reported when a tracked process vanishes.
# conhost is deliberately absent: it is a console host, not a launcher, and it
# churns on every console app.
$suspectNames = @("taskkill", "powershell", "pwsh", "cmd")
$watchNames = $trackNames + $suspectNames

function Write-Guard([string]$msg) {
  $line = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " " + $msg
  # Rotate at 2 MB: this file is appended for the whole session lifetime.
  if ((Test-Path $guardLog) -and ((Get-Item $guardLog -ErrorAction SilentlyContinue).Length -gt 2MB)) {
    Move-Item $guardLog ($guardLog + ".1") -Force -ErrorAction SilentlyContinue
  }
  Add-Content -Path $guardLog -Value $line -ErrorAction SilentlyContinue
  Write-Host $line
}

function Get-LatestDshUrl {
  $m = Select-String -Path $managerLog -Pattern "dsh web: (http://127\.0\.0\.1:\d+)" -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return $null
}
function Get-LatestBridgePort {
  $m = Select-String -Path $sessionLog -Pattern "bridge on 127\.0\.0\.1:(\d+)" -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($m) { return [int]$m.Matches[0].Groups[1].Value }
  return $null
}
function Test-WebAlive([string]$url) {
  # Any HTTP status counts as alive (a 401/404 still proves the event loop
  # answers). PS 5.1's Invoke-WebRequest THROWS on 4xx/5xx, so the status has to
  # be read off the exception -- the manager.log URL has no token, and a bare
  # probe always gets 401.
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
  } catch {
    $resp = $_.Exception.Response
    if ($null -ne $resp) {
      $code = [int]$resp.StatusCode
      return ($code -ge 200 -and $code -lt 500)
    }
    return $false
  }
}
function Request-BridgeRestart {
  $port = Get-LatestBridgePort
  if (-not $port) { Write-Guard "bridge port unknown -- cannot request restart"; return $false }
  try {
    Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port + "/restart") -Method POST -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop | Out-Null
    Write-Guard "bridge /restart accepted"
    return $true
  } catch {
    Write-Guard ("bridge /restart FAILED: " + $_.Exception.Message)
    return $false
  }
}
function Get-Snapshot {
  @(Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $watchNames -contains $_.ProcessName } |
    ForEach-Object {
      $started = $null
      try { $started = $_.StartTime } catch { }
      [pscustomobject]@{ Id = $_.Id; Name = $_.ProcessName; Started = $started; Cmd = $null }
    })
}
function Get-CmdLine([int]$processId) {
  try { return (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $processId) -ErrorAction Stop).CommandLine } catch { return $null }
}
function Snapshot-Evidence([string]$reason) {
  New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
  try {
    if (Test-Path $managerLog) { Get-Content $managerLog -Tail 300 | Set-Content (Join-Path $evidenceRoot "manager.log.tail.txt") }
    if (Test-Path $sessionLog) { Get-Content $sessionLog -Tail 300 | Set-Content (Join-Path $evidenceRoot "session.log.tail.txt") }
    Get-CimInstance Win32_Process |
      Where-Object { ($_.Name -match "node|dsh-desktop|msedgewebview2|taskkill|powershell|pwsh|cmd") } |
      Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine |
      Format-List | Out-String -Width 400 | Set-Content (Join-Path $evidenceRoot "processes.txt")
    Get-ChildItem (Join-Path $APPD "runtime\reports") -ErrorAction SilentlyContinue |
      Select-Object LastWriteTime, Length, Name |
      Sort-Object LastWriteTime -Descending | Format-Table -AutoSize | Out-String -Width 200 |
      Set-Content (Join-Path $evidenceRoot "reports.txt")
    Write-Guard "evidence snapshot -> $evidenceRoot (reason: $reason)"
  } catch { Write-Guard ("snapshot error: " + $_.Exception.Message) }
}
function Record-Vanished($gone, $suspects) {
  New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
  $out = Join-Path $evidenceRoot "vanish.log"
  $stamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff")
  foreach ($g in $gone) {
    $line = "$stamp VANISHED pid=$($g.Id) name=$($g.Name) started=$($g.Started)"
    Add-Content -Path $out -Value $line -ErrorAction SilentlyContinue
    Write-Guard $line
    foreach ($s in $suspects) {
      $sline = "        suspect within ${suspectWindowSec}s: pid=$($s.Id) name=$($s.Name) started=$($s.Started) cmd=$($s.Cmd)"
      Add-Content -Path $out -Value $sline -ErrorAction SilentlyContinue
      Write-Guard $sline
    }
  }
}

if (-not (Test-Path $managerLog)) {
  # Started from the login startup folder before the shell ever ran: keep
  # sampling and wait for the app instead of exiting (the URL probe is skipped
  # until manager.log exists).
  Write-Guard "manager.log not found yet at $managerLog -- waiting for the shell"
}

Write-Guard ("guard start app=$App interval=${IntervalSec}s miss-limit=$MissLimit grace=${GraceSec}s auto-restart=" + [bool]$AutoRestart + " evidence=$evidenceRoot")
# The guard itself (and the shell that launched it) are never "suspects": their
# command lines would otherwise flood the evidence with our own invocation.
$selfPid = $PID
$selfParent = 0
try { $selfParent = (Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID) -ErrorAction Stop).ParentProcessId } catch { }
$armed = $false
$armedAt = $null
$misses = 0
$appGoneCycles = 0
$prev = @{}
$nextProbe = [DateTime]::UtcNow

while ($true) {
  $snap = Get-Snapshot
  $now = [DateTime]::UtcNow

  # -- killer catcher: detect vanished processes + suspects born in the window -
  $cur = @{}
  foreach ($p in $snap) { $cur[[int]$p.Id] = $p }
  $gone = @()
  foreach ($id in $prev.Keys) {
    if ((-not $cur.ContainsKey($id)) -and ($trackNames -contains $prev[$id].Name)) {
      $gone += $prev[$id]
    }
  }
  if ($gone.Count -gt 0) {
    # $now is UTC while Get-Process StartTime is LOCAL -- compare in local time
    # or every suspect matches (the window subtraction goes negative).
    $localNow = [DateTime]::Now
    $suspects = @($snap | Where-Object {
      ($suspectNames -contains $_.Name) -and
      ($_.Id -ne $selfPid) -and ($_.Id -ne $selfParent) -and
      ($null -ne $_.Started) -and (($localNow - $_.Started).TotalSeconds -le $suspectWindowSec)
    })
    foreach ($s in $suspects) { if ($null -eq $s.Cmd) { $s.Cmd = Get-CmdLine ([int]$s.Id) } }
    Record-Vanished $gone $suspects
  }
  $prev = $cur

  # -- app liveness ------------------------------------------------------------
  $appRunning = @(Get-Process -Name $ExeName -ErrorAction SilentlyContinue).Count -gt 0
  if (-not $appRunning) {
    $appGoneCycles++
    if ($appGoneCycles -eq 2) {
      Write-Guard "shell process ($ExeName) is GONE"
      Snapshot-Evidence "shell process disappeared"
      if ($AutoRestart) {
        $exe = Join-Path $env:LOCALAPPDATA ("DSH Smoothly Desktop" + $(if ($App -eq "dev") { " Dev" } else { "" }) + "\" + $ExeName + ".exe")
        if (Test-Path $exe) {
          Start-Process -FilePath $exe | Out-Null
          Write-Guard ("relaunched shell: " + $exe)
        } else {
          Write-Guard ("shell exe not found: " + $exe)
        }
      }
    }
    if ($appGoneCycles -ge 4) { Write-Guard "shell absent for 4 cycles -- exiting"; break }
    Start-Sleep -Milliseconds $samplerMs
    continue
  }
  $appGoneCycles = 0

  # -- hang watcher (probe on its own cadence) ---------------------------------
  if ($now -ge $nextProbe) {
    $nextProbe = $now.AddSeconds($IntervalSec)
    $url = Get-LatestDshUrl
    if ($url) {
      if (Test-WebAlive $url) {
        if (-not $armed) { Write-Guard "armed on $url"; $armed = $true; $armedAt = $now }
        $misses = 0
      } elseif ($armed) {
        if ($null -ne $armedAt -and (($now - $armedAt).TotalSeconds -lt $GraceSec)) {
          # startup/reload grace: slow boot is not a hang
        } else {
          $misses++
          Write-Guard "miss $misses/$MissLimit on $url"
          if ($misses -ge $MissLimit) {
            Write-Guard "!!! dsh web UNRESPONSIVE ($url)"
            Snapshot-Evidence "unresponsive after $MissLimit misses"
            if ($AutoRestart) {
              if (-not (Request-BridgeRestart)) {
                Write-Guard "restart request failed -- shell may be gone; leaving the scene intact"
              }
            } else {
              Write-Guard "detect-only (D1): the shell dumps the scene, the manager restarts; not restarting here"
            }
            $misses = 0
            $armed = $false
          }
        }
      }
    } elseif ($armed) {
      Write-Guard "URL gone (service restarting?) -- disarm"
      $armed = $false
      $misses = 0
    }
  }

  Start-Sleep -Milliseconds $samplerMs
}
