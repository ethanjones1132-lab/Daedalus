<#
.SYNOPSIS
    Bounded OS queries and server-ownership decisions for the cold-start probe.

.DESCRIPTION
    Dot-source this file. It defines functions only; it has no top-level side
    effects:

        . (Join-Path $PSScriptRoot 'lib\probe-bounded-queries.ps1')

    scripts/probe-cold-start.ps1 watches a packaged app boot. It has an
    observation budget (120s by default), and the 2026-10 cold-start run
    showed that checking the clock BETWEEN OS calls does not bound it: a
    Get-NetTCPConnection or Get-CimInstance that stops answering blocks the
    PowerShell pipeline forever, so a "120 second" probe ran for more than
    15 minutes.

    The fix is to never run an OS query on the probe's own pipeline:

      * Invoke-JarvisProbeBoundedQuery dispatches ONE query to its OWN
        runspace and waits at most the remaining observation budget. It
        returns exactly one of three states:

            result     - the query completed; `value` is what it returned
                         (and $null is a legitimate value: "no listener").
            timed_out  - the budget expired first. `value` is $null. The
                         pipeline is asked to stop but never joined, because
                         a call stuck in the OS would block the join exactly
                         as it blocked the query. No answer is invented.
            failed     - the query itself errored; `error` carries the text.

      * Test-JarvisProbeOwnedServer is the single ownership decision: the
        listening PID must be a child of the probe process AND must have been
        created at or after the probe started. Port-open alone is never
        evidence, and neither is a parent-PID match on a reused PID.

      * Get-JarvisColdStartObservation is one poll of the observation loop:
        process exit (DIED), window state (injected), then the bounded
        listener and owning-process queries plus the ownership decision.

      * Get-JarvisProbeChildProcessEvidence is the bounded child-process
        snapshot the probe records as evidence after the loop.

    The tests in scripts/probe-cold-start.Tests.ps1 stub every OS seam, so
    they exercise the budget and the ownership rules without an installer, a
    GUI, or a real listener.
#>

# ── Bounded query dispatch ───────────────────────────────────────────────────

function New-JarvisProbeQueryResult {
    <#
    .SYNOPSIS
        The single result shape for every bounded query.

    .DESCRIPTION
        `status` is the honest part: 'result' means the query ran to
        completion, 'timed_out' means the budget expired first, 'failed'
        means the query errored. A timed-out or failed query never carries a
        value, so a caller cannot mistake "no answer yet" for "no listener".
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Status,
        $Value = $null,
        [string]$ErrorMessage = '',
        [int]$ElapsedMs = 0,
        [int]$BudgetMs = 0,
        [string]$Detail = ''
    )
    return [pscustomobject]@{
        name       = $Name
        status     = $Status
        value      = $Value
        error      = $(if ([string]::IsNullOrEmpty($ErrorMessage)) { $null } else { $ErrorMessage })
        elapsed_ms = $ElapsedMs
        budget_ms  = $BudgetMs
        detail     = $(if ([string]::IsNullOrEmpty($Detail)) { $null } else { $Detail })
    }
}

