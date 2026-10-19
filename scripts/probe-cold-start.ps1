<#
.SYNOPSIS
    Cold-start probe for the PACKAGED Jarvis app on real hardware.

.DESCRIPTION
    The release gap report (§13) records: "A cold packaged GUI AppHang has
    not been reproduced and ruled out." This script is the thing that
    reproduces or rules it out.

    It installs the real NSIS installer into a new scratch directory,
    launches a fresh app process using the current user's configuration,
    and watches four things. This is not a clean-profile or clean-VM test:

      1. does the process stay alive, or die during boot;
      2. does a GUI window ever appear (MainWindowHandle);
      3. does the app answer as responsive to a Windows message pump
         (SendMessageTimeout), which is what "AppHang" actually means;
      4. does the Bun server it spawns come up, and when.

    It then reports a verdict: RESPONSIVE, HUNG, or DIED, with the timings
    and whatever the app wrote to its log.

    The point of measuring the WINDOW and the message pump, rather than
    just "is the port open", is that the 2026-07 and 2026-08 reports were
    about the GUI freezing, and a server that is up does not by itself mean
    the app is not hanging.

.PARAMETER InstallerPath
    The NSIS installer to test. Required.

.PARAMETER InstallRoot
    Scratch directory the installer runs into.

.PARAMETER TimeoutSeconds
    How long to watch before calling it hung.

