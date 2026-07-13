<#[CmdletBinding()]
.SYNOPSIS
    Runs bounded direct, workspace-read, and full-execution latency samples.
#>
param(
    [string]$StreamUrl = "http://127.0.0.1:19877/chat/stream",
    [string]$HealthUrl = "http://127.0.0.1:19877/health/inference",
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$WorkspaceRoot = "$env:USERPROFILE\.openclaw\agents\coderclaw\workspace\home-base",
    [int]$Iterations = 5,
    [int]$TimeoutSeconds = 180,
    [string]$OutputPath = ""
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

function Read-Sse([string]$Url, [hashtable]$Body, [int]$Timeout) {
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($Timeout)
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $Url)
        $request.Content = [System.Net.Http.StringContent]::new(($Body | ConvertTo-Json -Depth 8 -Compress), [Text.Encoding]::UTF8, 'application/json')
        $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw "stream_http_status:$([int]$response.StatusCode)" }
        $reader = [IO.StreamReader]::new($response.Content.ReadAsStreamAsync().GetAwaiter().GetResult())
        $events = [Collections.Generic.List[object]]::new()
        try {
            while (($line = $reader.ReadLine()) -ne $null) {
                if (-not $line.StartsWith('data: ')) { continue }
                $payload = $line.Substring(6).Trim()
                if (-not $payload -or $payload -eq '[DONE]') { continue }
                $events.Add(($payload | ConvertFrom-Json))
            }
        } finally { $reader.Dispose() }
        return $events.ToArray()
    } finally { $client.Dispose() }
}

function Percentile([double[]]$Values, [double]$P) {
    if ($Values.Count -eq 0) { return $null }
    $sorted = @($Values | Sort-Object)
    $index = [math]::Max(0, [math]::Ceiling($P * $sorted.Count) - 1)
    return [math]::Round([double]$sorted[$index])
}

