param(
  [Parameter(Mandatory = $true)][string]$ProfilePath,
  [int]$ChromeProcessId = 0,
  [ValidateSet('compact', 'automation')][string]$Mode = 'compact',
  [string]$LogPath = ''
)

function Write-FocusLog([string]$Message) {
  Write-Output $Message
  if (!$LogPath) { return }
  try { Add-Content -LiteralPath $LogPath -Value "$(Get-Date -Format o)  $Message" -Encoding utf8 } catch { }
}

$normalizedProfile = [IO.Path]::GetFullPath($ProfilePath).TrimEnd('\\').ToLowerInvariant()
try { Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AccountWindowForeground {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, System.Text.StringBuilder path, ref uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfo(uint action, uint parameter, ref RECT rect, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static List<IntPtr> WindowsFor(HashSet<uint> pids) {
    var windows = new List<IntPtr>();
    // 空集合绝不能等同于“所有窗口”：此前这里会在没有找到 Chrome PID 时
    // 把 explorer.exe 错当作目标并写入 focus-success。
    if (pids == null || pids.Count == 0) return windows;
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (IsWindowVisible(h) && pids.Contains(pid)) windows.Add(h); return true; }, IntPtr.Zero);
    return windows;
  }
  public static List<IntPtr> AllVisibleWindows() {
    var windows = new List<IntPtr>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) windows.Add(h); return true; }, IntPtr.Zero);
    return windows;
  }
  public static uint WindowPid(IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return pid; }
  public static string ImagePath(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid); if (process == IntPtr.Zero) return "";
    try { var value = new System.Text.StringBuilder(1024); uint length = 1024; return QueryFullProcessImageName(process, 0, value, ref length) ? value.ToString() : ""; }
    finally { CloseHandle(process); }
  }
  public static void Activate(IntPtr window, bool automation) {
    ShowWindowAsync(window, 9);
    IntPtr foreground = GetForegroundWindow(); uint foregroundPid; uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid), currentThread = GetCurrentThreadId();
    if (foregroundThread != currentThread) AttachThreadInput(foregroundThread, currentThread, true);
    int width = 900, height = 680, x = Math.Max(12, GetSystemMetrics(0) - width - 18), y = 56;
    if (automation) {
      RECT work = new RECT();
      if (SystemParametersInfo(0x0030, 0, ref work, 0)) {
        // Responsive Doubao controls disappear in a compact 900x680 window.
        // Use the available desktop work area for the short interaction phase.
        x = work.Left + 10; y = work.Top + 10;
        width = Math.Max(960, work.Right - work.Left - 20);
        height = Math.Max(720, work.Bottom - work.Top - 20);
      }
    }
    SetWindowPos(window, new IntPtr(-1), x, y, width, height, 0x0040);
    BringWindowToTop(window); SetForegroundWindow(window);
    if (foregroundThread != currentThread) AttachThreadInput(foregroundThread, currentThread, false);
  }
}
'@
} catch { Write-FocusLog "focus-add-type-failed $($_.Exception.Message)"; exit 1 }

Write-FocusLog "focus-start profile=$normalizedProfile chromePid=$ChromeProcessId mode=$Mode"
for ($attempt = 0; $attempt -lt 7; $attempt++) {
  $pids = [Collections.Generic.HashSet[uint32]]::new()
  if ($ChromeProcessId -gt 0) { [void]$pids.Add([uint32]$ChromeProcessId) }
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction Stop | ForEach-Object {
      $command = $_.CommandLine
      if ($command -and $command.ToLowerInvariant().Contains("--user-data-dir=$normalizedProfile")) { [void]$pids.Add([uint32]$_.ProcessId) }
    }
  } catch { Write-FocusLog "chrome-process-query-failed $($_.Exception.Message)" }
  Write-FocusLog "chrome-candidates attempt=$attempt count=$($pids.Count) ids=$([string]::Join(',', @($pids)))"
  $windows = [AccountWindowForeground]::WindowsFor($pids)
  if (!$windows.Count) {
    $allWindows = [AccountWindowForeground]::AllVisibleWindows()
    foreach ($candidate in $allWindows) {
      $candidatePid = [AccountWindowForeground]::WindowPid($candidate)
      $candidateImage = [AccountWindowForeground]::ImagePath($candidatePid)
      if ($candidateImage) { Write-FocusLog "visible-window attempt=$attempt pid=$candidatePid image=$candidateImage" }
    }
    # 只有在系统中恰好只有一个 Chrome for Testing 窗口时才允许无 PID 回退；
    # 多账号时宁可记录未命中，也不能把任务置顶到另一个账号窗口。
    $testingWindows = @()
    foreach ($candidate in $allWindows) {
      $candidatePid = [AccountWindowForeground]::WindowPid($candidate)
      $candidateImage = [AccountWindowForeground]::ImagePath($candidatePid)
      if ($candidateImage -and $candidateImage.ToLowerInvariant().Contains('runtime\chrome-win64\chrome.exe')) {
        $testingWindows += $candidate
      }
    }
    if ($testingWindows.Count -eq 1) { $windows = $testingWindows }
    elseif ($testingWindows.Count -gt 1) { Write-FocusLog "focus-ambiguous-testing-windows count=$($testingWindows.Count)" }
  }
  if ($windows.Count) {
    $window = $windows[0]
    $windowPid = [AccountWindowForeground]::WindowPid($window)
    $image = [AccountWindowForeground]::ImagePath($windowPid)
    [AccountWindowForeground]::Activate($window, $Mode -eq 'automation')
    Write-FocusLog "focus-success attempt=$attempt pid=$windowPid mode=$Mode image=$image"
    break
  }
  if ($attempt -eq 6) { Write-FocusLog 'focus-no-visible-account-window' }
  Start-Sleep -Milliseconds 300
}
