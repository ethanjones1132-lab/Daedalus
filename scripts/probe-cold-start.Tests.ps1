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

    DD-083 adds the opt-in graceful-quit pass (-QuitPass). Its helper,
    Test-JarvisProbeQuitPass, lives in the probe itself and is extracted
    here by AST so it can be driven entirely on fakes; a run without
    -QuitPass is pinned unchanged.

    DD-095 adds the fixed-port preflight: it runs before the observation
    deadline exists, so Assert-JarvisPortAvailable bounds its listener query
    with a deadline of its own. The cases below drive it through an injected
    stalling query (a local Start-Sleep) and through free/in-use answers, so
    no real port is opened and nothing is installed or launched.
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

# Extracts the probe's Test-JarvisProbeQuitPass function by AST and returns
# it as a scriptblock, so the quit-pass cases below can invoke it on fakes
# without running the probe (whose body would install, launch and listen).
function Get-ProbeQuitPassFunction {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput(
        (Get-Content -Raw -LiteralPath $probePath), [ref]$tokens, [ref]$parseErrors)
    if (@($parseErrors).Count -gt 0) { throw "probe parse errors: $($parseErrors[0].Message)" }
    $definitions = @($ast.FindAll({
        param($node)
        ($node -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and
        ($node.Name -eq 'Test-JarvisProbeQuitPass')
    }, $true))
    if ($definitions.Count -ne 1) {
        throw 'Test-JarvisProbeQuitPass not found exactly once in probe-cold-start.ps1'
    }
    # Body.Extent.Text carries the function body's own braces; a scriptblock
    # created from that text verbatim is a scriptblock *literal* (it returns
    # the inner scriptblock), so $quit.* read $null in every case below.
    # GetScriptBlock() compiles the same AST as a runnable scriptblock.
    return $definitions[0].Body.GetScriptBlock()
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

Describe 'fixed-port preflight is bounded (DD-095)' {
    # The preflight runs BEFORE the observation deadline exists, so it needs
    # its own: a listener query that stops answering must fail the preflight
    # inside that budget, with a bounded-query status, and never hang the run.
    # The listener seam is a scriptblock, so no real port is opened here.
    It 'passes a free port and hands back the bounded query result' {
        $result = Assert-JarvisPortAvailable -Port 19877 -Deadline ((Get-Date).AddSeconds(10)) -ListenerQuery { param($Port) $null }
        $result.name | Should Be 'preflight_listener'
        $result.status | Should Be 'result'
        ($null -eq $result.value) | Should Be $true
    }

    It 'fails a port that is really in use, naming the port' {
        $listener = { param($Port) [pscustomobject]@{ LocalPort = $Port; State = 'Listen'; OwningProcess = 555 } }
        $thrown = $null
        try {
            $null = Assert-JarvisPortAvailable -Port 19877 -Deadline ((Get-Date).AddSeconds(10)) -ListenerQuery $listener
        } catch { $thrown = $_ }
        ($null -ne $thrown) | Should Be $true
        $thrown.Exception.Message | Should Match 'port_already_in_use:19877'
    }

    It 'returns inside its budget with a bounded-query status when the listener query stalls' {
        $stalled = {
            param($Port)
            Start-Sleep -Seconds 15
            [pscustomobject]@{ LocalPort = $Port; State = 'Listen'; OwningProcess = 555 }
        }
        $thrown = $null
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $null = Assert-JarvisPortAvailable -Port 19877 -Deadline ((Get-Date).AddSeconds(1)) -ListenerQuery $stalled
        } catch { $thrown = $_ }
        $watch.Stop()

        # A bounded-query status, not a guessed verdict and not a hang: the
        # query sleeps for 15s, the budget is 1s, and the call comes back.
        ($null -ne $thrown) | Should Be $true
        $thrown.Exception.Message | Should Match 'port_check_timed_out:19877'
        ($watch.Elapsed.TotalSeconds -lt 5) | Should Be $true
    }

    It 'bounds the preflight at both call sites with a deadline' {
        $probeText = Get-Content -Raw -LiteralPath $probePath
        $probeText | Should Match 'Assert-JarvisPortAvailable -Port 19877 -Deadline'
        $probeText | Should Match 'ListenerQuery \(Get-JarvisProbeListenerQuery\)'
        $smokeText = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'release-smoke.ps1')
        $smokeText | Should Match 'Assert-JarvisPortAvailable -Port \$ServerPort -Deadline'
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

Describe 'graceful quit pass (DD-083)' {
    # Every case drives the extracted probe helper on fakes: the fake
    # process is a record, the close/exit seams are local scriptblocks, and
    # the children and port queries run in the same bounded runspaces the
    # observation loop uses, fed by injected fakes. No installer, no app, no
    # listener, no real OS query ever runs here.
    It 'passes when the app exits, leaves no owned children and the port is free' {
        $quit = & (Get-ProbeQuitPassFunction) -Process (New-FakeProbeProcess) `
            -CloseMainWindow { param($Proc) $true } `
            -WaitExit { param($Proc, $TimeoutMs) $true } `
            -ChildrenQuery { param($ProbeId) } `
            -ListenerQuery { param($Port) $null }
        $quit.ok | Should Be $true
        $quit.close_requested | Should Be $true
        $quit.exited | Should Be $true
        @($quit.children).Count | Should Be 0
        $quit.listener_status | Should Be 'result'
        @($quit.failures).Count | Should Be 0
    }

    It 'fails and names the PID of an owned child that survived the quit' {
        $quit = & (Get-ProbeQuitPassFunction) -Process (New-FakeProbeProcess) `
            -CloseMainWindow { param($Proc) $true } `
            -WaitExit { param($Proc, $TimeoutMs) $true } `
            -ChildrenQuery {
                param($ProbeId)
                [pscustomobject]@{ ProcessId = 5001; ParentProcessId = $ProbeId; Name = 'bun.exe' }
            } `
            -ListenerQuery { param($Port) $null }
        $quit.ok | Should Be $false
        @($quit.children).Count | Should Be 1
        $quit.children[0].ProcessId | Should Be 5001
        ($quit.failures -join '; ') | Should Match 'owned_child_survived_quit:pid=5001'
    }

    It 'fails and names the owner when the port is still bound after the quit' {
        $quit = & (Get-ProbeQuitPassFunction) -Process (New-FakeProbeProcess) `
            -CloseMainWindow { param($Proc) $true } `
            -WaitExit { param($Proc, $TimeoutMs) $true } `
            -ChildrenQuery { param($ProbeId) } `
            -ListenerQuery { param($Port) [pscustomobject]@{ OwningProcess = 4000 } }
        $quit.ok | Should Be $false
        $quit.listener_pid | Should Be 4000
        ($quit.failures -join '; ') | Should Match 'port_19877_still_listening:owner_pid=4000'
    }

    It 'fails when the app never exits inside the quit budget and skips the shutdown assertions' {
        # An app that is still running still has its children and its port;
        # listing them as shutdown failures would invent evidence. The
        # no-exit failure carries the run instead.
        $quit = & (Get-ProbeQuitPassFunction) -Process (New-FakeProbeProcess) `
            -CloseMainWindow { param($Proc) $true } `
            -WaitExit { param($Proc, $TimeoutMs) $false } `
            -ChildrenQuery { param($ProbeId) throw 'children_query_must_not_run_before_exit' } `
            -ListenerQuery { param($Port) throw 'port_query_must_not_run_before_exit' }
        $quit.ok | Should Be $false
        ($quit.failures -join '; ') | Should Match 'app_did_not_exit_within'
        $quit.children_query | Should Be 'not_queried'
        $quit.listener_status | Should Be 'not_queried'
    }

    It 'fails closed when the children query does not answer' {
        $quit = & (Get-ProbeQuitPassFunction) -Process (New-FakeProbeProcess) `
            -CloseMainWindow { param($Proc) $true } `
            -WaitExit { param($Proc, $TimeoutMs) $true } `
            -QueryTimeoutSeconds 1 `
            -ChildrenQuery { param($ProbeId) Start-Sleep -Seconds 15 } `
            -ListenerQuery { param($Port) $null }
        $quit.ok | Should Be $false
        $quit.children_query | Should Be 'timed_out'
        ($quit.failures -join '; ') | Should Match 'children_query_timed_out'
    }

    It 'bounds the quit children and port queries so a stalled query cannot hold the pass open' {
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $quit = & (Get-ProbeQuitPassFunction) -Process (New-FakeProbeProcess) `
            -CloseMainWindow { param($Proc) $true } `
            -WaitExit { param($Proc, $TimeoutMs) $true } `
            -QueryTimeoutSeconds 1 `
            -ChildrenQuery { param($ProbeId) Start-Sleep -Seconds 15 } `
            -ListenerQuery { param($Port) Start-Sleep -Seconds 15 }
        $watch.Stop()
        ($watch.Elapsed.TotalSeconds -lt 10) | Should Be $true
        $quit.children_query | Should Be 'timed_out'
        $quit.listener_status | Should Be 'timed_out'
        $quit.ok | Should Be $false
    }

    It 'declares -QuitPass as a switch, off by default' {
        $probeText = Get-Content -Raw -LiteralPath $probePath
        $probeText | Should Match ([regex]::Escape('[switch]$QuitPass'))
    }

    It 'guards the quit pass behind the -QuitPass switch so a default run never reaches it' {
        # Regression pin for the default path: exactly one call site, and it
        # must sit inside an `if ($QuitPass)` - anything else would change a
        # run that passes no -QuitPass.
        $tokens = $null
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput(
            (Get-Content -Raw -LiteralPath $probePath), [ref]$tokens, [ref]$parseErrors)
        $parseErrors | Should BeNullOrEmpty
        $calls = @($ast.FindAll({
            param($node)
            ($node -is [System.Management.Automation.Language.CommandAst]) -and
            ($node.GetCommandName() -eq 'Test-JarvisProbeQuitPass')
        }, $true))
        $calls.Count | Should Be 1
        $node = $calls[0]
        $guard = $null
        while ($node -and (-not $guard)) {
            $node = $node.Parent
            if ($node -is [System.Management.Automation.Language.IfStatementAst]) { $guard = $node }
        }
        ($null -ne $guard) | Should Be $true
        ([string]$guard.Clauses[0].Item1) | Should Be '$QuitPass'
    }

    It 'joins the quit-pass evidence to the record only when the quit pass ran' {
        # The summary object is built once for every run; a default run's
        # JSON must not gain a quit_pass field, so the member is added
        # behind the ran guard rather than in the literal.
        $probeText = Get-Content -Raw -LiteralPath $probePath
        $probeText | Should Match 'Add-Member -NotePropertyName quit_pass'
    }

    It 'turns a dirty quit into a failing QUIT_DIRTY verdict' {
        $probeText = Get-Content -Raw -LiteralPath $probePath
        $probeText | Should Match "'QUIT_DIRTY'"
        $probeText | Should Match 'quit_pass'
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