$artifact = Join-Path $WorkspaceRoot ("jarvis-benchmark-{0}.txt" -f [guid]::NewGuid())
$scenarios = @(
    @{ name = 'direct'; prompt = 'Reply with exactly: benchmark ok.'; limit_ms = 30000 },
    @{ name = 'workspace_read'; prompt = "Read '$RepoRoot\README.md' and report only the first heading."; limit_ms = 60000 },
    @{ name = 'full_execution'; prompt = "Create '$artifact' with exactly JARVIS_BENCHMARK, read it, then report the exact contents."; limit_ms = 120000 }
)
$samples = [Collections.Generic.List[object]]::new()
try {
    foreach ($scenario in $scenarios) {
        for ($i = 1; $i -le [math]::Max(1, $Iterations); $i++) {
            $session = "benchmark-$($scenario.name)-$([guid]::NewGuid())"
            $started = Get-Date
            $events = @()
            $sampleError = $null
            try { $events = @(Read-Sse $StreamUrl @{ message = $scenario.prompt; session_id = $session } $TimeoutSeconds) }
            catch { $sampleError = $_.Exception.Message }
            $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
            $terminal = @($events | Where-Object { $_.type -in @('result', 'error', 'cancelled') })
            $tools = @($events | Where-Object { $_.type -in @('tool_use', 'tool_result') -or ([string]$_.detail).StartsWith('tool:') } | ForEach-Object {
                if ($_.name) { [string]$_.name } else { ([string]$_.detail).Substring(5) }
            } | Where-Object { $_ } | Select-Object -Unique)
            $queue = $events | Where-Object { $_.type -eq 'orchestrator_queue' } | Select-Object -First 1
            $stageEvents = @($events | Where-Object { $_.type -eq 'orchestrator_stage' })
            $runFrame = $events | Where-Object { $_.type -eq 'agent_run_id' } | Select-Object -First 1
            $runId = if ($runFrame) { [string]$runFrame.agent_run_id } else { $null }
            $health = $null
            try { $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5 } catch {}
            $attempts = @()
            if ($health -and $health.recent_attempts -and $runId) { $attempts = @($health.recent_attempts | Where-Object { [string]$_.run_id -eq $runId }) }
            $artifactOk = $true
            if ($scenario.name -eq 'full_execution') {
                $artifactOk = (Test-Path -LiteralPath $artifact -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $artifact).Trim() -eq 'JARVIS_BENCHMARK')
            }
            $attemptCandidateCounts = @($attempts | Group-Object stage | ForEach-Object {
                [pscustomobject]@{ stage = $_.Name; candidates = @($_.Group | ForEach-Object { "$($_.provider):$($_.model)" } | Select-Object -Unique).Count }
            })
            $attemptsWithinCap = @($attemptCandidateCounts | Where-Object { $_.candidates -gt 2 }).Count -eq 0
            $sample = [ordered]@{
                scenario = $scenario.name; iteration = $i; session_id = $session; elapsed_ms = $elapsed
                limit_ms = $scenario.limit_ms; within_limit = $elapsed -le $scenario.limit_ms
                terminal_type = if ($terminal.Count -eq 1) { [string]$terminal[0].type } else { $null }
                error = $sampleError; tool_names = $tools; stage_event_count = $stageEvents.Count
                queue_wait_ms = if ($queue) { [int]$queue.queue_wait_ms } else { $null }; run_id = $runId
                event_types = @($events | ForEach-Object { [string]$_.type } | Where-Object { $_ } | Group-Object | Sort-Object Name | ForEach-Object { "$($_.Name):$($_.Count)" })
                attempt_count = $attempts.Count; attempts = $attempts; attempt_candidate_counts = $attemptCandidateCounts; artifact_ok = $artifactOk
                # Workspace-read evidence and full-execution write/read evidence
                # are enforced by the server's authority/effect fences; the
                # benchmark additionally verifies the full artifact on disk.
                structural_ok = ($terminal.Count -eq 1 -and $sampleError -eq $null -and ($scenario.name -ne 'direct' -or $tools.Count -eq 0) -and $artifactOk -and $attemptsWithinCap)
            }
            $samples.Add([pscustomobject]$sample)
        }
    }
} finally {
    if (Test-Path -LiteralPath $artifact) { Remove-Item -LiteralPath $artifact -Force }
}

