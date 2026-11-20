#Requires -Version 5.1
<#
  Agent status bar - a slim, click-through window pinned above the taskbar.

  Launched by the dsh-agent-status-bar Host plugin with powershell.exe -STA.
  Receives JSON state over a loopback UDP socket on one of the ports below and
  prints "PORT=<n>" on stdout once bound. Shows itself only while the
  foreground window belongs to another process than DSH.

  Stability notes:
    - A fixed port range makes this a single instance: a second copy exits
      with code 2 instead of stacking a second bar.
    - DSH_STATUS_BAR_HOST_PID is watched; if the Host dies, this process
      retires itself instead of lingering as an orphan.
    - This file is intentionally pure ASCII: Windows PowerShell 5.1 decodes a
      BOM-less script as ANSI, so non-ASCII literals would corrupt the parser.
      All display copy arrives in the state messages.
#>
$ErrorActionPreference = 'Stop'

function Write-BarLog([string]$message) {
  try {
    $logPath = Join-Path $env:TEMP 'dsh-status-bar-ui.log'
    if (Test-Path -LiteralPath $logPath) {
      if ((Get-Item -LiteralPath $logPath).Length -gt 262144) { Remove-Item -LiteralPath $logPath -Force }
    }
    $stamp = [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff')
    Add-Content -LiteralPath $logPath -Value "$stamp $message" -Encoding UTF8
  } catch { }
}

try {
  Add-Type -AssemblyName PresentationFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  [Console]::Error.WriteLine("WPF unavailable: $($_.Exception.Message)")
  exit 1
}

$script:PROTOCOL_VERSION = 1
$script:PORT_RANGE = 47831..47840
$script:BAR_HEIGHT = 30
$script:DONE_HOLD_MS = 8000
$script:CFG = @{ barHeight = 30; fontSize = 12; doneHoldMs = 8000; hideOnFullscreen = $true }

$state = [pscustomobject]@{ phase = 'idle'; label = ''; text = ''; since = 0; elapsed = 0 }
$dshPid = 0
if ($env:DSH_STATUS_BAR_DSH_PID) { [int]::TryParse($env:DSH_STATUS_BAR_DSH_PID, [ref]$dshPid) | Out-Null }
$script:hostPid = 0
if ($env:DSH_STATUS_BAR_HOST_PID) { [int]::TryParse($env:DSH_STATUS_BAR_HOST_PID, [ref]$script:hostPid) | Out-Null }
$script:foregroundPid = 0
$script:foregroundKnown = $false
$script:foregroundFullscreen = $false
$script:doneAt = 0
$script:shown = $null
$script:tickCount = 0

Write-BarLog "boot pid=$PID hostPid=$($script:hostPid) dshPid=$dshPid"

# ---- configuration from the Host plugin ------------------------------------
if ($env:DSH_STATUS_BAR_CONFIG) {
  try {
    $parsed = $env:DSH_STATUS_BAR_CONFIG | ConvertFrom-Json
    if ($parsed.barHeight) { $script:CFG.barHeight = [int]$parsed.barHeight }
    if ($parsed.fontSize) { $script:CFG.fontSize = [int]$parsed.fontSize }
    if ($parsed.doneHoldMs) { $script:CFG.doneHoldMs = [int]$parsed.doneHoldMs }
    if ($null -ne $parsed.hideOnFullscreen) { $script:CFG.hideOnFullscreen = [bool]$parsed.hideOnFullscreen }
  } catch {
    Write-BarLog "config parse failed, using defaults: $($_.Exception.Message)"
  }
}
if ($script:CFG.barHeight -lt 16) { $script:CFG.barHeight = 16 }
if ($script:CFG.barHeight -gt 80) { $script:CFG.barHeight = 80 }
if ($script:CFG.fontSize -lt 8) { $script:CFG.fontSize = 8 }
if ($script:CFG.fontSize -gt 24) { $script:CFG.fontSize = 24 }
if ($script:CFG.doneHoldMs -lt 1000) { $script:CFG.doneHoldMs = 1000 }
if ($script:CFG.doneHoldMs -gt 60000) { $script:CFG.doneHoldMs = 60000 }
$script:BAR_HEIGHT = $script:CFG.barHeight
$script:DONE_HOLD_MS = $script:CFG.doneHoldMs
Write-BarLog "config height=$($script:CFG.barHeight) font=$($script:CFG.fontSize) hold=$($script:CFG.doneHoldMs) fullscreenHide=$($script:CFG.hideOnFullscreen)"

# ---- loopback UDP channel --------------------------------------------------
# One instance is enforced by the lock file; the port range only tolerates a
# foreign process already sitting on the first port.
$script:LOCK_PATH = Join-Path $env:TEMP 'dsh-status-bar.lock'
if (Test-Path -LiteralPath $script:LOCK_PATH) {
  try {
    $lockText = Get-Content -LiteralPath $script:LOCK_PATH -Raw
    if ($lockText -match '^\s*(\d+)') {
      $oldPid = [int]$Matches[1]
      if ($oldPid -gt 0 -and $oldPid -ne $PID) {
        if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
          [Console]::Error.WriteLine('ALREADY_RUNNING')
          Write-BarLog "instance $oldPid already running; exiting"
          exit 2
        }
      }
    }
  } catch {
    Write-BarLog "lock read failed: $($_.Exception.Message)"
  }
}

