# Real-machine verification of the bridge request-face guards + the danger-action
# confirmation slot (S4-0 / S4-1). MUST run on Windows: the bridge listens on
# 127.0.0.1 only, WSL is NAT, and browser-preflight semantics only exist inside
# the loopback.
#
# ASCII ONLY on purpose: PowerShell 5.1 decodes .ps1 as ANSI, so any non-ASCII
# byte in this file breaks parsing (same rule as verify-dev-ui.ps1).
#
# Usage (from WSL via interop):
#   PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
#   "$PS" -NoProfile -ExecutionPolicy Bypass -File 'D:\Dev\dsh-desktop-dev\scripts\verify-bridge-guards.ps1'
#
# Checks (PASS/FAIL per line, exit code = number of failures):
#   1   GET  /shell/state (valid Host)                -> 200
#   1b  it carries titlebarContract                   -> field present
#   1c  it carries preinstalled                       -> object present
#   2   POST with Host: evil.com                      -> 403 bad-host
#   3   POST with Origin: https://evil.com            -> 403 bad-origin
#   4   POST allowed Origin but no X-DSH-Shell        -> 403 missing-shell-header
#   5   POST allowed Origin + X-DSH-Shell             -> 202 pending (NOT executed)
#   6   OPTIONS preflight admits x-dsh-shell          -> Allow-Headers contains it
#   7   GET  /window/state (read-only)                -> 200
#   8   devMode unchanged after step 5                -> no side effect
param(
  [string]$DataDir = "$env:APPDATA\dsh.smoothly.desktop.dev",
  [string]$Port = ""
)

$ErrorActionPreference = "Stop"
$script:pass = 0
$script:fail = 0
function Check([string]$label, [bool]$ok, [string]$detail) {
  if ($ok) { $script:pass++; Write-Output ("PASS " + $label + "  " + $detail) }
  else { $script:fail++; Write-Output ("FAIL " + $label + "  " + $detail) }
}
function Http([string]$method, [string]$url, [string[]]$headers) {
  $argv = @('-s', '-i', '-X', $method)
  foreach ($h in $headers) { $argv += @('-H', $h) }
  $argv += $url
  return ((& curl.exe @argv 2>&1) -join "`n")
}
function StatusOf([string]$text) { if ($text -match "HTTP/1\.1 (\d{3})") { return [int]$Matches[1] } return 0 }

$log = Join-Path $DataDir "dsh-desktop-session.log"
if (-not (Test-Path $log)) { Write-Output ("NO-SESSION-LOG " + $log); exit 99 }
if ($Port -eq "") {
  $m = Select-String -Path $log -Pattern "bridge on 127\.0\.0\.1:(\d+)" | Select-Object -Last 1
  if ($null -eq $m) { Write-Output "NO-BRIDGE-PORT-IN-LOG"; exit 99 }
  $Port = $m.Matches[0].Groups[1].Value
}
# page origin = dsh web port, taken from manager.log's "dsh web: http://127.0.0.1:<port>"
$mlog0 = Join-Path $DataDir "runtime\manager.log"
$pagePort = $Port
if (Test-Path $mlog0) {
  $u = Select-String -Path $mlog0 -Pattern "dsh web: http://127\.0\.0\.1:(\d+)" | Select-Object -Last 1
  if ($null -ne $u) { $pagePort = $u.Matches[0].Groups[1].Value }
}
$origin = "http://127.0.0.1:$pagePort"
$base = "http://127.0.0.1:$Port"
Write-Output ("bridge=" + $Port + " page-origin=" + $origin)

# 1) read-only state
$r = Http 'GET' "$base/shell/state" @()
Check "1  GET /shell/state" ((StatusOf $r) -eq 200) ("status=" + (StatusOf $r))
$devBefore = if ($r -match '"devMode":(true|false)') { $Matches[1] } else { "?" }
$tb = if ($r -match '"titlebarContract":(true|false)') { $Matches[1] } else { "MISSING" }
$pr = if ($r -match '"preinstalled":\s*\{') { "present" } else { "MISSING" }
Check "1b state carries titlebarContract" ($tb -ne "MISSING") ("titlebarContract=" + $tb)
Check "1c state carries preinstalled" ($pr -eq "present") $pr

# 2) forged Host (DNS-rebinding face)
$r = Http 'POST' "$base/shell/dev-mode-toggle" @('Host: evil.com')
Check "2  forged Host -> 403" ((StatusOf $r) -eq 403 -and $r -match "bad-host") ("status=" + (StatusOf $r))

# 3) non-allowlisted Origin
$r = Http 'POST' "$base/shell/dev-mode-toggle" @('Origin: https://evil.com')
Check "3  bad Origin -> 403" ((StatusOf $r) -eq 403 -and $r -match "bad-origin") ("status=" + (StatusOf $r))

# 4) allowed Origin but missing custom header
$r = Http 'POST' "$base/shell/dev-mode-toggle" @("Origin: $origin")
Check "4  no X-DSH-Shell -> 403" ((StatusOf $r) -eq 403 -and $r -match "missing-shell-header") ("status=" + (StatusOf $r))

# 5) allowed request -> 202 pending (danger action NOT executed)
$r = Http 'POST' "$base/shell/dev-mode-toggle" @("Origin: $origin", 'X-DSH-Shell: 1')
Check "5  allowed -> 202 pending" ((StatusOf $r) -eq 202 -and $r -match '"pending":true') ("status=" + (StatusOf $r))
if ($r -match '"nonce":"([^"]+)"') { Write-Output ("     nonce=" + $Matches[1]) }

# 6) preflight must admit the custom header
$r = Http 'OPTIONS' "$base/shell/dev-mode-toggle" @("Origin: $origin", 'Access-Control-Request-Method: POST', 'Access-Control-Request-Headers: x-dsh-shell,content-type')
$allow = ""
if ($r -match "(?im)^access-control-allow-headers:\s*(.+)$") { $allow = $Matches[1].Trim() }
$allowOrigin = ""
if ($r -match "(?im)^access-control-allow-origin:\s*(.+)$") { $allowOrigin = $Matches[1].Trim() }
Check "6  preflight admits x-dsh-shell" ((StatusOf $r) -eq 204 -and $allow -match "(?i)x-dsh-shell") ("status=" + (StatusOf $r) + " allow-headers='" + $allow + "' allow-origin='" + $allowOrigin + "'")

# 7) read-only GET not blocked
$r = Http 'GET' "$base/window/state" @()
Check "7  GET /window/state" ((StatusOf $r) -eq 200) ("status=" + (StatusOf $r))

# 8) step 5 had no side effect
$r2 = Http 'GET' "$base/shell/state" @()
$devAfter = if ($r2 -match '"devMode":(true|false)') { $Matches[1] } else { "?" }
Check "8  danger action not executed" ($devAfter -eq $devBefore) ("devMode " + $devBefore + " -> " + $devAfter)

# audit trail: bridge rejects are logged by the SHELL (app_data dir session log),
# danger-action decisions by the shell too -- manager.log only has manager lines.
Write-Output "--- recent bridge-reject audit lines (session log) ---"
Select-String -Path $log -Pattern "bridge reject" | Select-Object -Last 6 | ForEach-Object { Write-Output ("     " + $_.Line) }
Write-Output ("SUMMARY pass=" + $script:pass + " fail=" + $script:fail)
exit $script:fail