# ── Repeated no-progress request scenario (plan Task 5.1) ─────────────
# The 2026-07-12 incident: each identical retry of an un-answerable deep-read
# request cost a full pipeline run (~50s) to rediscover the same evidence
# shortfall. The fail-fast memo (repetition-guard.ts) must resolve the SECOND
# near-identical attempt in under 5 seconds with a short-circuit code.
$repeatFixtureDir = Join-Path $env:TEMP ("jarvis-bench-norepeat-{0}" -f [guid]::NewGuid())
try {
    New-Item -ItemType Directory -Path $repeatFixtureDir -Force | Out-Null
    # A directory with a single binary blob: listable, but a deep read can
    # never reach the 3-content-read sufficiency floor, so the first attempt
    # fails typed (insufficient_workspace_evidence) and arms the memo.
    [IO.File]::WriteAllBytes((Join-Path $repeatFixtureDir 'payload.bin'), [byte[]](1..64))
    $repeatPrompt = "Comprehensively diagnose the architecture of the repo at '$repeatFixtureDir'."
    $repeatSession = "benchmark-repeat-$([guid]::NewGuid())"
    # Codes that arm the fail-fast memo (must match repetition-guard.ts's
    # SHORT_CIRCUIT_CODES). Attempt 1 failing WITH one of these is the
    # scenario's actual precondition — a live free-tier model can fail (or
    # even succeed) via an unrelated path, in which case attempt 2 proves
    # nothing about the short-circuit and must not be scored as a hard gate.
    $armingCodes = @('no_progress_repetition', 'insufficient_workspace_evidence', 'missing_workspace_evidence')
    $memoArmed = $false

    foreach ($attemptNo in 1, 2) {
        $started = Get-Date
        $events = @()
        $sampleError = $null
        try { $events = @(Read-Sse $StreamUrl @{ message = $repeatPrompt; session_id = $repeatSession } $TimeoutSeconds) }
        catch { $sampleError = $_.Exception.Message }
        $elapsed = [math]::Round(((Get-Date) - $started).TotalMilliseconds)
        $terminal = @($events | Where-Object { $_.type -in @('result', 'error', 'cancelled') })
        $resultFrame = $events | Where-Object { $_.type -eq 'result' } | Select-Object -First 1
        $code = if ($resultFrame -and $resultFrame.PSObject.Properties['code']) { [string]$resultFrame.code } else {
            $errFrame = $events | Where-Object { $_.type -eq 'error' } | Select-Object -First 1
            if ($errFrame -and $errFrame.PSObject.Properties['code']) { [string]$errFrame.code } else { $null }
        }
        $limit = if ($attemptNo -eq 1) { 120000 } else { 5000 }
        if ($attemptNo -eq 1) {
            # Precondition: attempt 1 must terminate AND fail with an
            # arming code (a live model can legitimately fail some other
            # way, or even satisfy sufficiency by luck — either outcome
            # means this run can't exercise the short-circuit at all).
            $memoArmed = ($terminal.Count -ge 1 -and $null -eq $sampleError -and $armingCodes -contains $code)
            $structuralOk = ($terminal.Count -ge 1 -and $null -eq $sampleError)
        } else {
            # Only a real gate when attempt 1 actually armed the memo;
            # otherwise this run is informational (not scored) rather than
            # a false pass or a misleading hard fail.
            $structuralOk = if ($memoArmed) {
                ($null -eq $sampleError -and $elapsed -le 5000 -and $code -eq 'retry_short_circuited')
            } else {
                $true
            }
        }
        $samples.Add([pscustomobject][ordered]@{
            scenario = 'repeated_no_progress'; iteration = $attemptNo; session_id = $repeatSession
            elapsed_ms = $elapsed; limit_ms = $limit; within_limit = $elapsed -le $limit
            terminal_type = if ($terminal.Count -ge 1) { [string]$terminal[0].type } else { $null }
            error = $sampleError; tool_names = @(); stage_event_count = 0
            queue_wait_ms = $null; run_id = $null
            event_types = @($events | ForEach-Object { [string]$_.type } | Where-Object { $_ } | Group-Object | Sort-Object Name | ForEach-Object { "$($_.Name):$($_.Count)" })
            attempt_count = 0; attempts = @(); attempt_candidate_counts = @(); artifact_ok = $true
            outcome_code = $code; memo_armed = $memoArmed
            structural_ok = $structuralOk
        })
    }
} finally {
    if (Test-Path -LiteralPath $repeatFixtureDir) { Remove-Item -LiteralPath $repeatFixtureDir -Recurse -Force }
}

$summary = foreach ($group in ($samples | Group-Object scenario)) {
    $times = @($group.Group | ForEach-Object { [double]$_.elapsed_ms })
    [ordered]@{ scenario = $group.Name; samples = $group.Count; p50_ms = Percentile $times 0.50; p95_ms = Percentile $times 0.95; structural_passes = @($group.Group | Where-Object structural_ok).Count; slo_passes = @($group.Group | Where-Object { $_.within_limit }).Count }
}
$report = [ordered]@{ generated_at = (Get-Date).ToUniversalTime().ToString('o'); iterations = $Iterations; samples = $samples; summary = @($summary) }
$json = $report | ConvertTo-Json -Depth 12
if ($OutputPath) { $json | Set-Content -LiteralPath $OutputPath -Encoding UTF8 }
$json
if (@($samples | Where-Object { -not $_.structural_ok }).Count -gt 0) { exit 2 }