$udp = $null
$boundPort = 0
foreach ($candidate in $script:PORT_RANGE) {
  $candidateSocket = $null
  try {
    $candidateSocket = [System.Net.Sockets.Socket]::new(
      [System.Net.Sockets.AddressFamily]::InterNetwork,
      [System.Net.Sockets.SocketType]::Dgram,
      [System.Net.Sockets.ProtocolType]::Udp)
    $candidateSocket.ExclusiveAddressUse = $true
    $candidateSocket.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Loopback, $candidate)))
    $udp = $candidateSocket
    $boundPort = $candidate
    break
  } catch {
    try { if ($candidateSocket) { $candidateSocket.Close() } } catch { }
  }
}
if ($null -eq $udp) {
  [Console]::Error.WriteLine('NO_PORT')
  Write-BarLog 'no free port in range'
  exit 2
}
try {
  Set-Content -LiteralPath $script:LOCK_PATH -Value "$PID`:$boundPort" -Encoding ASCII
} catch {
  Write-BarLog "lock write failed: $($_.Exception.Message)"
}
[Console]::Out.WriteLine("PORT=$boundPort")
[Console]::Out.Flush()
Write-BarLog "udp port=$boundPort"

# ---- native helpers -------------------------------------------------------
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class StatusBarNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtr")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO info);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);

  public static IntPtr GetExStyle(IntPtr h) { return GetWindowLongPtr(h, -20); }
  public static void SetExStyle(IntPtr h, IntPtr v) { SetWindowLongPtr(h, -20, v); }

  /// A foreground window that covers its whole monitor means another app is
  /// presenting (slides, video, games); the bar must stay out of the way.
  public static bool IsFullscreen(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return false;
    if (IsIconic(hwnd)) return false;
    var sb = new StringBuilder(64);
    GetClassNameW(hwnd, sb, 64);
    var cls = sb.ToString();
    if (cls == "Progman" || cls == "WorkerW") return false;
    RECT r;
    if (!GetWindowRect(hwnd, out r)) return false;
    IntPtr mon = MonitorFromWindow(hwnd, 2);
    var mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(mon, ref mi)) return false;
    return r.Left <= mi.rcMonitor.Left + 2 && r.Top <= mi.rcMonitor.Top + 2
        && r.Right >= mi.rcMonitor.Right - 2 && r.Bottom >= mi.rcMonitor.Bottom - 2;
  }
}
"@
} catch {
  [Console]::Error.WriteLine("native helpers failed: $($_.Exception.Message)")
  exit 1
}

