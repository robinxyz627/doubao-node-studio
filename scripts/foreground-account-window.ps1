param(
  [Parameter(Mandatory = $true)][string]$ProfilePath,
  [int]$ChromeProcessId = 0,
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
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint first, uint second, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static List<IntPtr> WindowsFor(HashSet<uint> pids) {
    var windows = new List<IntPtr>();
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (IsWindowVisible(h) && (pids.Count == 0 || pids.Contains(pid))) windows.Add(h); return true; }, IntPtr.Zero);
    return windows;
  }
  public static uint WindowPid(IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return pid; }
  public static string ImagePath(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid); if (process == IntPtr.Zero) return "";
    try { var value = new System.Text.StringBuilder(1024); uint length = 1024; return QueryFullProcessImageName(process, 0, value, ref length) ? value.ToString() : ""; }
    finally { CloseHandle(process); }
  }
  public static void Activate(IntPtr window) {
    ShowWindowAsync(window, 9);
    IntPtr foreground = GetForegroundWindow(); uint foregroundPid; uint foregroundThread = GetWindowThreadProcessId(foreground, out foregroundPid), currentThread = GetCurrentThreadId();
    if (foregroundThread != currentThread) AttachThreadInput(foregroundThread, currentThread, true);
    int width = 900, height = 680, screenWidth = GetSystemMetrics(0);
    SetWindowPos(window, new IntPtr(-1), Math.Max(12, screenWidth - width - 18), 56, width, height, 0x0040);
    BringWindowToTop(window); SetForegroundWindow(window);
    if (foregroundThread != currentThread) AttachThreadInput(foregroundThread, currentThread, false);
  }
}
'@
} catch { Write-FocusLog "Add-Type 失败：$($_.Exception.Message)"; exit 1 }

Write-FocusLog "开始置顶 profile=$normalizedProfile chromePid=$ChromeProcessId"
for ($attempt = 0; $attempt -lt 7; $attempt++) {
  $pids = [Collections.Generic.HashSet[uint32]]::new()
  if ($ChromeProcessId -gt 0) { [void]$pids.Add([uint32]$ChromeProcessId) }
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction Stop | ForEach-Object {
      $command = $_.CommandLine
      if ($command -and $command.ToLowerInvariant().Contains("--user-data-dir=$normalizedProfile")) { [void]$pids.Add([uint32]$_.ProcessId) }
    }
  } catch { }
  $windows = [AccountWindowForeground]::WindowsFor($pids)
  if (!$windows.Count) {
    $allWindows = [AccountWindowForeground]::WindowsFor([Collections.Generic.HashSet[uint32]]::new())
    foreach ($candidate in $allWindows) {
      $candidatePid = [AccountWindowForeground]::WindowPid($candidate)
      $candidateImage = [AccountWindowForeground]::ImagePath($candidatePid)
      if ($candidateImage) { Write-FocusLog "visible-window attempt=$attempt pid=$candidatePid image=$candidateImage" }
    }
    $windows = $allWindows | Where-Object {
      ([AccountWindowForeground]::ImagePath([AccountWindowForeground]::WindowPid($_))).ToLowerInvariant().Contains('runtime\chrome-win64\chrome.exe')
    }
  }
  if ($windows.Count) {
    $window = $windows[0]
    $windowPid = [AccountWindowForeground]::WindowPid($window)
    $image = [AccountWindowForeground]::ImagePath($windowPid)
    [AccountWindowForeground]::Activate($window)
    Write-FocusLog "已置顶 attempt=$attempt pid=$windowPid image=$image"
    break
  }
  if ($attempt -eq 6) { Write-FocusLog '未找到可置顶的账号 Chrome 顶层窗口' }
  Start-Sleep -Milliseconds 300
}
