<#
.SYNOPSIS
    Runs a machine-readable smoke against the deployed Jarvis runtime.

.DESCRIPTION
    Verifies that the Desktop manifest, /health response, and process serving
    port 19877 agree before sending one direct /chat/stream request. The
    script emits one JSON object on stdout and fails closed on provenance or
    terminal-outcome mismatches.

    -CompletionIntegritySmoke creates a temporary multi-item workspace, drives
    Group A execution across up to four session turns, and requires all four
    artifacts plus post-smoke replay cleanliness for that session.
#>
[CmdletBinding()]
param(
    [string]$DeployDir = "$env:USERPROFILE\OneDrive\Desktop",
    [string]$WorkspaceRoot = "$env:USERPROFILE\.openclaw\agents\coderclaw\workspace\home-base",
    [string]$HealthUrl = "http://127.0.0.1:19877/health",
    [string]$StreamUrl = "http://127.0.0.1:19877/chat/stream",
    [string]$Prompt = "Reply with exactly: smoke ok.",
    [string]$SessionId = ([guid]::NewGuid().ToString()),
    [int]$TimeoutSeconds = 120,
    [switch]$WriteReadSmoke,
    # F10: deep-read/full_execution path that the single-file write smoke is blind to.
    [switch]$DeepReadSmoke,
    [string]$DeepReadFixture = $WorkspaceRoot,
    # Multi-item completion integrity: four deterministic file tasks + continue.
    [switch]$CompletionIntegritySmoke
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

function Get-JsonFile([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { throw "missing_file:$Path" }
    return (Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json)
}

function Get-ServingProcess([int]$Port) {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $connection) { throw "no_listener:$Port" }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
    if (-not $process) { throw "missing_process:$($connection.OwningProcess)" }
    return [ordered]@{
        pid = [int]$process.ProcessId
        name = [string]$process.Name
        command_line = [string]$process.CommandLine
    }
}

function Read-SseStream([string]$Url, [hashtable]$Body, [int]$Timeout) {
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($Timeout)
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Post,
            $Url
        )
        $json = $Body | ConvertTo-Json -Depth 8 -Compress
        $request.Content = [System.Net.Http.StringContent]::new(
            $json,
            [System.Text.Encoding]::UTF8,
            'application/json'
        )
        $response = $client.SendAsync(
            $request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "stream_http_status:$([int]$response.StatusCode)"
        }

        $reader = [System.IO.StreamReader]::new(
            $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        )
        $events = [System.Collections.Generic.List[object]]::new()
        try {
            while (($line = $reader.ReadLine()) -ne $null) {
                if (-not $line.StartsWith('data: ')) { continue }
                $payload = $line.Substring(6).Trim()
                if (-not $payload -or $payload -eq '[DONE]') { continue }
                try { $events.Add(($payload | ConvertFrom-Json)) }
                catch { throw "malformed_sse_json:$payload" }
            }
        } finally {
            $reader.Dispose()
        }
        return $events.ToArray()
    } finally {
        $client.Dispose()
    }
}

function Get-ArtifactPresence([hashtable]$Expected) {
    $present = [System.Collections.Generic.List[string]]::new()
    foreach ($name in $Expected.Keys) {
        $path = $Expected[$name]
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $content = (Get-Content -Raw -LiteralPath $path).Trim()
            if ($content -eq $name) { $present.Add($name) }
        }
    }
    return $present.ToArray()
}

$manifestPath = Join-Path $DeployDir '.jarvis-deploy-manifest.json'
$manifest = Get-JsonFile $manifestPath
$health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
$inferenceHealth = Invoke-RestMethod -Uri ($HealthUrl -replace '/health$', '/health/inference') -TimeoutSec 5
if ($null -eq $inferenceHealth.recent_attempts -or $null -eq $inferenceHealth.runtime) {
    throw 'inference_health_contract_missing_recent_attempts_or_runtime'
}
$listener = Get-ServingProcess 19877

