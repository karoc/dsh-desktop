# dsh Desktop one-shot diagnostic (Windows). Collects key state, then runs the
# manager in no-update mode. Paste the whole output to the developer.
# NOTE: keep this file ASCII-only - Windows PowerShell 5.1 misreads UTF-8
# without BOM as ANSI and Chinese text breaks parsing. English only.
$ErrorActionPreference = 'Continue'

Write-Host "== dsh Desktop diagnostic ==" -ForegroundColor Cyan

# Locate the install directory
$app = $null
foreach ($base in @("$env:LOCALAPPDATA", "$env:LOCALAPPDATA\Programs", 'C:\Program Files', 'C:\Program Files (x86)')) {
  $hit = Get-ChildItem $base -Recurse -Filter "dsh Desktop.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { $app = $hit.DirectoryName; break }
}
if (-not $app) { Write-Host "!! dsh Desktop install dir not found" -ForegroundColor Red; exit 1 }
Write-Host "install dir: $app"

# Installed shell version (registry DisplayVersion; fall back to exe version)
$verItem = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'DSH Desktop' } | Select-Object -First 1
$ver = $null
if ($verItem) { $ver = $verItem.DisplayVersion }
if (-not $ver) { $ver = (Get-Item "$app\dsh Desktop.exe").VersionInfo.ProductVersion }
Write-Host "installed version: $ver  (auto-repair of broken dsh installs exists only in 0.3.2+)"

$res = Join-Path $app 'resources'
foreach ($f in @(
  "$res\node\win32-x64\node.exe",
  "$res\node\win32-x64\node_modules\npm\bin\npm-cli.js",
  "$res\manager\server-manager.mjs",
  "$res\patch\dsh-desktop.patch.yml",
  "$res\plugin\@dsh-desktop\client-notifications\client.js"
)) {
  Write-Host ("{0}  {1}" -f $(if (Test-Path $f) { 'OK ' } else { 'MISS' }), $f)
}

$rt = Join-Path $env:APPDATA 'dev.dsh.desktop\runtime'
Write-Host "`nruntime dir: $rt"
$dshPkg = Join-Path $rt 'node_modules\@deepseek-ai\dsh\package.json'
$dshBin = Join-Path $rt 'node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $dshPkg)) {
  Write-Host "  dsh state: NOT installed (package.json missing)"
} elseif (-not (Test-Path $dshBin)) {
  Write-Host "  dsh state: HALF-INSTALLED (package.json present, lib/bin.js missing) - 0.3.2 should auto-repair"
} else {
  $v = (Get-Content $dshPkg -Raw | ConvertFrom-Json).version
  Write-Host "  dsh state: installed $v (entry OK)"
}

$log = Join-Path $rt 'manager.log'
if (Test-Path $log) {
  Write-Host "  manager.log tail:"
  Get-Content $log -Tail 30 | ForEach-Object { "    $_" }
  Write-Host "  manager.log key markers:"
  # ASCII-only substrings that actually appear in manager.log (the script
  # itself must stay ASCII; the manager's own messages are a zh/en mix).
  $markers = @(
    'missing or broken', 'auto-install dsh failed',
    'registry http', 'npm error', 'DSH_DESKTOP_REGISTRY',
    'EIDLETIMEOUT', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'not installed'
  )
  foreach ($m in $markers) {
    $hit = Select-String -Path $log -Pattern $m -SimpleMatch | Select-Object -Last 1
    if ($hit) { Write-Host "    [$m] $($hit.Line.Trim())" }
  }
} else {
  Write-Host "  manager.log missing"
}

Write-Host "`n== run manager in no-update mode (30s; Ctrl+C to abort) ==" -ForegroundColor Cyan
$node = "$res\node\win32-x64\node.exe"
$mgr = "$res\manager\server-manager.mjs"
& $node $mgr --runtime-dir $rt --resource-dir $res --patch "$res\patch\dsh-desktop.patch.yml" --cwd $env:USERPROFILE --registry https://registry.npmmirror.com
Write-Host "`ndiagnostic done. Paste the output above to the developer."