# ---- window ---------------------------------------------------------------
$window = $null
try {
  $window = New-Object System.Windows.Window
  $window.WindowStyle = 'None'
  $window.AllowsTransparency = $true
  $window.Background = [System.Windows.Media.Brushes]::Transparent
  $window.Topmost = $true
  $window.ShowInTaskbar = $false
  $window.ShowActivated = $false
  $window.ResizeMode = 'NoResize'
  $window.WindowStartupLocation = 'Manual'
  $window.Left = 0
  $window.Top = [System.Windows.SystemParameters]::WorkArea.Bottom - $script:BAR_HEIGHT
  $window.Width = [System.Windows.SystemParameters]::WorkArea.Width
  $window.Height = $script:BAR_HEIGHT

  $border = New-Object System.Windows.Controls.Border
  $border.Background = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#F20D1117')
  $border.BorderBrush = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#3A2A3B52')
  $border.BorderThickness = [System.Windows.Thickness]::new(0, 1, 0, 0)

  $panel = New-Object System.Windows.Controls.Grid
  $panel.Margin = [System.Windows.Thickness]::new(14, 0, 16, 0)
  $c1 = New-Object System.Windows.Controls.ColumnDefinition
  $c1.Width = [System.Windows.GridLength]::new(10)
  $c2 = New-Object System.Windows.Controls.ColumnDefinition
  $c2.Width = [System.Windows.GridLength]::new(0, 'Auto')
  $c3 = New-Object System.Windows.Controls.ColumnDefinition
  $c3.Width = [System.Windows.GridLength]::new(1, 'Star')
  $c4 = New-Object System.Windows.Controls.ColumnDefinition
  $c4.Width = [System.Windows.GridLength]::new(0, 'Auto')
  $panel.ColumnDefinitions.Add($c1)
  $panel.ColumnDefinitions.Add($c2)
  $panel.ColumnDefinitions.Add($c3)
  $panel.ColumnDefinitions.Add($c4)

  $dot = New-Object System.Windows.Shapes.Ellipse
  $dot.Width = 8
  $dot.Height = 8
  $dot.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#4D8DFF')
  $dot.VerticalAlignment = 'Center'
  $dot.HorizontalAlignment = 'Left'
  [System.Windows.Controls.Grid]::SetColumn($dot, 0)

  $label = New-Object System.Windows.Controls.TextBlock
  $label.Text = ''
  $label.FontSize = $script:CFG.fontSize - 1
  $label.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#8B98A8')
  $label.VerticalAlignment = 'Center'
  $label.Margin = [System.Windows.Thickness]::new(8, 0, 10, 0)
  [System.Windows.Controls.Grid]::SetColumn($label, 1)

  $text = New-Object System.Windows.Controls.TextBlock
  $text.Text = ''
  $text.FontSize = $script:CFG.fontSize
  $text.FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI')
  $text.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#E6EDF3')
  $text.VerticalAlignment = 'Center'
  $text.TextTrimming = 'CharacterEllipsis'
  $text.TextWrapping = 'NoWrap'
  [System.Windows.Controls.Grid]::SetColumn($text, 2)

  $timerText = New-Object System.Windows.Controls.TextBlock
  $timerText.Text = ''
  $timerText.FontSize = $script:CFG.fontSize - 1
  $timerText.FontFamily = New-Object System.Windows.Media.FontFamily('Consolas')
  $timerText.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString('#9FB0C4')
  $timerText.VerticalAlignment = 'Center'
  $timerText.Margin = [System.Windows.Thickness]::new(12, 0, 0, 0)
  [System.Windows.Controls.Grid]::SetColumn($timerText, 3)

  $panel.Children.Add($dot) | Out-Null
  $panel.Children.Add($label) | Out-Null
  $panel.Children.Add($text) | Out-Null
  $panel.Children.Add($timerText) | Out-Null
  $border.Child = $panel
  $window.Content = $border

  $window.Add_SourceInitialized({
    try {
      $helper = New-Object System.Windows.Interop.WindowInteropHelper $window
      $hwnd = $helper.Handle
      $ex = [StatusBarNative]::GetExStyle($hwnd).ToInt64()
      # WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
      $ex = $ex -bor 0x20 -bor 0x08000000 -bor 0x00000080
      [StatusBarNative]::SetExStyle($hwnd, [IntPtr]$ex) | Out-Null
      $flags = 0x0001 -bor 0x0002 -bor 0x0010
      [StatusBarNative]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, $flags) | Out-Null
      Write-BarLog ("window initialized ex=0x{0:X}" -f $ex)
    } catch {
      Write-BarLog "window init failed: $($_.Exception.Message)"
    }
  })

  $window.Show()
  $window.Visibility = 'Hidden'
  $script:shown = $false
} catch {
  [Console]::Error.WriteLine("window creation failed: $($_.Exception.Message)")
  Write-BarLog "window creation failed: $($_.Exception.Message)"
  exit 1
}