function Invoke-JarvisProbeBoundedQuery {
    <#
    .SYNOPSIS
        Run one OS query in its own runspace, bounded by the observation budget.

    .PARAMETER Name
        Label recorded in the result and in the probe timeline ('listener',
        'listener_owner', 'children').

    .PARAMETER Query
        The query to run. Executed in a fresh runspace, so it cannot use the
        caller's variables; pass everything it needs through ArgumentList.

    .PARAMETER Deadline
        The observation deadline. The wait is min(remaining budget). When the
        deadline has already passed, the query is not started at all.

    .PARAMETER ArgumentList
        Positional arguments for the query's param() block.

    .OUTPUTS
        New-JarvisProbeQueryResult: name, status, value, error, elapsed_ms,
        budget_ms, detail.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Query,
        [Parameter(Mandatory = $true)][datetime]$Deadline,
        [object[]]$ArgumentList = @()
    )

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $remainingMs = ($Deadline - (Get-Date)).TotalMilliseconds
    $budgetMs = if ($remainingMs -ge [int]::MaxValue) { [int]::MaxValue } else { [int][Math]::Floor($remainingMs) }
    if ($budgetMs -le 0) {
        $stopwatch.Stop()
        # Nothing is started: a spent budget means no answer, not a fast one.
        return (New-JarvisProbeQueryResult -Name $Name -Status 'timed_out' -Value $null `
            -ElapsedMs 0 -BudgetMs 0 -Detail 'observation_budget_already_spent')
    }

    $runspace = $null
    $shell = $null
    try {
        $runspace = [runspacefactory]::CreateRunspace()
        $runspace.Open()
        $shell = [powershell]::Create()
        $shell.Runspace = $runspace
        [void]$shell.AddScript($Query.ToString())
        foreach ($argument in $ArgumentList) { [void]$shell.AddArgument($argument) }
        $async = $shell.BeginInvoke()
    } catch {
        $message = $_.Exception.Message
        try { if ($shell) { $shell.Dispose() } } catch { }
        try { if ($runspace) { $runspace.Dispose() } } catch { }
        $stopwatch.Stop()
        return (New-JarvisProbeQueryResult -Name $Name -Status 'failed' -Value $null `
            -ErrorMessage $message -ElapsedMs ([int]$stopwatch.Elapsed.TotalMilliseconds) -BudgetMs $budgetMs `
            -Detail 'runspace_start_failed')
    }

    # Re-read the deadline after runspace setup: creating the runspace must
    # not be spent outside the budget.
    $remainingMs = ($Deadline - (Get-Date)).TotalMilliseconds
    $waitMs = if ($remainingMs -ge [int]::MaxValue) { [int]::MaxValue } else { [int][Math]::Floor($remainingMs) }
    if ($waitMs -le 0) {
        try { [void]$shell.BeginStop($null, $null) } catch { }
        $stopwatch.Stop()
        return (New-JarvisProbeQueryResult -Name $Name -Status 'timed_out' -Value $null `
            -ElapsedMs ([int]$stopwatch.Elapsed.TotalMilliseconds) -BudgetMs 0 `
            -Detail 'observation_budget_spent_during_setup')
    }

    if (-not $async.AsyncWaitHandle.WaitOne($waitMs)) {
        # The pipeline outlived the budget. Ask it to stop, then abandon it:
        # joining or disposing a pipeline stuck in a native OS call would
        # block the probe exactly as the original query did. This is what
        # makes "the observation budget" an actual bound.
        try { [void]$shell.BeginStop($null, $null) } catch { }
        $stopwatch.Stop()
        return (New-JarvisProbeQueryResult -Name $Name -Status 'timed_out' -Value $null `
            -ElapsedMs ([int]$stopwatch.Elapsed.TotalMilliseconds) -BudgetMs $waitMs `
            -Detail 'query_outlived_observation_budget')
    }

    $value = $null
    $failure = ''
    try {
        $output = @($shell.EndInvoke($async))
        $streamErrors = @($shell.Streams.Error | ForEach-Object { [string]$_ })
        if ($streamErrors.Count -gt 0) {
            $failure = ($streamErrors -join '; ')
        } elseif ($output.Count -eq 1) {
            $value = $output[0]
        } elseif ($output.Count -gt 1) {
            $value = $output
        }
    } catch {
        $failure = $_.Exception.Message
    } finally {
        try { if ($shell) { $shell.Dispose() } } catch { }
        try { if ($runspace) { $runspace.Dispose() } } catch { }
    }
    $stopwatch.Stop()

    if (-not [string]::IsNullOrEmpty($failure)) {
        return (New-JarvisProbeQueryResult -Name $Name -Status 'failed' -Value $null `
            -ErrorMessage $failure -ElapsedMs ([int]$stopwatch.Elapsed.TotalMilliseconds) -BudgetMs $budgetMs `
            -Detail 'query_failed')
    }
    return (New-JarvisProbeQueryResult -Name $Name -Status 'result' -Value $value `
        -ElapsedMs ([int]$stopwatch.Elapsed.TotalMilliseconds) -BudgetMs $budgetMs)
}

# ── Server ownership ────────────────────────────────────────────────────────

