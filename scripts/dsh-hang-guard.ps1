<#
.SYNOPSIS
  dsh-desktop 挂起守护 + 现场取证（无需重打包壳，今天就能用）

.DESCRIPTION
  2026-09-01 排障结论：正式版内嵌 dsh web（node 进程）曾在会话运行中途事件循环挂起
  （页面黑屏、刷新无响应、单靠"重启 dsh"恢复）。本脚本：
    1) 每 N 秒探测 dsh web 的 HTTP 存活（URL 从 manager.log 最新一行读取）
    2) 首次探测成功后才进入武装状态（避免安装期误报）
    3) 连续 MissLimit 次失败 => 取证：进程快照 + 两端日志尾部 + 会话转录 mtime
       + rundll32 comsvcs MiniDump 抓 dsh web / manager 的 node 内存转储
    4) 恢复：优先 POST 桥的 /restart（等价壳内"重启服务"）；桥不通则 taskkill
       进程树，提示去壳窗口点"重试"
    5) 壳应用整体退出（用户退出 dsh）时脚本自动退出
  所有动作写入 %LOCALAPPDATA%\dsh-hang-guard-<app>.log；证据目录
  %LOCALAPPDATA%\dsh-hang-<app>-<时间戳>\

.PARAMETER App
  prod = 正式版（默认）；dev = 开发版（身份 dev.dsh.desktop.dev）

.PARAMETER IntervalSec
  探测间隔秒数（默认 3）

.PARAMETER MissLimit
  连续失败多少次触发取证+重启（默认 3，即 ~9 秒无响应）

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\dsh-hang-guard.ps1 -App prod
#>
param(
  [ValidateSet('prod','dev')][string]$App = 'prod',
  [int]$IntervalSec = 3,
  [int]$MissLimit = 3
)
$ErrorActionPreference = 'Continue'

$Identity   = if ($App -eq 'dev') { 'dev.dsh.desktop.dev' } else { 'dev.dsh.desktop' }
$APPD       = Join-Path $env:APPDATA $Identity
$managerLog = Join-Path $APPD 'runtime\manager.log'
$sessionLog = Join-Path $APPD 'dsh-desktop-session.log'
$evidenceRoot = Join-Path $env:LOCALAPPDATA ("dsh-hang-" + $App + "-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$guardLog   = Join-Path $env:LOCALAPPDATA ("dsh-hang-guard-" + $App + ".log")

function Write-Guard([string]$msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg
  Add-Content -Path $guardLog -Value $line -ErrorAction SilentlyContinue
  Write-Host $line
}

function Get-LatestDshUrl {
  $m = Select-String -Path $managerLog -Pattern 'dsh web: http://127\.0\.0\.1:\d+' -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($m -and $m.Line -match '(http://127\.0\.0\.1:\d+)') { return $Matches[1] }
  return $null
}
function Get-LatestBridgePort {
  $m = Select-String -Path $sessionLog -Pattern 'bridge on 127\.0\.0\.1:\d+' -ErrorAction SilentlyContinue | Select-Object -Last 1
  if ($m -and $m.Line -match 'bridge on 127\.0\.0\.1:(\d+)') { return [int]$Matches[1] }
  return $null
}
function Get-DshWebPids {
  @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'bin\.js web --patch' } | ForEach-Object { $_.ProcessId })
}
function Get-ManagerPids {
  @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'server-manager\.mjs' } | ForEach-Object { $_.ProcessId })
}
function Test-AppRunning {
  $apps = Get-Process -Name 'dsh-desktop*' -ErrorAction SilentlyContinue
  return ($null -ne $apps -and $apps.Count -gt 0)
}
function Test-WebAlive([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
  } catch { return $false }
}
function Request-BridgeRestart {
  $port = Get-LatestBridgePort
  if (-not $port) { return $false }
  try {
    Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port + "/restart") -Method POST -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop | Out-Null
    return $true
  } catch { return $false }
}
function Capture-Dump([int]$pid_) {
  try {
    $dmp = Join-Path $evidenceDir ("node-" + $pid_ + ".dmp")
    & rundll32.exe 'c:\windows\system32\comsvcs.dll, MiniDump' $pid_ $dmp 'full' 2>$null | Out-Null
    Start-Sleep -Milliseconds 800
    if (Test-Path $dmp) { Write-Guard "dump saved: $dmp" } else { Write-Guard "dump FAILED for pid $pid_ (rundll32 未产出文件)" }
  } catch { Write-Guard "dump error pid $pid_ : $($_.Exception.Message)" }
}
function Snapshot-Evidence([string]$reason) {
  New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
  try {
    if (Test-Path $managerLog) { Get-Content $managerLog -Tail 300 | Set-Content (Join-Path $evidenceDir 'manager.log.tail.txt') }
    if (Test-Path $sessionLog) { Get-Content $sessionLog -Tail 300 | Set-Content (Join-Path $evidenceDir 'session.log.tail.txt') }
    Get-CimInstance Win32_Process |
      Where-Object { ($_.Name -match 'node|dsh-desktop|msedgewebview2') -and $_.CommandLine -match 'dsh' } |
      Select-Object ProcessId, ParentProcessId, Name, @{n='Start';e={$_.CreationDate}}, @{n='WS_MB';e={[int]($_.WorkingSetSize/1MB)}} |
      Format-Table -AutoSize | Out-String -Width 240 | Set-Content (Join-Path $evidenceDir 'processes.txt')
    Get-ChildItem (Join-Path $APPD 'runtime\dsh-home\sessions') -Recurse -Filter 'session.jsonl.zstd' -ErrorAction SilentlyContinue |
      Select-Object LastWriteTime, Length, FullName | Sort-Object LastWriteTime -Descending | Select-Object -First 8 |
      Format-Table -AutoSize | Out-String -Width 240 | Set-Content (Join-Path $evidenceDir 'transcripts.txt')
    Write-Guard "evidence snapshot -> $evidenceDir (reason: $reason)"
  } catch { Write-Guard "snapshot error: $($_.Exception.Message)" }
}

