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
# CPU-busy path (2026-11-18, card 5585208f): the shell must NOT dump a child that is
# still burning CPU (a bounded synchronous stall), because a 300-660 MB dump also
# suspends the target and pollutes the manager's own CPU sampling. It must still
# dump a genuinely idle/deadlocked child.
#   1. -Action busy          drive a 20 s busy loop inside the live dsh web process
#                            (inspector Runtime.evaluate), then assert: no new dump,
#                            session.log shows misses 3/3 + "busy stall ... skip dump",
#                            and dsh web was NOT restarted.
#   2. -Action busy-control  the negative control: start the shell with
#                            DSH_HANG_BUSY_GATE=off, then the SAME busy loop MUST
#                            produce a dump (proves the busy assertions can fail).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\...\verify-hang-dump.ps1 -Action hang
#   ... -Action check -WaitSec 60
#   ... -Action resume           (fallback if the manager did not restart it)
#   ... -Action busy             (new build; no dump on a CPU-busy stall)
#   ... -Action busy-control     (shell started with DSH_HANG_BUSY_GATE=off)
param(
  [Parameter(Mandatory = $true)][ValidateSet("hang", "check", "resume", "state", "busy", "busy-control")][string]$Action,
  [string]$Ident = "dsh.smoothly.desktop.dev",
  [int]$WaitSec = 60,
  [int]$BusySeconds = 20
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


# Shell process name for this identity (dev and prod shells coexist on one machine).
function Get-ShellProcessName {
  # dev identities: dsh.smoothly.desktop.dev, ...devw7 (verification instances).
  if ($Ident -like "*.dev*") { return "dsh-desktop-dev" }
  return "dsh-desktop"
}

# The shell ships its own node.exe; the inspector attach uses it (no system Node needed).
function Get-ShellNode {
  $proc = Get-Process -Name (Get-ShellProcessName) -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $proc) { return $null }
  $node = Join-Path (Split-Path $proc.Path) "resources\node\win32-x64\node.exe"
  if (-not (Test-Path $node)) { return $null }
  return $node
}

# Attach the Node inspector to the live dsh web process and return its WS URL.
function Get-InspectorWs([int]$webPid) {
  $node = Get-ShellNode
  if (-not $node) { Write-Output "NO-SHELL-NODE"; return $null }
  $busy = Get-NetTCPConnection -LocalPort 9229 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($busy) { Write-Output ("INSPECTOR-PORT-BUSY pid=" + $busy.OwningProcess); return $null }
  & $node -e ("process._debugProcess(" + $webPid + ")") | Out-Null
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $list = Invoke-RestMethod -Uri "http://127.0.0.1:9229/json/list" -TimeoutSec 2
      if ($list -and $list.Count -ge 1) { return $list[0].webSocketDebuggerUrl }
    } catch { }
  }
  return $null
}

# Run a busy loop inside the target process through the inspector (blocks its event loop).
function Invoke-BusyLoop([string]$wsUrl, [int]$seconds) {
  $node = Get-ShellNode
  $driver = Join-Path $env:TEMP ("dsh-hang-busy-" + $PID + ".mjs")
  $source = @'
const [, , wsUrl, seconds] = process.argv
const budget = Number(seconds) * 1000
const ws = new WebSocket(wsUrl)
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: 'const __dshEnd = Date.now() + ' + budget + '; while (Date.now() < __dshEnd) {} "busy-done"',
    awaitPromise: false,
    returnByValue: true,
  } }))
})
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.id === 1) { console.log('BUSY-DONE'); ws.close(); process.exit(0) }
})
ws.addEventListener('error', () => { console.log('BUSY-WS-ERROR'); process.exit(2) })
setTimeout(() => { console.log('BUSY-TIMEOUT'); process.exit(3) }, budget + 8000)
'@
  Set-Content -Path $driver -Value $source -Encoding ASCII
  try { & $node $driver $wsUrl $seconds } finally { Remove-Item $driver -Force -ErrorAction SilentlyContinue }
}

# Bytes written to a log since the given offset (UTF-8, BOM-less).
function Get-TextSince([string]$path, [long]$offset) {
  if (-not (Test-Path $path)) { return "" }
  $fs = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try {
    $fs.Seek($offset, 'Begin') | Out-Null
    $sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)
    return $sr.ReadToEnd()
  } finally { $fs.Dispose() }
}

function Get-SessionTextSince([long]$offset) {
  return Get-TextSince $sessionLog $offset
}