function Test-JarvisProbeOwnedServer {
    <#
    .SYNOPSIS
        Is this listening process the Bun server the probe's app spawned?

    .DESCRIPTION
        Ownership evidence is the process tree, not the port. The candidate
        must be the very PID the listener reports, its parent must be the
        probe's app process, and its creation time must not predate that
        process's start. The creation-time check is what rejects a REUSED
        PID: a listener whose parent PID happens to equal the probe's PID but
        which existed before the app launched is not a child of this run.

        Fails closed: unknown owner, missing candidate, unreadable creation
        time or unknown probe start all mean "not owned", never "owned by
        default".

    .OUTPUTS
        [pscustomobject]@{ owned = [bool]; pid = [int]; reason = [string] }
        with reason one of owned, no_listener, listener_owner_unknown,
        listener_owner_not_found, listener_owner_changed, foreign_parent,
        probe_start_unknown, listener_start_unknown,
        listener_start_unreadable, listener_predates_probe.
    #>
    [CmdletBinding()]
    param(
        $Listener = $null,
        $Candidate = $null,
        [int]$ProbeProcessId = 0,
        $ProbeStartedAt = $null
    )

    if (-not $Listener) {
        return [pscustomobject]@{ owned = $false; pid = $null; reason = 'no_listener' }
    }

    $ownerProperty = $Listener.PSObject.Properties['OwningProcess']
    $ownerId = 0
    if (-not $ownerProperty -or
        -not [int]::TryParse([string]$ownerProperty.Value, [ref]$ownerId) -or
        $ownerId -le 0) {
        return [pscustomobject]@{ owned = $false; pid = $null; reason = 'listener_owner_unknown' }
    }

    if (-not $Candidate) {
        return [pscustomobject]@{ owned = $false; pid = $ownerId; reason = 'listener_owner_not_found' }
    }

    # The two queries are separate: the PID the process query resolved must
    # still be the PID the listener reported, or the identity is not proven.
    $candidateIdProperty = $Candidate.PSObject.Properties['ProcessId']
    $candidateId = 0
    if (-not $candidateIdProperty -or
        -not [int]::TryParse([string]$candidateIdProperty.Value, [ref]$candidateId) -or
        $candidateId -ne $ownerId) {
        return [pscustomobject]@{ owned = $false; pid = $ownerId; reason = 'listener_owner_changed' }
    }

    $parentProperty = $Candidate.PSObject.Properties['ParentProcessId']
    $parentId = 0
    if (-not $parentProperty -or
        -not [int]::TryParse([string]$parentProperty.Value, [ref]$parentId) -or
        $parentId -ne $ProbeProcessId) {
        return [pscustomobject]@{ owned = $false; pid = $ownerId; reason = 'foreign_parent' }
    }

    if (-not $ProbeStartedAt) {
        return [pscustomobject]@{ owned = $false; pid = $ownerId; reason = 'probe_start_unknown' }
    }
    $createdProperty = $Candidate.PSObject.Properties['CreationDate']
    if (-not $createdProperty -or -not $createdProperty.Value) {
        return [pscustomobject]@{ owned = $false; pid = $ownerId; reason = 'listener_start_unknown' }
    }
    $created = $null
    try { $created = [datetime]$createdProperty.Value } catch {
        return [pscustomobject]@{ owned = $false; pid = $ownerId; reason = 'listener_start_unreadable' }
    }
    if ($created -lt [datetime]$ProbeStartedAt) {
        return [pscustomobject]@{ owned = $false; pid = $ownerId; reason = 'listener_predates_probe' }
    }

    return [pscustomobject]@{ owned = $true; pid = $ownerId; reason = 'owned' }
}

# ── Observation poll ────────────────────────────────────────────────────────