if (-not (Test-Path $managerLog)) {
  Write-Guard "manager.log not found at $managerLog — app 可能还没运行过；请启动 dsh 后重试。退出。"
  exit 1
}

Write-Guard "watchdog start (app=$App interval=${IntervalSec}s miss-limit=$MissLimit, evidence=$evidenceRoot)"
$armed = $false
$misses = 0
$appGoneCycles = 0

while ($true) {
  if (-not (Test-AppRunning)) {
    $appGoneCycles++
    if ($appGoneCycles -ge 2) { Write-Guard "dsh 应用不在运行（用户已退出?）— 看门狗退出。"; break }
  } else {
    $appGoneCycles = 0
  }

  $url = Get-LatestDshUrl
  if ($url) {
    $alive = Test-WebAlive $url
    if ($alive) {
      if (-not $armed) { Write-Guard "armed on $url"; $armed = $true }
      $misses = 0
    } elseif ($armed) {
      $misses++
      Write-Guard "miss $misses/$MissLimit on $url"
      if ($misses -ge $MissLimit) {
        Write-Guard "!!! dsh web UNRESPONSIVE ($url) — capturing evidence, then restarting service"
        Snapshot-Evidence "unresponsive after $MissLimit misses"
        foreach ($p in Get-DshWebPids)  { Capture-Dump $p }
        foreach ($p in Get-ManagerPids) { Capture-Dump $p }
        if (Request-BridgeRestart) {
          Write-Guard "bridge /restart accepted — 服务应自动恢复（等价壳内重启服务）"
        } else {
          Write-Guard "bridge /restart failed — force-killing node tree；请去壳窗口点「重试」"
          Get-DshWebPids  | ForEach-Object { & taskkill.exe /PID $_ /T /F 2>$null | Out-Null }
          Get-ManagerPids | ForEach-Object { & taskkill.exe /PID $_ /T /F 2>$null | Out-Null }
        }
        $misses = 0
        $armed = $false
      }
    }
  } elseif ($armed) {
    Write-Guard "URL gone（服务重启中?）— 重新武装"
    $armed = $false
    $misses = 0
  }
  Start-Sleep -Seconds $IntervalSec
}