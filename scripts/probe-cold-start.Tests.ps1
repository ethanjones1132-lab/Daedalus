<#
.SYNOPSIS
    Offline regression tests for the cold-start probe's bounded OS queries.

.DESCRIPTION
    The recorded defect: a cold-start probe ran for more than 15 minutes
    against a 120s observation budget, because the deadline was only checked
    BETWEEN synchronous OS queries. Checking a clock cannot bound a stalled
    call; only running the call somewhere else and refusing to wait past the
    budget can.

    These tests exercise scripts/lib/probe-bounded-queries.ps1 with every OS
    seam stubbed. Nothing here installs anything, launches a GUI, opens a
    port, or inspects the running machine: the "slow query" is a local
    Start-Sleep, and every listener/process record is a fake object.

    Run with Pester 3.4 (Should Be / Should Match):
        Invoke-Pester -Script scripts/probe-cold-start.Tests.ps1 -EnableExit

    DD-052/DD-053 assertions sit on top: the probe must report the packaged
    app's own log directory (%LOCALAPPDATA%\com.jarvis.desktop\logs) and
    ignore log files written before the run was launched, and the owned
    process teardown in scripts/lib/release-common.ps1 must give every CIM
    query up at its cleanup deadline. The deadline tests stub the CIM cmdlet
    and the bounded dispatcher, so no real CIM query is ever run.
#>

. (Join-Path $PSScriptRoot 'lib\probe-bounded-queries.ps1')
. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

$probePath = Join-Path $PSScriptRoot 'probe-cold-start.ps1'
$releaseCommonPath = Join-Path $PSScriptRoot 'lib\release-common.ps1'

function New-FakeProbeProcess {
    param(
        [int]$Id = 4000,
        [datetime]$StartedAt = [datetime]'2026-10-21T10:00:00',
        [bool]$HasExited = $false,
        $ExitCode = $null
    )
    return [pscustomobject]@{
        Id                   = $Id
        HasExited            = $HasExited
        ExitCode             = $ExitCode
        JarvisOwnedStartTime = $StartedAt
    }
}

function New-ObservationArguments {
    param(
        $Process,
        [datetime]$ProbeStartedAt = [datetime]'2026-10-21T10:00:00',
        [datetime]$Deadline,
        [scriptblock]$ListenerQuery,
        [scriptblock]$ProcessQuery = { param($ProcessId) $null }
    )
    return @{
        Process        = $Process
        ProbeStartedAt = $ProbeStartedAt
        Deadline       = $Deadline
        Port           = 19877
        ListenerQuery  = $ListenerQuery
        ProcessQuery   = $ProcessQuery
    }
}

Describe 'bounded query dispatch' {
    It 'returns the query result when it completes inside the budget' {
        $result = Invoke-JarvisProbeBoundedQuery -Name 'echo' -Query { param($Value) $Value } `
            -ArgumentList @('19877') -Deadline ((Get-Date).AddSeconds(10))
        $result.status | Should Be 'result'
        $result.value | Should Be '19877'
        ($result.error -eq $null) | Should Be $true
    }

    It 'reports an empty answer as a completed query, not as a timeout' {
        $result = Invoke-JarvisProbeBoundedQuery -Name 'no-listener' -Query { param($Port) $null } `
            -ArgumentList @(19877) -Deadline ((Get-Date).AddSeconds(10))
        $result.status | Should Be 'result'
        ($null -eq $result.value) | Should Be $true
    }

    It 'stops waiting when a query outlives the observation budget' {
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $result = Invoke-JarvisProbeBoundedQuery -Name 'slow' `
            -Query { param($Port) Start-Sleep -Seconds 15; 'late answer' } `
            -ArgumentList @(19877) -Deadline ((Get-Date).AddSeconds(1))
        $watch.Stop()

        $result.status | Should Be 'timed_out'
        ($null -eq $result.value) | Should Be $true
        ($watch.Elapsed.TotalSeconds -lt 5) | Should Be $true
    }

    It 'does not start a query after the budget is already spent' {
        $result = Invoke-JarvisProbeBoundedQuery -Name 'late-start' `
            -Query { param($Port) throw 'query_must_not_run' } `
            -ArgumentList @(19877) -Deadline ((Get-Date).AddSeconds(-1))
        $result.status | Should Be 'timed_out'
        ($null -eq $result.error) | Should Be $true
        ($null -eq $result.value) | Should Be $true
    }

    It 'reports a query that throws as failed, not as a result' {
        $result = Invoke-JarvisProbeBoundedQuery -Name 'explodes' `
            -Query { param($Port) throw 'os_query_exploded' } `
            -ArgumentList @(19877) -Deadline ((Get-Date).AddSeconds(10))
        $result.status | Should Be 'failed'
        $result.error | Should Match 'os_query_exploded'
        ($null -eq $result.value) | Should Be $true
    }

    It 'reports a non-terminating query error as failed' {
        $result = Invoke-JarvisProbeBoundedQuery -Name 'warns' `
            -Query { param($Port) Write-Error 'wmi_unavailable' } `
            -ArgumentList @(19877) -Deadline ((Get-Date).AddSeconds(10))
        $result.status | Should Be 'failed'
        $result.error | Should Match 'wmi_unavailable'
    }
}

