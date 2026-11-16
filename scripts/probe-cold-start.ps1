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

    The observation budget is a hard bound. Every OS query runs in its own
    runspace and is waited on for at most the remaining budget; a query that
    outlives it is reported as unavailable and abandoned rather than joined,
    so a stalled query cannot turn a 120s observation into an unbounded run.

.PARAMETER InstallerPath
    The NSIS installer to test. Required.

.PARAMETER InstallRoot
    Scratch directory the installer runs into.

.PARAMETER TimeoutSeconds
    How long to watch before calling it hung.

.PARAMETER KeepInstall
    Leave the scratch install in place afterwards (for inspection).

.PARAMETER CleanupTimeoutSeconds
    DD-053: hard bound on the finally-block process cleanup. Once the
    verdict has been written a stalled CIM query must not be able to hold
    the probe open; past this budget Stop-JarvisOwnedProcesses gives each
    OS query up with a warning, still stopping the root process when it can.

.PARAMETER QuitPass
    DD-083: after the boot verdict, run a graceful-quit pass. The app is
    asked to close the way a user closes it (CloseMainWindow, the WM_CLOSE
    path that ends in Tauri's RunEvent::ExitRequested), the exit is waited
    for inside a bounded budget, and then the shutdown is asserted: no
    child process the app spawned may survive it, and nothing may still
    listen on the probe port. A dirty quit turns a RESPONSIVE verdict into
    QUIT_DIRTY (non-zero exit). Opt-in: without it the run is exactly as
    before.

.PARAMETER QuitWaitSeconds
    How long the quit pass waits for the app to exit after CloseMainWindow.
    Only used with -QuitPass.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\probe-cold-start.ps1 `
        -InstallerPath dist\release\1.0.0\Jarvis_1.0.0_x64-setup.exe

.EXAMPLE
    Same run, plus the DD-T3 shutdown evidence:
    powershell -ExecutionPolicy Bypass -File scripts\probe-cold-start.ps1 `
        -InstallerPath dist\release\1.0.0\Jarvis_1.0.0_x64-setup.exe -QuitPass
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [string]$InstallRoot = (Join-Path $env:TEMP ('jarvis-cold-start-' + [guid]::NewGuid().ToString('N'))),

    [int]$TimeoutSeconds = 120,

    [int]$CleanupTimeoutSeconds = 20,

    [switch]$KeepInstall,

    [switch]$QuitPass,

    [int]$QuitWaitSeconds = 20
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\release-common.ps1')
. (Join-Path $PSScriptRoot 'lib\probe-bounded-queries.ps1')

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

# ── Quit pass (DD-083, opt-in -QuitPass) ─────────────────────────────────────

function Test-JarvisProbeQuitPass {
    <#
    .SYNOPSIS
        The graceful-quit assertions behind the probe's opt-in -QuitPass.

    .DESCRIPTION
        DD-T3 shutdown evidence: a cold boot is only half the story, the
        shutdown is the other half. This pass asks the app to quit the way a
        user does - CloseMainWindow, the WM_CLOSE path that ends in Tauri's
        RunEvent::ExitRequested (src-tauri/src/lib.rs), where the supervisor's
        restart gate is closed before the children are reaped - waits for the
        exit inside a bounded budget, and then asserts that the shutdown
        actually completed: no child process the app spawned may survive it,
        and nothing may still be listening on the probe port.

        Every OS seam is an injected scriptblock with a real default, and the
        children and port queries run through the same bounded helpers the
        observation loop uses (Get-JarvisProbeChildProcessEvidence and
        Invoke-JarvisProbeBoundedQuery), so the pass cannot outlive its
        budget and scripts/probe-cold-start.Tests.ps1 can drive it entirely
        on fakes - no installer, no app, no listener, no real query.

        When the app never exits, its children and its port are expected to
        still be there; asserting against them would invent shutdown
        failures the no-exit failure already covers, so both are reported as
        not_queried and the exit failure carries the run.

        Fails closed: a close that could not be requested is recorded, an
        app still running at the budget, a child or port query that did not
        answer are all named failures, never a silent pass. Ownership is the
        probe's own child-evidence definition - the single PID source of
        this script; no second enumeration is added here.

    .OUTPUTS
        [pscustomobject] with ok, close_requested, exited, exit_code,
        children (leftover owned children), children_query, listener_status,
        listener_pid and failures (strings naming the offending PID or port).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Process,
        [int]$Port = 19877,
        [int]$QuitWaitSeconds = 20,
        [int]$QueryTimeoutSeconds = 10,
        [scriptblock]$CloseMainWindow = { param($Proc)
            if ($Proc.HasExited) { $false } else { [bool]$Proc.CloseMainWindow() }
        },
        [scriptblock]$WaitExit = { param($Proc, $TimeoutMs)
            if ($Proc.HasExited) { $true } else { [bool]$Proc.WaitForExit($TimeoutMs) }
        },
        [scriptblock]$ChildrenQuery = $null,
        [scriptblock]$ListenerQuery = $null
    )

    $failures = [System.Collections.Generic.List[string]]::new()
    $childrenStatus = 'not_queried'
    $children = @()
    $listenerStatus = 'not_queried'
    $listenerPid = $null

    # 1. The graceful close. A process without a window reports no close
    #    requested; that alone is not a failure, the exit wait below is.
    $closeRequested = $false
    try {
        $closeRequested = [bool](& $CloseMainWindow $Process)
    } catch {
        $failures.Add("close_main_window_failed:$($_.Exception.Message)")
    }

    # 2. Wait for the exit inside the quit budget.
    $exited = $false
    try {
        $exited = [bool](& $WaitExit $Process ([Math]::Max(0, $QuitWaitSeconds) * 1000))
    } catch {
        $failures.Add("exit_wait_failed:$($_.Exception.Message)")
    }
    if (-not $exited) {
        $failures.Add("app_did_not_exit_within_${QuitWaitSeconds}s")
    }

    $exitCode = $null
    if ($exited) {
        try { $exitCode = $Process.ExitCode } catch { $exitCode = $null }

        # 3. No child the app spawned may have survived it. Same bounded
        #    child-evidence helper the run itself records with.
        $childrenParams = @{
            ProbeProcessId = $Process.Id
            Deadline       = (Get-Date).AddSeconds($QueryTimeoutSeconds)
        }
        if ($ChildrenQuery) { $childrenParams.ProcessSnapshotQuery = $ChildrenQuery }
        $childrenEvidence = Get-JarvisProbeChildProcessEvidence @childrenParams
        $childrenStatus = $childrenEvidence.status
        if ($childrenEvidence.status -ne 'result') {
            $failures.Add("children_query_$($childrenEvidence.status):$($childrenEvidence.error)")
        } else {
            $children = @($childrenEvidence.children)
            foreach ($child in $children) {
                $failures.Add("owned_child_survived_quit:pid=$($child.ProcessId) name=$($child.Name)")
            }
        }

        # 4. Nothing may still listen on the probe port, whoever owns it.
        #    The shared default query comes from the bounded-queries lib, so
        #    this file keeps naming no OS query cmdlet.
        if (-not $ListenerQuery) { $ListenerQuery = Get-JarvisProbeListenerQuery }
        $listenerResult = Invoke-JarvisProbeBoundedQuery -Name 'quit_listener' -Query $ListenerQuery `
            -ArgumentList @($Port) -Deadline ((Get-Date).AddSeconds($QueryTimeoutSeconds))
        $listenerStatus = $listenerResult.status
        if ($listenerResult.status -ne 'result') {
            $failures.Add("port_query_$($listenerResult.status):$($listenerResult.error)")
        } else {
            $listener = $null
            if ($listenerResult.value) { $listener = @($listenerResult.value)[0] }
            if ($listener) {
                $ownerProperty = $listener.PSObject.Properties['OwningProcess']
                if ($ownerProperty) { $listenerPid = $ownerProperty.Value }
                $failures.Add("port_${Port}_still_listening:owner_pid=$listenerPid")
            }
        }
    }

    return [pscustomobject]@{
        ok              = ($failures.Count -eq 0)
        close_requested = $closeRequested
        exited          = $exited
        exit_code       = $exitCode
        children        = @($children)
        children_query  = $childrenStatus
        listener_status = $listenerStatus
        listener_pid    = $listenerPid
        failures        = @($failures)
    }
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

# DD-052: this is the log directory the packaged app itself writes - the
# directory src-tauri/src/lib.rs jarvis_server_log_stdio resolves (mirrored
# in server-jarvis/src/self-log.ts selfLogDir). Reading anything else
# reports a foreign build's log as this install's evidence.
$logDir = Join-Path $env:LOCALAPPDATA 'com.jarvis.desktop\logs'
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
$listenerStatus = 'not_queried'
$serverOwnership = ''
$serverPid = $null

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500

    # Every OS query in this loop runs in its own runspace with at most the
    # remaining observation budget. A query that outlives it is reported as
    # unavailable and contributes no evidence; it is never waited on, so a
    # stalled query cannot stretch the probe past its stated budget.
    $observation = Get-JarvisColdStartObservation `
        -Process $process `
        -ProbeStartedAt $process.JarvisOwnedStartTime `
        -Deadline $deadline `
        -Port 19877 `
        -WindowState { param($app) Get-JarvisWindowState -Process $app }

    if ($observation.exited) {
        $verdict = 'DIED'
        $lastDetail = "exited with code $($observation.exit_code)"
        Mark 'process_exited' @{ exit_code = $observation.exit_code }
        break
    }

    if ($observation.has_window -and -not $windowSeen) {
        $windowSeen = $true
        Mark 'window_appeared' @{ title = $observation.main_window; responsive = $observation.responsive }
    }
    if ($observation.has_window -and $observation.responsive -eq $false) {
        $verdict = 'HUNG'
        $lastDetail = 'the main window stopped pumping messages (SMTO_ABORTIFHUNG)'
        Mark 'window_hung' @{}
        break
    }
    if ($observation.has_window -and $observation.responsive -eq $true -and $verdict -eq 'TIMEOUT') {
        $verdict = 'RESPONSIVE'
    }

    if ($observation.listener_status -ne $listenerStatus) {
        $listenerStatus = $observation.listener_status
        if ($listenerStatus -in @('timed_out', 'failed')) {
            $detail = if ($listenerStatus -eq 'timed_out') { 'the port query outlived the observation budget' } else { 'the port query failed' }
            Mark 'listener_query_unavailable' @{ status = $listenerStatus; detail = $detail }
        }
    }
    $serverOwnership = $observation.reason

    if (-not $healthSeen -and $observation.server_listening) {
        $healthSeen = $true
        $healthAt = (Get-Date)
        $serverPid = $observation.server_pid
        Mark 'server_listening' @{ pid = $serverPid }
    }

    if ($verdict -eq 'RESPONSIVE' -and $healthSeen) { break }
}

if ($verdict -eq 'TIMEOUT') {
    $verdict = if ($windowSeen) { 'RESPONSIVE' } else { 'NO_WINDOW' }
    $lastDetail = if ($windowSeen) { 'window appeared but the server never came up' } else { 'no window appeared within the budget' }
    if (-not $healthSeen -and $serverOwnership) { $lastDetail = "$lastDetail (last server check: $serverOwnership)" }
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
$childrenEvidence = Get-JarvisProbeChildProcessEvidence -ProbeProcessId $process.Id
$childProcesses = @($childrenEvidence.children)
if ($childrenEvidence.status -ne 'result') {
    Mark 'children_evidence_unavailable' @{ status = $childrenEvidence.status; error = $childrenEvidence.error }
}

$appLog = $null
if (Test-Path $logDir) {
    # DD-052: a file whose last write predates this run's launch belongs to
    # an earlier run; reporting it would attribute old evidence to this boot.
    $launchedAt = $process.JarvisOwnedStartTime
    $newest = Get-ChildItem $logDir -File -ErrorAction SilentlyContinue |
        Where-Object { -not $launchedAt -or $_.LastWriteTime -ge $launchedAt } |
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

# ── Quit pass (DD-083, opt-in) ───────────────────────────────────────────────
# DD-T3 shutdown evidence: the app must also quit the way a user quits it.
# CloseMainWindow is the WM_CLOSE path that ends in Tauri's
# RunEvent::ExitRequested (src-tauri/src/lib.rs), where the supervisor's
# restart gate closes before the children are reaped; the pass then asserts
# that no owned child outlived the window and the port came free. Opt-in: a
# run without -QuitPass never enters this section.
$quitPassEvidence = $null
if ($QuitPass) {
    Write-Step 'Quit pass: graceful quit, then shutdown assertions'
    $quitPassEvidence = Test-JarvisProbeQuitPass -Process $process -Port 19877 -QuitWaitSeconds $QuitWaitSeconds
    Mark 'quit_pass' @{ ok = $quitPassEvidence.ok; failures = @($quitPassEvidence.failures) }
    if ($quitPassEvidence.ok) {
        Write-Ok "quit pass clean: exited=$($quitPassEvidence.exited), no owned children, port 19877 free"
    } else {
        foreach ($quitFailure in @($quitPassEvidence.failures)) {
            Write-Warn "quit pass: $quitFailure"
        }
    }
}

# ── Verdict ──────────────────────────────────────────────────────────────────
# DD-083: a dirty graceful quit fails the run. Only a RESPONSIVE verdict can
# become QUIT_DIRTY: every other verdict already exits non-zero, and its own
# cause must not be overwritten by the shutdown half; the quit-pass evidence
# is in the record either way.
if ($quitPassEvidence -and -not $quitPassEvidence.ok -and $verdict -eq 'RESPONSIVE') {
    $verdict = 'QUIT_DIRTY'
    $lastDetail = "graceful quit failed: $(@($quitPassEvidence.failures) -join '; ')"
}

$summary = [pscustomobject]@{
    verdict        = $verdict
    detail         = $lastDetail
    window_appeared = $windowSeen
    window_at_ms   = ($timeline | Where-Object { $_.event -eq 'window_appeared' } | Select-Object -First 1).at_ms
    server_at_ms   = ($timeline | Where-Object { $_.event -eq 'server_listening' } | Select-Object -First 1).at_ms
    server_healthy = ($null -ne $healthPayload)
    health         = $healthPayload
    children       = @($childProcesses)
    children_query = $childrenEvidence.status
    listener_query = $listenerStatus
    server_ownership = $serverOwnership
    timeline       = $timeline.ToArray()
    stdout_tail    = $stdoutTail
    stderr_tail    = $stderrTail
    app_log        = $appLog
}
# DD-083: the shutdown evidence joins the record only when the quit pass ran,
# so a default run's summary object is unchanged.
if ($quitPassEvidence) {
    $summary | Add-Member -NotePropertyName quit_pass -NotePropertyValue $quitPassEvidence
}
$summary | ConvertTo-Json -Depth 6 | Write-Output

Write-Host "`nVERDICT: $verdict - $lastDetail" -ForegroundColor $(if ($verdict -eq 'RESPONSIVE') { 'Green' } else { 'Red' })
exit $(if ($verdict -eq 'RESPONSIVE') { 0 } else { 1 })
} finally {
    try {
        if ($process) {
            # DD-053: the verdict is already written; the cleanup must not be
            # able to stall it out of existence. A cleanup failure after that
            # point is a warning, never a throw that would mask the verdict
            # or skip the scratch-install removal below.
            Stop-JarvisOwnedProcesses -Process $process `
                -CleanupDeadline (Get-Date).AddSeconds($CleanupTimeoutSeconds)
        }
    } catch {
        Write-Warn "owned process cleanup did not finish: $_"
    } finally {
        if ($installOwned -and -not $KeepInstall) {
            Remove-JarvisReleaseScratchInstall -InstallRoot $InstallRoot
        }
    }
}