function Format-Duration([double]$ms) {
  if ($ms -lt 0 -or [double]::IsNaN($ms)) { $ms = 0 }
  $seconds = $ms / 1000
  if ($seconds -lt 10) { return ('{0:N1}s' -f $seconds) }
  if ($seconds -lt 60) { return ('{0}s' -f [math]::Floor($seconds)) }
  $minutes = [math]::Floor($seconds / 60)
  $rest = [math]::Floor($seconds % 60)
  return ('{0}m {1:D2}s' -f $minutes, $rest)
}

function Update-Foreground() {
  try {
    $hwnd = [StatusBarNative]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { return }
    $owner = [uint32]0
    [void][StatusBarNative]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    if ($owner -gt 0) {
      $script:foregroundPid = [int]$owner
      $script:foregroundKnown = $true
    }
    $script:foregroundFullscreen = [StatusBarNative]::IsFullscreen($hwnd)
  } catch {
    Write-BarLog "foreground probe failed: $($_.Exception.Message)"
  }
}

function Sync-Layout() {
  try {
    $area = [System.Windows.SystemParameters]::WorkArea
    $targetWidth = [double]$area.Width
    $targetTop = [double]$area.Bottom - $script:BAR_HEIGHT
    if ([math]::Abs($window.Width - $targetWidth) -gt 0.5 -or [math]::Abs($window.Top - $targetTop) -gt 0.5) {
      $window.Width = $targetWidth
      $window.Left = $area.Left
      $window.Top = $targetTop
      $window.Height = $script:BAR_HEIGHT
      Write-BarLog "layout resynced width=$targetWidth top=$targetTop"
    }
  } catch {
    Write-BarLog "layout sync failed: $($_.Exception.Message)"
  }
}

function Apply-Visibility() {
  $visible = $true
  if (-not $script:foregroundKnown) { $visible = $false }
  elseif ($dshPid -eq 0) { $visible = $false }
  elseif ($script:foregroundPid -eq $dshPid) { $visible = $false }
  elseif ($script:foregroundFullscreen -and $script:CFG.hideOnFullscreen) { $visible = $false }
  elseif ($state.phase -eq 'idle') { $visible = $false }
  elseif ($state.phase -eq 'done' -and $script:doneAt -gt 0) {
    $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $script:doneAt
    if ($age -gt $script:DONE_HOLD_MS) { $visible = $false }
  }

  if ($visible -eq $script:shown) { return }
  $script:shown = $visible
  try {
    if ($visible) { $window.Visibility = 'Visible' } else { $window.Visibility = 'Hidden' }
  } catch {
    Write-BarLog "visibility change failed: $($_.Exception.Message)"
    return
  }
  Write-BarLog "visible=$visible fg=$($script:foregroundPid) dsh=$dshPid phase=$($state.phase)"
}

