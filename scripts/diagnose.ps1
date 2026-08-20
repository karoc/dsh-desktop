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

# 已安装的壳版本（注册表 DisplayVersion；缺失则回退读 exe 文件版本）
$ver = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
        Where-Object DisplayName -eq 'DSH Desktop' | Select-Object -First 1).DisplayVersion
if (-not $ver) { $ver = (Get-Item "$app\dsh Desktop.exe").VersionInfo.ProductVersion }
Write-Host "已安装版本: $ver  （0.3.2 及以上才有 broken-install 自动修复）"

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
$dshPkg = Join-Path $rt 'node_modules\@deepseek-ai\dsh\package.json'
$dshBin = Join-Path $rt 'node_modules\@deepseek-ai\dsh\lib\bin.js'
if (-not (Test-Path $dshPkg)) {
  Write-Host "  dsh 状态: 未安装（package.json 不存在）"
} elseif (-not (Test-Path $dshBin)) {
  Write-Host "  dsh 状态: 半截安装（package.json 在，但 lib/bin.js 缺失）——0.3.2 起应自动修复"
} else {
  $v = (Get-Content $dshPkg -Raw | ConvertFrom-Json).version
  Write-Host "  dsh 状态: 已装 $v（入口正常）"
}

$log = Join-Path $rt 'manager.log'
if (Test-Path $log) {
  Write-Host "  manager.log 末尾:"
  Get-Content $log -Tail 30 | ForEach-Object { "    $_" }
  Write-Host "  manager.log 关键标记:"
  $markers = @(
    'missing or broken', '安装不完整', 'auto-install dsh failed',
    '安装失败', 'registry http', '切换备用镜像', 'npm 退出码',
    'EIDLETIMEOUT', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', '超时', 'not installed'
  )
  foreach ($m in $markers) {
    $hit = Select-String -Path $log -Pattern $m -SimpleMatch | Select-Object -Last 1
    if ($hit) { Write-Host "    [$m] $($hit.Line.Trim())" }
  }
} else {
  Write-Host "  manager.log 不存在"
}

Write-Host "`n== 无更新模式跑一次 manager（30 秒，Ctrl+C 可提前结束） ==" -ForegroundColor Cyan
$node = "$res\node\win32-x64\node.exe"
$mgr = "$res\manager\server-manager.mjs"
& $node $mgr --runtime-dir $rt --resource-dir $res --patch "$res\patch\dsh-desktop.patch.yml" --cwd $env:USERPROFILE --registry https://registry.npmmirror.com
Write-Host "`n诊断结束。把以上输出发给开发者。"
