# Windows dev-build UI verification over WSL interop (no manual eyeballing).
#
# Verifies the dsh-desktop shell UI on a REAL WebView2 window from WSL:
#   - dump   : enumerate UIA elements (name / type / physical rect) — WebView2
#              exposes a UIA tree, so DOM buttons and the injected shell chrome
#              (menubar buttons, hover strip) are all visible here
#   - shot   : PrintWindow(PW_RENDERFULLCONTENT) capture of the window without
#              stealing focus (DWM-composited content, works for WebView2)
#   - invoke : UIA InvokePattern on a named control (no mouse movement)
#   - click  : real cursor move + physical click on a named control (restores
#              the cursor afterwards) — use to prove hit-testing/clickability
#   - hover  : move the cursor to the top edge (y=2) for ~1s, then restore
#
# Chinese control labels are built from \u escapes so this file stays pure
# ASCII and survives PowerShell 5.1 ANSI file decoding.
#
# Usage (from WSL):
#   PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
#   "$PS" -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w scripts/verify-dev-ui.ps1)" -Action dump
#
# Prereqs: the dev build is installed and running (identity/productName
# "DSH Smoothly Desktop Dev"); /mnt/c and /mnt/d are read-only in WSL, so any
# D-drive write (screenshots) must go through this Windows-side script.
param(
  [Parameter(Mandatory = $true)][ValidateSet("dump", "shot", "invoke", "click", "hover")][string]$Action,
  [string]$Key = "",
  [string]$Out = "D:\Dev\_shots\dev-ui.png",
  [string]$Title = "DSH Smoothly Desktop Dev",
  [int]$Max = 60
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public struct POINT { public int X; public int Y; }
'@ -Name Ui -Namespace Native

# control label keys (keep ASCII in this file)
$labels = @{}
$labels["menu"]    = [regex]::Unescape("\u83DC\u5355")                       # menu
$labels["close"]   = [regex]::Unescape("\u5173\u95ED")                       # close
$labels["later"]   = [regex]::Unescape("\u7A0D\u540E\u914D\u7F6E")           # skip onboarding
$labels["kanban"]  = [regex]::Unescape("\u601D\u78E8\u529B\u770B\u677F")     # kanban
$labels["plugins"] = [regex]::Unescape("\u63D2\u4EF6\u7BA1\u7406")           # plugin manager
$labels["strip"]   = [regex]::Unescape("\u663E\u793A\u83DC\u5355\u680F")     # hover strip

$root = [System.Windows.Automation.AutomationElement]::RootElement
$wcond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Title)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $wcond)
if ($null -eq $win) { Write-Output "WINDOW-NOT-FOUND ($Title)"; exit 1 }

function Find-ByName([string]$name) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  return $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)
}
function Get-Hwnd { return (Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1).MainWindowHandle }

switch ($Action) {
  "dump" {
    $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    Write-Output ("ALL-ELEMENTS " + $all.Count)
    $i = 0
    foreach ($e in $all) {
      $n = $e.Current.Name
      if ($n -ne $null -and $n -ne "") {
        $r = $e.Current.BoundingRectangle
        Write-Output ("[" + $e.Current.ControlType.ProgrammaticName + "] " + $n + "  @ " + [int]$r.X + "," + [int]$r.Y + " " + [int]$r.Width + "x" + [int]$r.Height)
        $i++
        if ($i -ge $Max) { Write-Output "..."; break }
      }
    }
  }
  "shot" {
    $h = Get-Hwnd
    if ($h -eq 0) { Write-Output "NO-WINDOW-HANDLE"; exit 1 }
    $r = New-Object Native.Ui+RECT
    [Native.Ui]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
    $bmp = New-Object System.Drawing.Bitmap $w, $ht
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [Native.Ui]::PrintWindow($h, $hdc, 2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    $dir = Split-Path -Parent $Out
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ("SHOT ok=" + $ok + " rect=" + $w + "x" + $ht + " -> " + $Out)
  }
  "invoke" {
    if (-not $labels.ContainsKey($Key)) { Write-Output "UNKNOWN-KEY"; exit 2 }
    $els = Find-ByName $labels[$Key]
    if ($els.Count -eq 0) { Write-Output ("ELEMENT-NOT-FOUND [" + $labels[$Key] + "]"); exit 1 }
    $el = $els[0]
    $pats = @($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
    if ($pats -contains "InvokePatternIdentifiers.Pattern") {
      ($el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
      Write-Output ("INVOKED [" + $labels[$Key] + "]")
    } else { Write-Output ("NO-INVOKE-PATTERN [" + $labels[$Key] + "]"); exit 3 }
  }
  "click" {
    if (-not $labels.ContainsKey($Key)) { Write-Output "UNKNOWN-KEY"; exit 2 }
    $els = Find-ByName $labels[$Key]
    if ($els.Count -eq 0) { Write-Output ("ELEMENT-NOT-FOUND [" + $labels[$Key] + "]"); exit 1 }
    $el = $null
    foreach ($e in $els) { $r = $e.Current.BoundingRectangle; if ($r.Y -ge 0 -and $r.Width -gt 0) { $el = $e } }
    if ($null -eq $el) { Write-Output "NO-VISIBLE-MATCH"; exit 1 }
    $br = $el.Current.BoundingRectangle
    $cx = [int]($br.X + $br.Width / 2); $cy = [int]($br.Y + $br.Height / 2)
    $p = New-Object Native.Ui+POINT
    [Native.Ui]::GetCursorPos([ref]$p) | Out-Null
    [Native.Ui]::SetCursorPos($cx, $cy) | Out-Null
    Start-Sleep -Milliseconds 300
    [Native.Ui]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 60
    [Native.Ui]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 500
    [Native.Ui]::SetCursorPos($p.X, $p.Y) | Out-Null
    Write-Output ("CLICKED [" + $labels[$Key] + "] at " + $cx + "," + $cy + " (cursor restored)")
  }
  "hover" {
    $scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $p = New-Object Native.Ui+POINT
    [Native.Ui]::GetCursorPos([ref]$p) | Out-Null
    [Native.Ui]::SetCursorPos([int]($scr.Width / 2), 2) | Out-Null
    Start-Sleep -Milliseconds 900
    $m = Find-ByName $labels["menu"]
    if ($m.Count -gt 0) { Write-Output ("menubar-y=" + [int]$m[0].Current.BoundingRectangle.Y) }
    [Native.Ui]::SetCursorPos($p.X, $p.Y) | Out-Null
    Write-Output "HOVER-DONE (cursor restored)"
  }
}