.PARAMETER KeepInstall
    Leave the scratch install in place afterwards (for inspection).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\probe-cold-start.ps1 `
        -InstallerPath dist\release\1.0.0\Jarvis_1.0.0_x64-setup.exe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [string]$InstallRoot = (Join-Path $env:TEMP ('jarvis-cold-start-' + [guid]::NewGuid().ToString('N'))),

    [int]$TimeoutSeconds = 120,

    [switch]$KeepInstall
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }

Add-Type -AssemblyName System.Windows.Forms

# A SendMessageTimeout that comes back with a big result means the window is
# not pumping messages - that IS an AppHang, regardless of what the port is
# doing.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WindowProbe {
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam,
        IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    public static bool IsResponsive(IntPtr hwnd, uint timeoutMs) {
        IntPtr result;
        IntPtr ret = SendMessageTimeout(hwnd, 0x0000, IntPtr.Zero, IntPtr.Zero,
            0x0002 /* SMTO_ABORTIFHUNG */, timeoutMs, out result);
        return ret != IntPtr.Zero;
    }
}
'@

function Get-JarvisWindowState([System.Diagnostics.Process]$Process) {
    $state = [ordered]@{
        has_window     = $false
        main_window    = ''
        responsive     = $null
    }
    try {
        $Process.Refresh()
    } catch {
        return $state
    }
    if ($Process.HasExited) { return $state }
    if ($Process.MainWindowHandle -ne [IntPtr]::Zero) {
        $state.has_window = $true
        $state.main_window = $Process.MainWindowTitle
        $state.responsive = [WindowProbe]::IsResponsive($Process.MainWindowHandle, 3000)
    }
    return $state
}

$started = Get-Date
$timeline = [System.Collections.Generic.List[object]]::new()
function Mark([string]$event, [hashtable]$data) {
    $entry = [ordered]@{ at_ms = [int]((Get-Date) - $started).TotalMilliseconds; event = $event }
    foreach ($k in $data.Keys) { $entry[$k] = $data[$k] }
    $timeline.Add([pscustomobject]$entry)
    Write-Host ("  [{0,6} ms] {1}" -f $entry.at_ms, $event) -ForegroundColor DarkGray
}

# ── Install ──────────────────────────────────────────────────────────────────
$installOwned = $false
$process = $null
try {
Assert-JarvisPortAvailable -Port 19877
Write-Step 'Installing the packaged app (cold)'
$InstallRoot = Install-JarvisRelease -InstallerPath $InstallerPath -InstallRoot $InstallRoot -TimeoutSeconds 120
$installOwned = $true
$mainBinaryName = Get-JarvisMainBinaryName -RepoRoot (Split-Path -Parent $PSScriptRoot)
$appPath = Join-Path $InstallRoot "$mainBinaryName.exe"
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
    Write-Host "[FAILED] installed app not found at $appPath" -ForegroundColor Red
    exit 1
}
Write-Ok "installed -> $appPath"

$logDir = Join-Path $env:USERPROFILE '.openclaw\jarvis\logs'
$stdout = Join-Path $env:TEMP 'jarvis-cold-start.out.log'
$stderr = Join-Path $env:TEMP 'jarvis-cold-start.err.log'

# ── Launch cold ──────────────────────────────────────────────────────────────
Write-Step 'Launching the app cold'
$before = @(Get-Process -Name $mainBinaryName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$process = Start-Process -FilePath $appPath -WorkingDirectory $InstallRoot -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$process | Add-Member -NotePropertyName JarvisOwnedStartTime -NotePropertyValue $process.StartTime
Mark 'launched' @{ pid = $process.Id }

$windowSeen = $false
$healthSeen = $false
$healthAt = $null
$verdict = 'TIMEOUT'
$lastDetail = ''

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500

    if ($process.HasExited) {
        $verdict = 'DIED'
        $lastDetail = "exited with code $($process.ExitCode)"
        Mark 'process_exited' @{ exit_code = $process.ExitCode }
        break
    }

    $state = Get-JarvisWindowState -process $process
    if ($state.has_window -and -not $windowSeen) {
        $windowSeen = $true
        Mark 'window_appeared' @{ title = $state.main_window; responsive = $state.responsive }
    }
    if ($state.has_window -and $state.responsive -eq $false) {
        $verdict = 'HUNG'
        $lastDetail = 'the main window stopped pumping messages (SMTO_ABORTIFHUNG)'
        Mark 'window_hung' @{}
        break
    }
    if ($state.has_window -and $state.responsive -eq $true -and $verdict -eq 'TIMEOUT') {
        $verdict = 'RESPONSIVE'
    }

    if (-not $healthSeen) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort 19877 -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($listener) {
            $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
            if ($candidate.ParentProcessId -eq $process.Id -and $candidate.CreationDate -ge $process.JarvisOwnedStartTime) {
                $healthSeen = $true
                $healthAt = (Get-Date)
                Mark 'server_listening' @{ pid = $candidate.ProcessId }
            }
        }
    }

    if ($verdict -eq 'RESPONSIVE' -and $healthSeen) { break }
}

if ($verdict -eq 'TIMEOUT') {
    $verdict = if ($windowSeen) { 'RESPONSIVE' } else { 'NO_WINDOW' }
    $lastDetail = if ($windowSeen) { 'window appeared but the server never came up' } else { 'no window appeared within the budget' }
}
if ($verdict -eq 'RESPONSIVE' -and -not $healthSeen) { $verdict = 'SERVER_UNAVAILABLE' }

# ── Health ───────────────────────────────────────────────────────────────────
Write-Step 'Health'
$healthPayload = $null
if ($healthSeen) {
    try {
        $healthPayload = Invoke-RestMethod -Uri 'http://127.0.0.1:19877/health' -TimeoutSec 5
        Write-Ok "health: version=$($healthPayload.version) git_sha=$($healthPayload.git_sha)"
    } catch {
        Write-Warn "health endpoint did not answer: $($_.Exception.Message)"
        if ($verdict -eq 'RESPONSIVE') { $verdict = 'SERVER_UNHEALTHY' }
    }
}

# ── Evidence ─────────────────────────────────────────────────────────────────
$childProcesses = @()
try {
    $childProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ParentProcessId -eq $process.Id } |
        Select-Object ProcessId, Name, CommandLine
} catch { }

$appLog = $null
if (Test-Path $logDir) {
    $newest = Get-ChildItem $logDir -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) {
        $appLog = [pscustomobject]@{
            path = $newest.FullName
            tail = [string[]]@(Get-Content $newest.FullName -Tail 25 -ErrorAction SilentlyContinue)
        }
    }
}

$stderrTail = [string[]]@()
if (Test-Path $stderr) { $stderrTail = [string[]]@(Get-Content $stderr -Tail 25 -ErrorAction SilentlyContinue) }
$stdoutTail = [string[]]@()
if (Test-Path $stdout) { $stdoutTail = [string[]]@(Get-Content $stdout -Tail 25 -ErrorAction SilentlyContinue) }

# ── Verdict ──────────────────────────────────────────────────────────────────
$summary = [pscustomobject]@{
    verdict        = $verdict
    detail         = $lastDetail
    window_appeared = $windowSeen
    window_at_ms   = ($timeline | Where-Object { $_.event -eq 'window_appeared' } | Select-Object -First 1).at_ms
    server_at_ms   = ($timeline | Where-Object { $_.event -eq 'server_listening' } | Select-Object -First 1).at_ms
    server_healthy = ($null -ne $healthPayload)
    health         = $healthPayload
    children       = @($childProcesses)
    timeline       = $timeline.ToArray()
    stdout_tail    = $stdoutTail
    stderr_tail    = $stderrTail
    app_log        = $appLog
}
$summary | ConvertTo-Json -Depth 6 | Write-Output

Write-Host "`nVERDICT: $verdict - $lastDetail" -ForegroundColor $(if ($verdict -eq 'RESPONSIVE') { 'Green' } else { 'Red' })
exit $(if ($verdict -eq 'RESPONSIVE') { 0 } else { 1 })
} finally {
    try {
        if ($process) { Stop-JarvisOwnedProcesses -Process $process }
    } finally {
        if ($installOwned -and -not $KeepInstall) {
            Remove-JarvisReleaseInstall -InstallRoot $InstallRoot | Out-Null
            Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