$expectedIndex = [IO.Path]::GetFullPath((Join-Path $DeployDir 'index.js'))
$commandLine = $listener.command_line
if ([string]::IsNullOrWhiteSpace($commandLine) -or
    $commandLine.IndexOf($expectedIndex, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "listener_provenance_mismatch:expected=$expectedIndex actual=$commandLine"
}
if ([string]$manifest.git_sha -ne [string]$health.git_sha) {
    throw "health_manifest_sha_mismatch:manifest=$($manifest.git_sha) health=$($health.git_sha)"
}

# Release fixtures that do not require an inference provider. These guard the
# authority and observability contracts even when a live model key is expired.
$authorityCheck = [ordered]@{ status = 'unknown'; code = $null }
try {
    Invoke-WebRequest -Uri ($StreamUrl -replace '/chat/stream$', '/sessions') -Method Post `
        -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -UseBasicParsing | Out-Null
    $authorityCheck.status = 'unexpected_success'
} catch {
    $authorityCheck.code = [int]$_.Exception.Response.StatusCode
    $authorityCheck.status = if ($authorityCheck.code -eq 410) { 'pass' } else { 'fail' }
}
if ($authorityCheck.status -ne 'pass') { throw "session_authority_fixture_failed:$($authorityCheck.code)" }

$conductorHealth = Invoke-RestMethod -Uri ($HealthUrl -replace '/health$', '/health/conductor-directives') -TimeoutSec 5
$conductorCheck = [ordered]@{
    status = if ($null -ne $conductorHealth.records -and $null -ne $conductorHealth.by_type) { 'pass' } else { 'fail' }
    window_size = $conductorHealth.window_size
}
if ($conductorCheck.status -ne 'pass') { throw 'conductor_health_fixture_failed' }

$writeReadCheck = [ordered]@{ status = 'not_requested'; artifact = $null; content = $null }
$writeReadArtifact = $null
$deepReadCheck = [ordered]@{ status = 'not_requested'; fatal_code = $null }
$completionIntegrityCheck = [ordered]@{
    status = 'not_requested'
    smoke_dir = $null
    turns = @()
    artifacts_present = @()
    final_subtype = $null
    intermediate_success = $false
    replay_violations = @()
}

$exclusive = @($WriteReadSmoke, $DeepReadSmoke, $CompletionIntegritySmoke) | Where-Object { $_ }
if ($exclusive.Count -gt 1) {
    throw 'mutually_exclusive:WriteReadSmoke_DeepReadSmoke_CompletionIntegritySmoke'
}

if ($WriteReadSmoke) {
    $writeReadArtifact = Join-Path $WorkspaceRoot ("jarvis-orchestration-smoke-{0}.txt" -f [guid]::NewGuid())
    $Prompt = "Create the file '$writeReadArtifact' with exactly the text JARVIS_SMOKE, then read it and report the exact contents."
}
if ($DeepReadSmoke) {
    $TimeoutSeconds = [Math]::Max($TimeoutSeconds, 240)
    $Prompt = "Identify all remaining gaps in '$DeepReadFixture' -- architecture audit. Force deep read."
}

# ── Multi-item completion integrity path ───────────────────────────────────
if ($CompletionIntegritySmoke) {
    $TimeoutSeconds = [Math]::Max($TimeoutSeconds, 600)
    $tempRoot = [IO.Path]::GetFullPath($env:TEMP)
    $smokeDir = [IO.Path]::GetFullPath((Join-Path $tempRoot ("jarvis-completion-integrity-smoke-" + [guid]::NewGuid().ToString())))
    if (-not $smokeDir.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "completion_integrity_smoke_dir_outside_temp:$smokeDir"
    }
    $completionIntegrityCheck.smoke_dir = $smokeDir

    try {
        New-Item -ItemType Directory -Path $smokeDir -Force | Out-Null
        $planPath = Join-Path $smokeDir 'GROUP_A_EXECUTION.md'
        # Use .py artifacts so py_compile can supply an authoritative
        # check_tier (Task 1 forbids write success with tier=none). Bare
        # identifiers are valid Python syntax and keep exact-content pins.
        $alphaPath = Join-Path $smokeDir 'alpha.py'
        $betaPath = Join-Path $smokeDir 'beta.py'
        $gammaPath = Join-Path $smokeDir 'gamma.py'
        $deltaPath = Join-Path $smokeDir 'delta.py'
        $expected = [ordered]@{
            ALPHA_OK = $alphaPath
            BETA_OK = $betaPath
            GAMMA_OK = $gammaPath
            DELTA_OK = $deltaPath
        }

        @"
# Execution Plan
## Group A
### A1 — Create alpha artifact
- [ ] Write file alpha.py with exactly the text ALPHA_OK
### A2 — Create beta artifact
- [ ] Write file beta.py with exactly the text BETA_OK
### A3 — Create gamma artifact
- [ ] Write file gamma.py with exactly the text GAMMA_OK
### A4 — Create delta artifact
- [ ] Write file delta.py with exactly the text DELTA_OK
## Group B
### B1 — Later work
"@ | Set-Content -LiteralPath $planPath -Encoding utf8

        $maxTurns = 4
        $turnRecords = [System.Collections.Generic.List[object]]::new()
        $allEvents = [System.Collections.Generic.List[object]]::new()
        $started = Get-Date
        $finalTerminal = $null
        $intermediateSuccess = $false

        for ($turn = 1; $turn -le $maxTurns; $turn++) {
            $message = if ($turn -eq 1) {
                "Execute Group A from GROUP_A_EXECUTION.md in workspace '$smokeDir'. " +
                "Create each of the four required files (alpha.py, beta.py, gamma.py, delta.py) " +
                "with the exact contents specified in the plan. Do not mark the group complete until all four exist."
            } else {
                "continue"
            }

            $events = Read-SseStream $StreamUrl @{
                message = $message
                session_id = $SessionId
                workspace = $smokeDir
            } $TimeoutSeconds
            foreach ($ev in $events) { $allEvents.Add($ev) }

            $terminal = @($events | Where-Object { $_.type -in @('result', 'error', 'cancelled') })
            if ($terminal.Count -ne 1) {
                throw "completion_integrity_terminal_count:turn=$turn count=$($terminal.Count)"
            }
            $terminalEvent = $terminal[0]
            $finalTerminal = $terminalEvent
            $subtype = [string]$terminalEvent.subtype
            if ([string]::IsNullOrWhiteSpace($subtype)) { $subtype = 'success' }

            $present = Get-ArtifactPresence $expected
            $turnRecords.Add([ordered]@{
                turn = $turn
                terminal_type = [string]$terminalEvent.type
                subtype = $subtype
                code = [string]$terminalEvent.code
                artifacts_present = $present
                result_text = if ($null -ne $terminalEvent.result) { [string]$terminalEvent.result } else { [string]$terminalEvent.error }
            })

            if ($terminalEvent.type -eq 'error' -or $terminalEvent.type -eq 'cancelled') {
                throw "completion_integrity_terminal_$($terminalEvent.type):turn=$turn"
            }

            # Terminal success is only legal once all four artifacts exist.
            if ($subtype -eq 'success' -and $present.Count -lt 4) {
                $intermediateSuccess = $true
                throw "completion_integrity_false_success:turn=$turn artifacts=$($present.Count)"
            }

            # Intermediate turns (before the fourth artifact) must not claim success.
            if ($present.Count -lt 4 -and $subtype -eq 'success') {
                $intermediateSuccess = $true
                throw "completion_integrity_intermediate_success:turn=$turn"
            }

            if ($present.Count -ge 4) {
                if ($subtype -ne 'success') {
                    # All artifacts landed but the run still paused — allow one
                    # more continue only if we have turns left; otherwise fail.
                    if ($turn -eq $maxTurns) {
                        throw "completion_integrity_artifacts_without_success:subtype=$subtype"
                    }
                    continue
                }
                break
            }

            if ($turn -eq $maxTurns) {
                throw "completion_integrity_incomplete_after_max_turns:artifacts=$($present.Count)"
            }
        }

        $elapsed = ((Get-Date) - $started).TotalMilliseconds
        $finalPresent = Get-ArtifactPresence $expected
        if ($finalPresent.Count -ne 4) {
            throw "completion_integrity_missing_artifacts:$($finalPresent -join ',')"
        }
        foreach ($name in $expected.Keys) {
            $content = (Get-Content -Raw -LiteralPath $expected[$name]).Trim()
            if ($content -ne $name) {
                throw "completion_integrity_content_mismatch:$($expected[$name]) got=$content"
            }
        }
        if ([string]$finalTerminal.subtype -ne 'success' -and -not [string]::IsNullOrWhiteSpace([string]$finalTerminal.subtype)) {
            # Allow default/empty subtype as success-compatible only when all four exist.
            if ([string]$finalTerminal.subtype -notin @('success', '')) {
                throw "completion_integrity_final_not_success:subtype=$($finalTerminal.subtype)"
            }
        }

        # Provenance must still match after the multi-turn work.
        $healthAfter = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
        if ([string]$manifest.git_sha -ne [string]$healthAfter.git_sha) {
            throw "health_manifest_sha_mismatch_post_smoke:manifest=$($manifest.git_sha) health=$($healthAfter.git_sha)"
        }

        # Post-smoke replay: no completion / delegate / write-pressure invariants
        # for agent runs belonging to this smoke session. Script is written under
        # server-jarvis so relative imports to src/eval resolve, then deleted.
        $repoRoot = Split-Path -Parent $PSScriptRoot
        $serverJarvis = Join-Path $repoRoot 'server-jarvis'
        $replayTmp = Join-Path $serverJarvis ("_tmp_completion_smoke_replay_{0}.ts" -f [guid]::NewGuid().ToString('N'))
        $replayScript = @'
import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { checkReplayInvariants } from "./src/eval/conductor-replay";

const sessionId = process.argv[2];
const dbPath = process.env.JARVIS_SELF_TUNING_DB
  ?? join(homedir(), ".openclaw", "jarvis", "self-tuning.db");
const db = new Database(dbPath, { readonly: true });
const rows = db.query(
  "SELECT id, task_type, outcome, final_output, verified_via, check_tier FROM agent_runs WHERE session_id = ? ORDER BY created_at",
).all(sessionId);
const stageStmt = db.query("SELECT * FROM stage_runs WHERE agent_run_id = ? ORDER BY created_at");
const directiveStmt = db.query("SELECT * FROM conductor_directives WHERE agent_run_id = ? ORDER BY created_at");
const watched = new Set([
  "success_without_runtime_check",
  "success_declares_incomplete",
  "delegate_never_wrote",
  "delegate_failed_before_fallback",
  "repeated_nudge",
]);
const violations = [];
for (const row of rows) {
  const run = {
    agentRunId: row.id,
    taskType: row.task_type,
    outcome: row.outcome,
    finalOutput: row.final_output,
    verifiedVia: row.verified_via,
    checkTier: row.check_tier,
    stageRuns: stageStmt.all(row.id),
    directives: directiveStmt.all(row.id),
  };
  for (const v of checkReplayInvariants(run)) {
    if (watched.has(v.rule)) violations.push(v);
  }
}
console.log(JSON.stringify({ session_id: sessionId, runs: rows.length, violations }));
process.exit(violations.length > 0 ? 1 : 0);
'@
        try {
            Set-Content -LiteralPath $replayTmp -Value $replayScript -Encoding utf8
            $replayOut = & bun $replayTmp $SessionId 2>&1
            if ($LASTEXITCODE -ne 0) {
                throw "completion_integrity_replay_failed:$replayOut"
            }
            $replayJson = $replayOut | Out-String | ConvertFrom-Json
            if (@($replayJson.violations).Count -gt 0) {
                throw "completion_integrity_replay_violations:$($replayJson.violations | ConvertTo-Json -Compress)"
            }
        } finally {
            if (Test-Path -LiteralPath $replayTmp) {
                Remove-Item -LiteralPath $replayTmp -Force -ErrorAction SilentlyContinue
            }
        }

        $completionIntegrityCheck.status = 'pass'
        $completionIntegrityCheck.turns = $turnRecords.ToArray()
        $completionIntegrityCheck.artifacts_present = $finalPresent
        $completionIntegrityCheck.final_subtype = [string]$finalTerminal.subtype
        $completionIntegrityCheck.intermediate_success = $intermediateSuccess
        $completionIntegrityCheck.replay_violations = @($replayJson.violations)

        $toolNames = @($allEvents |
            Where-Object { $_.type -in @('tool_use', 'tool_result') -or ([string]$_.detail).StartsWith('tool:') } |
            ForEach-Object {
                if ($_.name) { [string]$_.name }
                elseif (([string]$_.detail).StartsWith('tool:')) { ([string]$_.detail).Substring(5) }
            } |
            Select-Object -Unique)
        $fallbackNotices = @($allEvents | Where-Object { $_.type -eq 'fallback_notice' } |
            ForEach-Object {
                [ordered]@{
                    stage = [string]$_.stage
                    reason = [string]$_.reason
                    model = [string]$_.model
                    source = [string]$_.source
                }
            })

        $record = [ordered]@{
            manifest_sha = [string]$manifest.git_sha
            health_sha = [string]$healthAfter.git_sha
            listener_pid = $listener.pid
            listener_command = $listener.command_line
            session_id = $SessionId
            elapsed_ms = [math]::Round($elapsed)
            terminal_type = [string]$finalTerminal.type
            result_text = if ($null -ne $finalTerminal.result) { [string]$finalTerminal.result } else { [string]$finalTerminal.error }
            event_count = $allEvents.Count
            tool_names = $toolNames
            fallback_notices = $fallbackNotices
            inference_attempts = @($inferenceHealth.recent_attempts | Select-Object -Last 10)
            runtime = $inferenceHealth.runtime
            release_fixtures = [ordered]@{
                session_authority = $authorityCheck
                conductor_health = $conductorCheck
                write_read = $writeReadCheck
                deep_read = $deepReadCheck
                completion_integrity = $completionIntegrityCheck
            }
        }
        $record | ConvertTo-Json -Depth 8 -Compress
    } finally {
        # Remove only the exact smoke directory under %TEMP%, after path validation.
        $resolved = $null
        try { $resolved = [IO.Path]::GetFullPath($smokeDir) } catch { $resolved = $null }
        if ($resolved -and
            $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
            $resolved -ne $tempRoot -and
            (Test-Path -LiteralPath $resolved)) {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    return
}

# ── Single-turn path (default / write-read / deep-read) ────────────────────
$started = Get-Date
$events = Read-SseStream $StreamUrl @{ message = $Prompt; session_id = $SessionId } $TimeoutSeconds
$elapsed = ((Get-Date) - $started).TotalMilliseconds

$terminal = @($events | Where-Object {
    $_.type -in @('result', 'error', 'cancelled')
})
if ($terminal.Count -ne 1) {
    throw "terminal_outcome_count:$($terminal.Count)"
}

$terminalEvent = $terminal[0]
if ($WriteReadSmoke) {
    try {
        if (-not (Test-Path -LiteralPath $writeReadArtifact -PathType Leaf)) {
            throw 'write_read_artifact_missing'
        }
        $writeReadContent = (Get-Content -Raw -LiteralPath $writeReadArtifact).Trim()
        if ($writeReadContent -ne 'JARVIS_SMOKE') {
            throw "write_read_content_mismatch:$writeReadContent"
        }
        $writeReadCheck.status = 'pass'
        $writeReadCheck.artifact = $writeReadArtifact
        $writeReadCheck.content = $writeReadContent
    } finally {
        if (Test-Path -LiteralPath $writeReadArtifact) {
            Remove-Item -LiteralPath $writeReadArtifact -Force
        }
    }
}
if ($DeepReadSmoke) {
    $text = if ($null -ne $terminalEvent.result) { [string]$terminalEvent.result } else { [string]$terminalEvent.error }
    $code = [string]$terminalEvent.code
    $deepReadCheck.fatal_code = $code
    if ($terminalEvent.type -eq 'error') {
        throw "deep_read_smoke_terminal_error:$code"
    }
    if ($code -in @('insufficient_workspace_evidence', 'missing_workspace_evidence')) {
        throw "deep_read_smoke_fatal_code:$code"
    }
    if ($text -match 'could not gather enough evidence|insufficient_workspace_evidence') {
        throw 'deep_read_smoke_refusal_text'
    }
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw 'deep_read_smoke_empty_answer'
    }
    $deepReadCheck.status = 'pass'
}
$toolNames = @($events |
    Where-Object { $_.type -in @('tool_use', 'tool_result') -or ([string]$_.detail).StartsWith('tool:') } |
    ForEach-Object {
        if ($_.name) { [string]$_.name }
        elseif (([string]$_.detail).StartsWith('tool:')) { ([string]$_.detail).Substring(5) }
    } |
    Select-Object -Unique)
$fallbackNotices = @($events | Where-Object { $_.type -eq 'fallback_notice' } |
    ForEach-Object {
        [ordered]@{
            stage = [string]$_.stage
            reason = [string]$_.reason
            model = [string]$_.model
            source = [string]$_.source
        }
    })
$record = [ordered]@{
    manifest_sha = [string]$manifest.git_sha
    health_sha = [string]$health.git_sha
    listener_pid = $listener.pid
    listener_command = $listener.command_line
    session_id = $SessionId
    elapsed_ms = [math]::Round($elapsed)
    terminal_type = [string]$terminalEvent.type
    result_text = if ($null -ne $terminalEvent.result) { [string]$terminalEvent.result } else { [string]$terminalEvent.error }
    event_count = $events.Count
    tool_names = $toolNames
    fallback_notices = $fallbackNotices
    inference_attempts = @($inferenceHealth.recent_attempts | Select-Object -Last 10)
    runtime = $inferenceHealth.runtime
    release_fixtures = [ordered]@{
        session_authority = $authorityCheck
        conductor_health = $conductorCheck
        write_read = $writeReadCheck
        deep_read = $deepReadCheck
        completion_integrity = $completionIntegrityCheck
    }
}
$record | ConvertTo-Json -Depth 8 -Compress
