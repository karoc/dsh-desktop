# Capture the launcher page of the dev build in a tight loop (single process).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File capture-launcher.ps1 [-Title "..."] [-OutDir "..."] [-N 40] [-IntervalMs 350]
param(
  [string]$Title = "DSH Smoothly Desktop Dev",
  [string]$OutDir = "D:\Dev\_shots\launcher",
  [int]$N = 40,
  [int]$IntervalMs = 350,
  [switch]$DismissBanner
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@ -Name Ui -Namespace Native

function Get-Hwnd { return (Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1).MainWindowHandle }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

# wait up to 15s for the window to appear (WebView2 init can take seconds)
$h = Get-Hwnd
$waited = 0
while (-not $h -and $waited -lt 150) {
  Start-Sleep -Milliseconds 100
  $waited++
  $h = Get-Hwnd
}
if (-not $h) { Write-Output "NO-WINDOW after 15s"; exit 1 }
Write-Output ("WINDOW-FOUND after " + ($waited * 100) + "ms")

# optionally dismiss the legacy-residue banner ("later" button) so the log
# viewport is fully visible (the banner pushes it below the window bottom)
if ($DismissBanner) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $wcond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Title)
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wcond)
  if ($null -ne $win) {
    $later = [regex]::Unescape("\u7A0D\u540E")  # later
    $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $later)
    $btns = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)
    if ($btns.Count -gt 0) {
      $pats = @($btns[0].GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
      if ($pats -contains "InvokePatternIdentifiers.Pattern") {
        ($btns[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
        Write-Output "BANNER-DISMISSED"
      } else { Write-Output "BANNER-NO-INVOKE" }
    } else { Write-Output "BANNER-NOT-FOUND" }
  } else { Write-Output "BANNER-WIN-NOT-FOUND" }
  Start-Sleep -Milliseconds 600
}

for ($i = 0; $i -lt $N; $i++) {
  $h = Get-Hwnd
  if (-not $h) { Write-Output "NO-WINDOW at $i"; break }
  $r = New-Object Native.Ui+RECT
  [Native.Ui]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [Native.Ui]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  $out = Join-Path $OutDir ("f-{0:D3}.png" -f $i)
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("SHOT " + $i + " ok=" + $ok + " -> " + $out)
  Start-Sleep -Milliseconds $IntervalMs
}
Write-Output "CAPTURE-DONE"
