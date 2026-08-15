# dsh Desktop 一键诊断（Windows）。收集关键信息 + 以无更新模式跑一次 manager，
# 把输出发给开发者即可完成定位。
$ErrorActionPreference = 'Continue'

Write-Host "== dsh Desktop 诊断 ==" -ForegroundColor Cyan

# 定位安装目录
$app = $null
foreach ($base in @("$env:LOCALAPPDATA", "$env:LOCALAPPDATA\Programs", 'C:\Program Files', 'C:\Program Files (x86)')) {
  $hit = Get-ChildItem $base -Recurse -Filter "dsh Desktop.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { $app = $hit.DirectoryName; break }
}
if (-not $app) { Write-Host "!! 未找到 dsh Desktop 安装目录" -ForegroundColor Red; exit 1 }
Write-Host "安装目录: $app"

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
Write-Host "`n运行时目录: $rt"
Write-Host ("  dsh 安装: {0}" -f $(if (Test-Path "$rt\node_modules\@deepseek-ai\dsh\package.json") { '是' } else { '否' }))
$log = Join-Path $rt 'manager.log'
if (Test-Path $log) { Write-Host "  manager.log 末尾:"; Get-Content $log -Tail 15 | ForEach-Object { "    $_" } } else { Write-Host "  manager.log 不存在" }

Write-Host "`n== 无更新模式跑一次 manager（25 秒，Ctrl+C 可提前结束） ==" -ForegroundColor Cyan
$node = "$res\node\win32-x64\node.exe"
$mgr = "$res\manager\server-manager.mjs"
& $node $mgr --runtime-dir $rt --resource-dir $res --patch "$res\patch\dsh-desktop.patch.yml" --cwd $env:USERPROFILE --registry https://registry.npmmirror.com
Write-Host "`n诊断结束。把以上输出发给开发者。"