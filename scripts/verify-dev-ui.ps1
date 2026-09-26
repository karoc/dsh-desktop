# Windows dev-build UI verification over WSL interop (no manual eyeballing).
#
# Verifies the dsh-desktop shell UI on a REAL WebView2 window from WSL:
#   - dump   : enumerate UIA elements (name / type / physical rect) -- WebView2
#              exposes a UIA tree, so DOM buttons and the injected shell chrome
#              (menubar buttons, hover strip) are all visible here
#   - shot   : PrintWindow(PW_RENDERFULLCONTENT) capture of the window without
#              stealing focus (DWM-composited content, works for WebView2)
#   - invoke : UIA InvokePattern on a named control (no mouse movement)
#   - click  : real cursor move + physical click on a named control (restores
#              the cursor afterwards) -- use to prove hit-testing/clickability
#   - hover  : move the cursor to the top edge (y=2) for ~1s, then restore
#   - windows: list top-level windows (is the main window hidden? is a dialog up?)
#   - text   : print every named control (used to assert dialog copy)
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
  [Parameter(Mandatory = $true)][ValidateSet("dump", "shot", "invoke", "click", "hover", "windows", "text")][string]$Action,
  [string]$Key = "",
  [string]$Name = "",
  [string]$Out = "D:\Dev\_shots\dev-ui.png",
  [string]$Title = "DSH Smoothly Desktop Dev",
  [int]$Max = 60,
  # Window role: "main" = the shell's main window (exact $Title); "other" = any
  # other top-level window whose name CONTAINS $Title -- that is the confirm
  # window ("<product> - confirm action") and the About/settings dialogs. Keeps
  # the command line pure ASCII (non-ASCII titles never have to be typed).
  [ValidateSet("main", "other")][string]$Window = "main"
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
$labels["plugins"] = [regex]::Unescape("\u63D2\u4EF6\u7BA1\u7406")           # shell plugin manager (removed 2026-09-21)
$labels["dshplugins"] = [regex]::Unescape("\u63D2\u4EF6")                    # dsh's own sidebar Plugins entry
$labels["disableplugins"] = [regex]::Unescape("\u505C\u7528\u5168\u90E8\u7B2C\u4E09\u65B9\u63D2\u4EF6\u2026") # safety-net menu item
$labels["strip"]   = [regex]::Unescape("\u663E\u793A\u83DC\u5355\u680F")     # hover strip
$labels["restart"] = [regex]::Unescape("\u91CD\u542F\u670D\u52A1")           # errbanner: restart service
$labels["evidence"] = [regex]::Unescape("\u6253\u5F00\u8BC1\u636E\u76EE\u5F55") # errbanner: open evidence dir
$labels["confirm-ok"]  = [regex]::Unescape("\u786E\u8BA4\u6267\u884C")     # danger-action confirm: approve
$labels["confirm-no"]  = [regex]::Unescape("\u53D6\u6D88")                 # danger-action confirm: cancel
$labels["about"]       = [regex]::Unescape("\u5173\u4E8E") + " DSH Smoothly Desktop Dev"  # About menu item
$labels["rollback"]    = [regex]::Unescape("\u56DE\u9000\u5230")           # launcher: rollback to vX (prefix match)

$root = [System.Windows.Automation.AutomationElement]::RootElement
$win = $null
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  $n = $w.Current.Name
  if ($null -eq $n -or $n -eq "") { continue }
  if ($Window -eq "main" -and $n -eq $Title) { $win = $w; break }
  if ($Window -eq "other" -and $n -ne $Title -and $n.Contains($Title)) { $win = $w; break }
}
if ($null -eq $win) { Write-Output ("WINDOW-NOT-FOUND role=" + $Window + " title~" + $Title); exit 1 }
Write-Output ("WINDOW role=" + $Window + " name=[" + $win.Current.Name + "]")

function Find-ByName([string]$name) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $exact = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)
  if ($exact.Count -gt 0) { return $exact }
    # (see window-role selector below)
  $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $hits = New-Object System.Collections.ArrayList
  foreach ($e in $all) { $n = $e.Current.Name; if ($n -and $n.StartsWith($name)) { [void]$hits.Add($e) } }
  return $hits
}
function Resolve-Target {
  if ($Name -ne "") { return $Name }
  if ($labels.ContainsKey($Key)) { return $labels[$Key] }
  return $null
}
function Get-Hwnd {
  # Prefer the resolved UIA window's native handle (works for dialogs, which are
  # not a process MainWindow), fall back to the process main window.
  $h = $win.Current.NativeWindowHandle
  if ($h -and $h -ne 0) { return [IntPtr]$h }
  return (Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1).MainWindowHandle
}

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
  "windows" {
    # UIA top-level children: unlike Get-Process.MainWindowTitle this SEES dialog
    # windows of the same process (the confirm window is a second webview in the
    # shell process, so a process-based listing is blind to it).
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
      $n = $w.Current.Name
      if ($null -eq $n -or $n -eq "") { continue }
      $p = ""
      try { $p = $w.Current.ProcessId } catch { }
      Write-Output ("TOPWINDOW pid=" + $p + " [" + $w.Current.ControlType.ProgrammaticName + "] " + $n)
    }
    Write-Output ("MAIN-VISIBLE " + [bool](Get-Process | Where-Object { $_.MainWindowTitle -eq $Title } | Select-Object -First 1))
  }
  "text" {
    # print every named control (dialog copy included) -- used to assert dialog content
    $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) { $n = $e.Current.Name; if ($n) { Write-Output ("TEXT [" + $e.Current.ControlType.ProgrammaticName + "] " + $n) } }
  }
  "invoke" {
    $target = Resolve-Target
    if ($null -eq $target) { Write-Output "UNKNOWN-KEY (pass -Key or -Name)"; exit 2 }
    $els = Find-ByName $target
    if ($els.Count -eq 0) { Write-Output ("ELEMENT-NOT-FOUND [" + $target + "]"); exit 1 }
    $el = $els[0]
    $pats = @($el.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
    if ($pats -contains "InvokePatternIdentifiers.Pattern") {
      ($el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
      Write-Output ("INVOKED [" + $target + "]")
    } else { Write-Output ("NO-INVOKE-PATTERN [" + $target + "]"); exit 3 }
  }
  "click" {
    $target = Resolve-Target
    if ($null -eq $target) { Write-Output "UNKNOWN-KEY (pass -Key or -Name)"; exit 2 }
    $els = Find-ByName $target
    if ($els.Count -eq 0) { Write-Output ("ELEMENT-NOT-FOUND [" + $target + "]"); exit 1 }
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
    Write-Output ("CLICKED [" + $target + "] at " + $cx + "," + $cy + " (cursor restored)")
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