Describe 'server ownership evidence' {
    It 'accepts a listener that is a child of the probe process' {
        $ownership = Test-JarvisProbeOwnedServer `
            -Listener ([pscustomobject]@{ OwningProcess = 5000 }) `
            -Candidate ([pscustomobject]@{ ProcessId = 5000; ParentProcessId = 4000; CreationDate = [datetime]'2026-10-21T10:00:01' }) `
            -ProbeProcessId 4000 `
            -ProbeStartedAt ([datetime]'2026-10-21T10:00:00')
        $ownership.owned | Should Be $true
        $ownership.pid | Should Be 5000
        $ownership.reason | Should Be 'owned'
    }

    It 'rejects a foreign listener even when the port is open' {
        $ownership = Test-JarvisProbeOwnedServer `
            -Listener ([pscustomobject]@{ OwningProcess = 555 }) `
            -Candidate ([pscustomobject]@{ ProcessId = 555; ParentProcessId = 9; CreationDate = [datetime]'2026-10-21T10:00:02' }) `
            -ProbeProcessId 4000 `
            -ProbeStartedAt ([datetime]'2026-10-21T10:00:00')
        $ownership.owned | Should Be $false
        $ownership.reason | Should Match 'foreign'
    }

    It 'rejects a reused-PID listener that predates the probe process' {
        $ownership = Test-JarvisProbeOwnedServer `
            -Listener ([pscustomobject]@{ OwningProcess = 5000 }) `
            -Candidate ([pscustomobject]@{ ProcessId = 5000; ParentProcessId = 4000; CreationDate = [datetime]'2026-10-21T09:00:00' }) `
            -ProbeProcessId 4000 `
            -ProbeStartedAt ([datetime]'2026-10-21T10:00:00')
        $ownership.owned | Should Be $false
        $ownership.reason | Should Match 'predates'
    }

    It 'accepts a child created exactly when the probe process started' {
        $ownership = Test-JarvisProbeOwnedServer `
            -Listener ([pscustomobject]@{ OwningProcess = 5000 }) `
            -Candidate ([pscustomobject]@{ ProcessId = 5000; ParentProcessId = 4000; CreationDate = [datetime]'2026-10-21T10:00:00' }) `
            -ProbeProcessId 4000 `
            -ProbeStartedAt ([datetime]'2026-10-21T10:00:00')
        $ownership.owned | Should Be $true
    }

    It 'does not credit a listener whose owning process changed between queries' {
        $ownership = Test-JarvisProbeOwnedServer `
            -Listener ([pscustomobject]@{ OwningProcess = 5000 }) `
            -Candidate ([pscustomobject]@{ ProcessId = 6000; ParentProcessId = 4000; CreationDate = [datetime]'2026-10-21T10:00:01' }) `
            -ProbeProcessId 4000 `
            -ProbeStartedAt ([datetime]'2026-10-21T10:00:00')
        $ownership.owned | Should Be $false
        $ownership.reason | Should Be 'listener_owner_changed'
    }

    It 'does not accept ownership without a known probe start time' {
        $ownership = Test-JarvisProbeOwnedServer `
            -Listener ([pscustomobject]@{ OwningProcess = 5000 }) `
            -Candidate ([pscustomobject]@{ ProcessId = 5000; ParentProcessId = 4000; CreationDate = [datetime]'2026-10-21T10:00:01' }) `
            -ProbeProcessId 4000 `
            -ProbeStartedAt $null
        $ownership.owned | Should Be $false
        $ownership.reason | Should Be 'probe_start_unknown'
    }
}