function Get-DumpNames {
  return @(Get-ChildItem $reports -Filter "dshweb-hang-*.dmp" -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
}

# The shell ignores misses during HANG_STARTUP_GRACE_SECS (30 s) after a new URL:
# a busy loop started earlier would be a vacuous test.
function Wait-HangStartupGrace([int]$graceSec = 35) {
  if (-not (Test-Path $managerLog)) { return }
  $m = Select-String -Path $managerLog -Pattern "dsh web: (http://127\.0\.0\.1:\d+)" | Select-Object -Last 1
  if (-not $m) { return }
  $ts = ([datetime]::Parse($m.Line.Substring(0, 24))).ToUniversalTime()
  $age = ((Get-Date).ToUniversalTime() - $ts).TotalSeconds
  if ($age -lt $graceSec) { Start-Sleep -Seconds ([int][math]::Ceiling($graceSec - $age)) }
}

# Shared busy scenario: drive the loop, then prove the shell's verdict.
function Invoke-BusyScenario([bool]$expectDump) {
  $url = Get-LiveUrl
  if (-not $url) { Write-Output "NO-LIVE-URL"; exit 1 }
  $webPid = Get-DshWebPid $url
  if ($webPid -le 0) { Write-Output "NO-PID-FOR-PORT"; exit 1 }
  Wait-HangStartupGrace
  $ws = Get-InspectorWs $webPid
  if (-not $ws) { Write-Output "NO-INSPECTOR"; if ($script:fail -gt 0) { Write-Output ("RESULT FAIL (" + $script:fail + ")"); exit 1 }; exit 1 }
  $before = Get-DumpNames
  $offset = 0
  if (Test-Path $sessionLog) { $offset = (Get-Item $sessionLog).Length }
  Write-Output ("BUSY-LOOP pid=" + $webPid + " url=" + $url + " seconds=" + $BusySeconds)
  Invoke-BusyLoop $ws $BusySeconds
  # Give the watchdog its sample window + verdict, and the dump writer time to start.
  Start-Sleep -Seconds 8
  $sess = Get-SessionTextSince $offset
  $after = Get-DumpNames
  $newDumps = @($after | Where-Object { $before -notcontains $_ })
  if ($expectDump) {
    Say (@($newDumps).Count -ge 1) ("busy-control must produce a dump (new=" + @($newDumps).Count + ")")
    Say ($sess -match "dsh web hang: dumping pid") "busy-control shell started a dump"
  } else {
    Say (@($newDumps).Count -eq 0) ("no dump while the child is CPU-busy (new=" + @($newDumps).Count + ")")
    Say ($sess -match "dsh web probe miss 3/3") "shell reached 3/3 misses during the busy loop"
    Say ($sess -match "dsh web hang: busy stall .*skip dump") "shell logged busy-stall skip instead of dumping"
    Say ($sess -notmatch "dsh web hang: dumping pid") "shell did not start a dump for the busy stall"
  }
  $liveUrl = Get-LiveUrl
  $livePid = Get-DshWebPid $liveUrl
  if ($expectDump) {
    Say ($true) "control run does not require a stable url/pid"
  } else {
    Say (($liveUrl -eq $url) -and ($livePid -eq $webPid)) "dsh web was not restarted (same url/pid)"
  }
  if ($script:fail -gt 0) { Write-Output ("RESULT FAIL (" + $script:fail + ")"); exit 1 }
  Write-Output "RESULT PASS"
}

switch ($Action) {
  "busy" {
    Invoke-BusyScenario $false
  }
  "busy-control" {
    Invoke-BusyScenario $true
  }
  "hang" {
    $url = Get-LiveUrl
    if (-not $url) { Write-Output "NO-LIVE-URL"; exit 1 }
    $pid2 = Get-DshWebPid $url
    if ($pid2 -le 0) { Write-Output "NO-PID-FOR-PORT"; exit 1 }
    # Record where this run starts so `check` can never match stale log lines from
    # an earlier incident (a whole-file match once let a PASS ride on an old line).
    $mgrOffset = 0; if (Test-Path $managerLog) { $mgrOffset = (Get-Item $managerLog).Length }
    $sessOffset = 0; if (Test-Path $sessionLog) { $sessOffset = (Get-Item $sessionLog).Length }
    $marker = Join-Path $runtime ".verify-hang-offset"
    Set-Content -Path $marker -Value ($mgrOffset.ToString() + "|" + $sessOffset.ToString() + "|" + $url) -Encoding ASCII
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
    $mgrOffset = 0; $sessOffset = 0; $hangUrl = $null
    $marker = Join-Path $runtime ".verify-hang-offset"
    if (Test-Path $marker) {
      $parts = (Get-Content $marker -Raw).Trim() -split "\|"
      if ($parts.Count -ge 3) { $mgrOffset = [long]$parts[0]; $sessOffset = [long]$parts[1]; $hangUrl = $parts[2] }
    }
    $sess = Get-TextSince $sessionLog $sessOffset
    $mgr = Get-TextSince $managerLog $mgrOffset
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
    # Two legitimate manager paths: the shell acked the dump first ("dump ready"),
    # or the shell had already dumped and the probe still timed out ("still
    # UNRESPONSIVE after dump (...) - restarting dsh"). Both restart dsh.
    $restart = ($mgr -match ("dump ready " + $dash + " restarting dsh")) -or ($mgr -match ("still UNRESPONSIVE after dump .*restarting dsh"))
    Say $restart "manager restarted dsh after the dump"
    if ($hangUrl) {
      $liveUrl = Get-LiveUrl
      Say (($liveUrl) -and ($liveUrl -ne $hangUrl)) "dsh web restarted: live url changed"
    }
    $app = @(Get-Process -Name (Get-ShellProcessName) -ErrorAction SilentlyContinue)
    Say ($app.Count -ge 1) "shell process is still alive after the hang"
    if ($script:fail -gt 0) { Write-Output ("RESULT FAIL (" + $script:fail + ")"); exit 1 }
    Write-Output "RESULT PASS"
  }
}