function Get-JarvisColdStartObservation {
    <#
    .SYNOPSIS
        One poll of the cold-start observation loop, with every OS query bounded.

    .DESCRIPTION
        Returns a snapshot instead of writing to the probe's timeline, so the
        loop and the tests read the same evidence:

            exited            - the app process is gone (DIED)
            exit_code         - its exit code when readable
            has_window        - window state from the injected WindowState probe
            main_window       - window title
            responsive        - $true/$false from the window probe, $null if unknown
            server_listening  - ownership-proven Bun server, never inferred from the port
            server_pid        - the owned listener's PID
            listener_status   - result | timed_out | failed | not_queried
            process_status    - same, for the owning-process query
            reason            - why the server was or was not accepted

        When the process has exited the server is not queried at all. When a
        query times out or fails, `server_listening` stays $false and the
        status/reason say why; the poll never substitutes a stale or assumed
        answer.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Process,
        [Parameter(Mandatory = $true)][datetime]$Deadline,
        [int]$Port = 19877,
        $ProbeStartedAt = $null,
        [scriptblock]$WindowState = $null,
        [scriptblock]$ListenerQuery = $null,
        [scriptblock]$ProcessQuery = $null
    )

    if (-not $ListenerQuery) {
        $ListenerQuery = {
            param($LocalPort)
            Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue |
                Select-Object -First 1
        }
    }
    if (-not $ProcessQuery) {
        $ProcessQuery = {
            param($ProcessId)
            Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
        }
    }

    $observation = [ordered]@{
        observed_at      = (Get-Date)
        exited           = $false
        exit_code        = $null
        process_state    = 'running'
        has_window       = $false
        main_window      = ''
        responsive       = $null
        window_status    = 'skipped'
        server_listening = $false
        server_pid       = $null
        listener_status  = 'not_queried'
        process_status   = 'not_queried'
        reason           = ''
    }

    $hasExited = $false
    try {
        $hasExited = [bool]$Process.HasExited
    } catch {
        # A process object we cannot read is not evidence of death.
        $observation.process_state = 'unknown'
    }
    if ($hasExited) {
        $observation.exited = $true
        $observation.process_state = 'exited'
        try { $observation.exit_code = $Process.ExitCode } catch { $observation.exit_code = $null }
        $observation.reason = 'process_exited'
        return [pscustomobject]$observation
    }

    if ($WindowState) {
        try {
            $window = & $WindowState $Process
            $observation.window_status = 'result'
            if ($window) {
                # Works for both a pscustomobject and the ordered dictionary
                # the probe's own window helper returns; a missing property is
                # "unknown", never "seen and responsive".
                $observation.has_window = [bool]$window.has_window
                $observation.main_window = [string]$window.main_window
                $observation.responsive = $window.responsive
            }
        } catch {
            $observation.window_status = 'failed'
        }
    }

    $listenerResult = Invoke-JarvisProbeBoundedQuery -Name 'listener' -Query $ListenerQuery `
        -ArgumentList @($Port) -Deadline $Deadline
    $observation.listener_status = $listenerResult.status
    if ($listenerResult.status -ne 'result') {
        $observation.reason = "listener_query_$($listenerResult.status)"
        return [pscustomobject]$observation
    }

    $listener = $null
    if ($listenerResult.value) { $listener = @($listenerResult.value)[0] }
    if (-not $listener) {
        $observation.reason = 'no_listener'
        return [pscustomobject]$observation
    }

    $ownerProperty = $listener.PSObject.Properties['OwningProcess']
    $ownerId = 0
    if ($ownerProperty) { $null = [int]::TryParse([string]$ownerProperty.Value, [ref]$ownerId) }
    if ($ownerId -le 0) {
        $observation.reason = 'listener_owner_unknown'
        return [pscustomobject]$observation
    }

    $candidateResult = Invoke-JarvisProbeBoundedQuery -Name 'listener_owner' -Query $ProcessQuery `
        -ArgumentList @($ownerId) -Deadline $Deadline
    $observation.process_status = $candidateResult.status
    if ($candidateResult.status -ne 'result') {
        $observation.reason = "process_query_$($candidateResult.status)"
        return [pscustomobject]$observation
    }

    $candidate = $null
    if ($candidateResult.value) { $candidate = @($candidateResult.value)[0] }

    if (-not $ProbeStartedAt) {
        $startProperty = $Process.PSObject.Properties['JarvisOwnedStartTime']
        if ($startProperty) { $ProbeStartedAt = $startProperty.Value }
    }

    $ownership = Test-JarvisProbeOwnedServer -Listener $listener -Candidate $candidate `
        -ProbeProcessId $Process.Id -ProbeStartedAt $ProbeStartedAt
    $observation.server_listening = [bool]$ownership.owned
    $observation.server_pid = $ownership.pid
    $observation.reason = $ownership.reason
    return [pscustomobject]$observation
}

# ── Evidence ────────────────────────────────────────────────────────────────

function Get-JarvisProbeChildProcessEvidence {
    <#
    .SYNOPSIS
        Bounded child-process snapshot for the probe's evidence record.

    .DESCRIPTION
        The post-loop evidence collection used to enumerate every process on
        the machine synchronously. It is bounded the same way the observation
        queries are: when it does not finish inside its own budget the
        evidence says so (status timed_out/failed, empty children) rather than
        holding the probe open.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int]$ProbeProcessId,
        [datetime]$Deadline = (Get-Date).AddSeconds(10),
        [scriptblock]$ProcessSnapshotQuery = $null
    )

    if (-not $ProcessSnapshotQuery) {
        $ProcessSnapshotQuery = {
            param($ProbeId)
            Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object { $_.ParentProcessId -eq $ProbeId } |
                Select-Object ProcessId, Name, CommandLine
        }
    }

    $result = Invoke-JarvisProbeBoundedQuery -Name 'children' -Query $ProcessSnapshotQuery `
        -ArgumentList @($ProbeProcessId) -Deadline $Deadline
    $children = @()
    if ($result.status -eq 'result' -and $result.value) { $children = @($result.value) }
    return [pscustomobject]@{
        status     = $result.status
        error      = $result.error
        elapsed_ms = $result.elapsed_ms
        children   = $children
    }
}