function Update-Bar() {
  $phase = $state.phase
  $dotColor = '#4D8DFF'
  $bodyColor = '#C9D6E3'
  $timerValue = ''
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

  if ($phase -eq 'thinking') {
    $dotColor = '#4D8DFF'
    if ($state.since -gt 0) { $timerValue = Format-Duration ($now - $state.since) }
  } elseif ($phase -eq 'working') {
    $dotColor = '#F0A020'
    if ($state.since -gt 0) { $timerValue = Format-Duration ($now - $state.since) }
  } elseif ($phase -eq 'approval') {
    $dotColor = '#FF5F56'
    $bodyColor = '#FFB3AE'
    if ($state.since -gt 0) { $timerValue = Format-Duration ($now - $state.since) }
  } elseif ($phase -eq 'done') {
    $dotColor = '#3FB950'
    if ($state.elapsed -gt 0) { $timerValue = Format-Duration $state.elapsed }
  }

  $label.Text = $state.label
  $dot.Fill = [System.Windows.Media.BrushConverter]::new().ConvertFromString($dotColor)
  $text.Text = $state.text
  $text.Foreground = [System.Windows.Media.BrushConverter]::new().ConvertFromString($bodyColor)
  $timerText.Text = $timerValue
}

function Receive-Messages() {
  while ($udp.Available -gt 0) {
    $buffer = New-Object byte[] 65536
    try {
      $count = $udp.Receive($buffer)
    } catch { break }
    if ($count -le 0) { continue }
    try {
      $message = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $count) | ConvertFrom-Json
    } catch {
      continue
    }
    if ($null -eq $message -or $message.type -ne 'state') { continue }
    # A newer Host may speak a schema this build does not understand.
    if ($null -ne $message.v) {
      try { if ([int]$message.v -gt $script:PROTOCOL_VERSION) { continue } } catch { }
    }
    $previous = $state.phase

    $state.phase = 'idle'
    if ($message.phase) { $state.phase = [string]$message.phase }

    $state.label = ''
    if ($null -ne $message.label) { $state.label = [string]$message.label }

    $state.text = ''
    if ($null -ne $message.text) { $state.text = [string]$message.text }

    $state.since = 0
    if ($message.since) { $state.since = [double]$message.since }

    $state.elapsed = 0
    if ($message.elapsed) { $state.elapsed = [double]$message.elapsed }

    if ($message.dshPid) { $dshPid = [int]$message.dshPid }

    if ($state.phase -eq 'done' -and $previous -ne 'done') {
      $script:doneAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    if ($state.phase -ne 'done') { $script:doneAt = 0 }

    $preview = $state.text
    if ($preview.Length -gt 40) { $preview = $preview.Substring(0, 40) }
    if ($previous -ne $state.phase -or $script:lastLoggedText -ne $state.text) {
      Write-BarLog "state phase=$($state.phase) label=$($state.label) text=$preview"
      $script:lastLoggedText = $state.text
    }
  }
}

function Test-HostAlive() {
  if ($script:hostPid -le 0) { return $true }
  try {
    $process = Get-Process -Id $script:hostPid -ErrorAction SilentlyContinue
    return ($null -ne $process)
  } catch {
    return $true
  }
}

$ticker = New-Object System.Windows.Threading.DispatcherTimer
$ticker.Interval = [TimeSpan]::FromMilliseconds(150)
$ticker.Add_Tick({
  try {
    $script:tickCount += 1
    Receive-Messages
    Update-Foreground
    Update-Bar
    Apply-Visibility
    if (($script:tickCount % 13) -eq 0) {
      Sync-Layout
      if (-not (Test-HostAlive)) {
        Write-BarLog 'host process gone; retiring'
        $ticker.Stop()
        $window.Close()
        [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
      }
    }
  } catch {
    Write-BarLog "tick error: $($_.Exception.Message)"
  }
})
$ticker.Start()

Write-BarLog 'entering message loop'
[System.Windows.Threading.Dispatcher]::Run() | Out-Null
Write-BarLog 'message loop ended'

# Release the single-instance lock only when this process owns it.
try {
  if (Test-Path -LiteralPath $script:LOCK_PATH) {
    $lockText = Get-Content -LiteralPath $script:LOCK_PATH -Raw
    if ($lockText -match "^\s*$PID") {
      Remove-Item -LiteralPath $script:LOCK_PATH -Force -ErrorAction SilentlyContinue
    }
  }
} catch { }