Describe 'cold-start observation poll' {
    It 'credits the server when the listener is an owned child' {
        $process = New-FakeProbeProcess
        $arguments = New-ObservationArguments -Process $process -Deadline ((Get-Date).AddSeconds(10)) `
            -ListenerQuery { param($Port) [pscustomobject]@{ OwningProcess = 5000 } } `
            -ProcessQuery {
                param($ProcessId)
                [pscustomobject]@{ ProcessId = 5000; ParentProcessId = 4000; CreationDate = [datetime]'2026-10-21T10:00:01' }
            }
        $observation = Get-JarvisColdStartObservation @arguments
        $observation.server_listening | Should Be $true
        $observation.server_pid | Should Be 5000
        $observation.listener_status | Should Be 'result'
        $observation.process_status | Should Be 'result'
        $observation.reason | Should Be 'owned'
    }

    It 'reports no listener without inventing one' {
        $process = New-FakeProbeProcess
        $arguments = New-ObservationArguments -Process $process -Deadline ((Get-Date).AddSeconds(10)) `
            -ListenerQuery { param($Port) $null }
        $observation = Get-JarvisColdStartObservation @arguments
        $observation.server_listening | Should Be $false
        $observation.listener_status | Should Be 'result'
        $observation.reason | Should Be 'no_listener'
    }

    It 'never accepts a foreign listener on the probe port' {
        $process = New-FakeProbeProcess
        $arguments = New-ObservationArguments -Process $process -Deadline ((Get-Date).AddSeconds(10)) `
            -ListenerQuery { param($Port) [pscustomobject]@{ OwningProcess = 555 } } `
            -ProcessQuery {
                param($ProcessId)
                [pscustomobject]@{ ProcessId = 555; ParentProcessId = 9; CreationDate = [datetime]'2026-10-21T10:00:01' }
            }
        $observation = Get-JarvisColdStartObservation @arguments
        $observation.server_listening | Should Be $false
        $observation.reason | Should Match 'foreign'
    }

    It 'never accepts a reused-PID listener that predates the probe' {
        $process = New-FakeProbeProcess
        $arguments = New-ObservationArguments -Process $process -Deadline ((Get-Date).AddSeconds(10)) `
            -ListenerQuery { param($Port) [pscustomobject]@{ OwningProcess = 5000 } } `
            -ProcessQuery {
                param($ProcessId)
                [pscustomobject]@{ ProcessId = 5000; ParentProcessId = 4000; CreationDate = [datetime]'2026-10-21T09:00:00' }
            }
        $observation = Get-JarvisColdStartObservation @arguments
        $observation.server_listening | Should Be $false
        $observation.reason | Should Match 'predates'
    }

    It 'passes the window state through unchanged' {
        $process = New-FakeProbeProcess
        $arguments = New-ObservationArguments -Process $process -Deadline ((Get-Date).AddSeconds(10)) `
            -ListenerQuery { param($Port) $null }
        $observation = Get-JarvisColdStartObservation @arguments -WindowState {
            param($app)
            [pscustomobject]@{ has_window = $true; main_window = 'Jarvis'; responsive = $true }
        }
        $observation.window_status | Should Be 'result'
        $observation.has_window | Should Be $true
        $observation.main_window | Should Be 'Jarvis'
        $observation.responsive | Should Be $true
    }

    It 'reports a listener query that outlives the budget honestly and stops' {
        $process = New-FakeProbeProcess
        $arguments = New-ObservationArguments -Process $process -Deadline ((Get-Date).AddSeconds(1)) `
            -ListenerQuery { param($Port) Start-Sleep -Seconds 15; [pscustomobject]@{ OwningProcess = 5000 } }
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $observation = Get-JarvisColdStartObservation @arguments
        $watch.Stop()

        $observation.listener_status | Should Be 'timed_out'
        $observation.server_listening | Should Be $false
        $observation.reason | Should Be 'listener_query_timed_out'
        ($null -eq $observation.server_pid) | Should Be $true
        ($watch.Elapsed.TotalSeconds -lt 5) | Should Be $true
    }

    It 'reports a failed listener query as unavailable' {
        $process = New-FakeProbeProcess
        $arguments = New-ObservationArguments -Process $process -Deadline ((Get-Date).AddSeconds(10)) `
            -ListenerQuery { param($Port) throw 'net_tcp_query_failed' }
        $observation = Get-JarvisColdStartObservation @arguments
        $observation.listener_status | Should Be 'failed'
        $observation.server_listening | Should Be $false
        $observation.reason | Should Be 'listener_query_failed'
    }

    It 'does not accept a listener whose owning process cannot be identified' {
        $process = New-FakeProbeProcess
        $arguments = New-ObservationArguments -Process $process -Deadline ((Get-Date).AddSeconds(10)) `
            -ListenerQuery { param($Port) [pscustomobject]@{ OwningProcess = 0 } }
        $observation = Get-JarvisColdStartObservation @arguments
        $observation.server_listening | Should Be $false
        $observation.reason | Should Be 'listener_owner_unknown'
    }

    It 'reports a stalled owning-process query as unavailable' {
        $process = New-FakeProbeProcess
        $arguments = New-ObservationArguments -Process $process -Deadline ((Get-Date).AddSeconds(1)) `
            -ListenerQuery { param($Port) [pscustomobject]@{ OwningProcess = 5000 } } `
            -ProcessQuery { param($ProcessId) Start-Sleep -Seconds 15; [pscustomobject]@{ ProcessId = 5000 } }
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $observation = Get-JarvisColdStartObservation @arguments
        $watch.Stop()

        $observation.process_status | Should Be 'timed_out'
        $observation.server_listening | Should Be $false
        $observation.reason | Should Be 'process_query_timed_out'
        ($watch.Elapsed.TotalSeconds -lt 5) | Should Be $true
    }

    It 'reports a process that died during boot without querying the server' {
        $process = New-FakeProbeProcess -HasExited $true -ExitCode 3
        $observation = Get-JarvisColdStartObservation -Process $process `
            -Deadline ((Get-Date).AddSeconds(10)) -Port 19877 `
            -ListenerQuery { param($Port) throw 'listener_query_must_not_run' } `
            -ProcessQuery { param($ProcessId) throw 'process_query_must_not_run' }
        $observation.exited | Should Be $true
        $observation.exit_code | Should Be 3
        $observation.listener_status | Should Be 'not_queried'
        $observation.server_listening | Should Be $false
    }

    It 'does not start any query once the observation deadline has passed' {
        $process = New-FakeProbeProcess
        $observation = Get-JarvisColdStartObservation -Process $process `
            -Deadline ((Get-Date).AddSeconds(-1)) -Port 19877 `
            -ListenerQuery { param($Port) throw 'listener_query_must_not_run' } `
            -ProcessQuery { param($ProcessId) throw 'process_query_must_not_run' }
        $observation.listener_status | Should Be 'timed_out'
        $observation.server_listening | Should Be $false
        $observation.reason | Should Be 'listener_query_timed_out'
    }
}

Describe 'child process evidence' {
    It 'records the children a completed snapshot returns' {
        $evidence = Get-JarvisProbeChildProcessEvidence -ProbeProcessId 4000 `
            -Deadline ((Get-Date).AddSeconds(10)) `
            -ProcessSnapshotQuery { param($ProbeId) [pscustomobject]@{ ProcessId = 5000; ParentProcessId = $ProbeId } }
        $evidence.status | Should Be 'result'
        @($evidence.children).Count | Should Be 1
    }

    It 'reports a snapshot that outlives its budget without inventing children' {
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $evidence = Get-JarvisProbeChildProcessEvidence -ProbeProcessId 4000 `
            -Deadline ((Get-Date).AddSeconds(1)) `
            -ProcessSnapshotQuery { param($ProbeId) Start-Sleep -Seconds 15 }
        $watch.Stop()
        $evidence.status | Should Be 'timed_out'
        @($evidence.children).Count | Should Be 0
        ($watch.Elapsed.TotalSeconds -lt 5) | Should Be $true
    }
}

Describe 'probe wiring' {
    It 'loads the bounded query helpers' {
        (Get-Content -Raw -LiteralPath $probePath) | Should Match 'lib\\probe-bounded-queries\.ps1'
    }

    It 'runs the observation loop and evidence collection through the helpers' {
        $probeText = Get-Content -Raw -LiteralPath $probePath
        $probeText | Should Match 'Get-JarvisColdStartObservation'
        $probeText | Should Match 'Get-JarvisProbeChildProcessEvidence'
    }

    It 'does not call the OS query cmdlets directly' {
        # Regression: the discard-worthy shape was a direct synchronous call
        # in the loop, which no between-call deadline can bound.
        $probeText = Get-Content -Raw -LiteralPath $probePath
        ($probeText -match 'Get-CimInstance') | Should Be $false
        ($probeText -match 'Get-NetTCPConnection') | Should Be $false
    }

    It 'keeps ownership evidence and cleanup ownership in the probe' {
        $probeText = Get-Content -Raw -LiteralPath $probePath
        $probeText | Should Match 'JarvisOwnedStartTime'
        $probeText | Should Match '-ProbeStartedAt'
        $probeText | Should Match 'Stop-JarvisOwnedProcesses'
    }

    It 'keeps the HUNG, DIED and SERVER_UNAVAILABLE verdicts' {
        $probeText = Get-Content -Raw -LiteralPath $probePath
        $probeText | Should Match "'HUNG'"
        $probeText | Should Match "'DIED'"
        $probeText | Should Match "'SERVER_UNAVAILABLE'"
    }
}

Describe 'app log evidence comes from the packaged app (DD-052)' {
    # src-tauri/src/lib.rs jarvis_server_log_stdio resolves the packaged
    # app's log directory (mirrored in server-jarvis/src/self-log.ts
    # selfLogDir) to %LOCALAPPDATA%\com.jarvis.desktop\logs on Windows.
    # The old home-directory path belongs to the source-tree server, never
    # to this install, so any trace of it in the app_log wiring is a defect.
    It 'points app_log at the LOCALAPPDATA directory jarvis_server_log_stdio writes' {
        $probeText = Get-Content -Raw -LiteralPath $probePath
        $probeText | Should Match 'LOCALAPPDATA'
        $probeText | Should Match "'com\.jarvis\.desktop\\logs'"
    }

    It 'does not read the openclaw home log directory for app_log' {
        $probeText = Get-Content -Raw -LiteralPath $probePath
        ($probeText -match '\.openclaw\\jarvis\\logs') | Should Be $false
    }

    It 'ignores log files written before this run was launched' {
        # A newest-file pick without the launch-time guard reports an older
        # run's log as this run's boot evidence. Reverting the filter fails
        # this assertion because the filter expression is the thing matched.
        $probeText = Get-Content -Raw -LiteralPath $probePath
        $probeText | Should Match '\$launchedAt'
        $probeText | Should Match 'LastWriteTime -ge \$launchedAt'
    }
}

Describe 'owned process cleanup deadline (DD-053)' {
    # These tests stub every seam they touch (Get-CimInstance,
    # Invoke-JarvisCleanupBoundedQuery, Stop-Process, Write-Warning), so
    # nothing here executes a real CIM query or stops a real process.
    It 'runs no CIM query at all once the cleanup deadline has expired' {
        Mock Get-CimInstance { throw 'cim_query_must_not_run_once_deadline_expired' }
        Mock Stop-Process { }
        Stop-JarvisOwnedProcesses -Process (New-FakeProbeProcess -Id 4400) `
            -CleanupDeadline ((Get-Date).AddSeconds(-1))

        Assert-MockCalled Get-CimInstance -Scope It -Times 0 -Exactly
        # Giving up is not failure: the root process is still stopped when
        # that is possible without further queries.
        Assert-MockCalled Stop-Process -Scope It -Times 1 -Exactly -ParameterFilter { $Id -eq 4400 }
    }

    It 'warns, enumerates no descendants, and still stops the root when the table query stalls past the deadline' {
        # In the deadline path the first cleanup query is the owned-process
        # table. Stubbed here as one that outlived the deadline, it must
        # collapse into a warning - never a throw that would fall out of a
        # caller's finally and drop an already-written verdict - and the
        # root process must still be stopped.
        $script:cleanupWarningCount = 0
        Mock Invoke-JarvisCleanupBoundedQuery {
            [pscustomobject]@{
                name = 'owned_process_table'; status = 'timed_out'; value = $null
                error = $null; detail = 'query_outlived_cleanup_deadline'
            }
        }
        Mock Write-Warning { $script:cleanupWarningCount = $script:cleanupWarningCount + 1 }
        Mock Get-CimInstance { throw 'cim_query_must_not_run_in_test' }
        Mock Stop-Process { }
        Stop-JarvisOwnedProcesses -Process (New-FakeProbeProcess -Id 4400) `
            -CleanupDeadline ((Get-Date).AddSeconds(5))

        ($script:cleanupWarningCount) | Should Be 1
        Assert-MockCalled Get-CimInstance -Scope It -Times 0 -Exactly
        Assert-MockCalled Stop-Process -Scope It -Times 1 -Exactly -ParameterFilter { $Id -eq 4400 }
    }

    It 'gives up an owned child whose identity check stalled and still stops the root' {
        # Call order in the deadline path: (1) owned-process table, (2) one
        # identity re-check per owned child, descending. The table yields an
        # owned child of the fake root; its identity check stalls past the
        # deadline. Failing closed on identity, a stalled re-check never
        # terminates a PID that may have been reused - but the root dies.
        $script:cleanupQueryCalls = 0
        $script:cleanupWarningCount = 0
        Mock Invoke-JarvisCleanupBoundedQuery {
            $script:cleanupQueryCalls = $script:cleanupQueryCalls + 1
            if ($script:cleanupQueryCalls -eq 1) {
                return [pscustomobject]@{
                    status = 'result'; error = $null
                    value = @(
                        [pscustomobject]@{
                            ProcessId = 5001; ParentProcessId = 4400
                            CreationDate = [datetime]'2026-10-21T10:00:01'
                        }
                    )
                }
            }
            return [pscustomobject]@{ status = 'timed_out'; value = $null; error = $null }
        }
        Mock Write-Warning { $script:cleanupWarningCount = $script:cleanupWarningCount + 1 }
        Mock Stop-Process { }
        Stop-JarvisOwnedProcesses -Process (New-FakeProbeProcess -Id 4400) `
            -CleanupDeadline ((Get-Date).AddSeconds(5))

        ($script:cleanupQueryCalls) | Should Be 2
        Assert-MockCalled Stop-Process -Scope It -Times 0 -Exactly -ParameterFilter { $Id -eq 5001 }
        Assert-MockCalled Stop-Process -Scope It -Times 1 -Exactly -ParameterFilter { $Id -eq 4400 }
        ($script:cleanupWarningCount) | Should Be 1
    }

    It 'bounds the cleanup CIM queries with a deadline passed from the probe teardown' {
        # Both halves must survive: release-common must own the bounded
        # deadline machinery, and the probe must actually hand it a deadline
        # in its finally block. Reverting either side fails here.
        $probeText = Get-Content -Raw -LiteralPath $probePath
        $probeText | Should Match '-CleanupDeadline'
        $probeText | Should Match '\$CleanupTimeoutSeconds'
        $commonText = Get-Content -Raw -LiteralPath $releaseCommonPath
        $commonText | Should Match 'Invoke-JarvisCleanupBoundedQuery'
        $commonText | Should Match 'CleanupDeadline'
    }
}
