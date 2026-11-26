<#
.SYNOPSIS
    Offline tests for the release smoke's chat readiness wait and chat outcome.

.DESCRIPTION
    The smoke's chat step used to be one boolean: a terminal 'error' frame was
    a pass whenever -AllowChatError was set, and the run's record could not
    tell that pass from a real answer. The step now records one of three
    outcomes -- answer / error_tolerated / failed -- together with the
    terminal error text and a named error class, so a manifest reader can see
    that the published installer never answered a chat.

    DD-168 adds a bounded wait between health and chat. /health is liveness
    only: Bun answers requests long before a model can answer a chat. The wait
    polls /health/readiness, records which signal satisfied it, and decides at
    once -- with its own class -- when the app says the engine is configured
    never to come up (disabled / no model configured). Without
    -AllowChatError such an outcome fails the smoke before the chat; with it
    the outcome is recorded as data and the smoke proceeds to the chat, whose
    terminal error stays tolerated exactly as before (DD-EO15).

    DD-167: the terminal 'result' frame is not an answer just because it is a
    result frame. The server publishes the verdict on that frame -- subtype
    'error'/'partial' plus a code -- and its empty-answer fallback even
    finishes a failed turn with the friendly retry notice as the result text.
    A result frame is therefore an answer only when its subtype is 'success';
    the cases below pin that a subtype error/partial result frame is never
    recorded as 'answer'.

    Nothing here installs anything, launches the app, opens a port or reaches
    an inference backend: the cases drive fake SSE frames through the real
    frame parser (Get-JarvisSseOutcome) and then through the smoke's pure
    decision and readiness helpers.

    Those helpers live inside scripts/release-smoke.ps1, which has a
    mandatory -ManifestPath and a live entry point, so they are extracted by
    AST -- the same way scripts/probe-cold-start.Tests.ps1 drives the probe's
    quit pass.

    This file is written for Pester 3.4 (Should Be / Should Match), the
    version scripts/run-release-tests.ps1 pins. It is also its own runner, so
    the gate can run it directly:

        powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-smoke.Tests.ps1

    or, as the rest of the release suite does:

        Invoke-Pester -Script scripts/release-smoke.Tests.ps1 -EnableExit
#>

$pesterVersion = '3.4.0'

# A loaded Pester is the signal that some Invoke-Pester already owns this
# run: either scripts/run-release-tests.ps1, or the runner block directly
# below re-invoking this file to execute its Describes. In both cases the
# tests must not start another run.
$pesterWasLoaded = [bool](Get-Module -Name 'Pester')

if ($pesterWasLoaded) {
    $loadedPester = Get-Module -Name 'Pester' | Select-Object -First 1
    if ([string]$loadedPester.Version -ne $pesterVersion) {
        throw "release-smoke.Tests.ps1 targets Pester $pesterVersion; $($loadedPester.Version) is loaded"
    }
} else {
    if (-not (Get-Module -ListAvailable -Name 'Pester' |
            Where-Object { $_.Version -eq [version]$pesterVersion })) {
        throw "Pester $pesterVersion is required (scripts/run-release-tests.ps1 installs it)"
    }
    Import-Module -Name 'Pester' -RequiredVersion $pesterVersion -Force -ErrorAction Stop

    # Run directly (`powershell -File`), this file is its own runner, so the
    # process exit code reports a failing case. Invoke-Pester re-invokes the
    # file with `&`, where Pester is already loaded and this block is skipped.
    $run = Invoke-Pester -Script $PSCommandPath -PassThru
    if (-not $run -or $run.FailedCount -gt 0) { exit 1 }
    exit 0
}

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

$smokePath = Join-Path $repoRoot 'scripts\release-smoke.ps1'

# Extracts one function definition from the smoke by AST and returns its body
# as a runnable scriptblock, so the cases below drive the real decision
# without running the smoke (whose entry point would install, launch and
# listen).
function Get-ReleaseSmokeFunctionBody {
    param([Parameter(Mandatory = $true)][string]$Name)
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $smokePath, [ref]$tokens, [ref]$parseErrors)
    if (@($parseErrors).Count -gt 0) {
        throw "release-smoke parse errors: $($parseErrors[0].Message)"
    }
    $definitions = @($ast.FindAll({
        param($node)
        ($node -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and
        ($node.Name -eq $Name)
    }, $true))
    if ($definitions.Count -ne 1) {
        throw "$Name not found exactly once in release-smoke.ps1"
    }
    # Body.GetScriptBlock() compiles the same AST as a runnable scriptblock;
    # Body.Extent.Text would carry the function body's own braces.
    return $definitions[0].Body.GetScriptBlock()
}

# Extracts the smoke's Resolve-JarvisChatOutcome function by AST.
function Get-ReleaseSmokeChatOutcomeFunction {
    return Get-ReleaseSmokeFunctionBody -Name 'Resolve-JarvisChatOutcome'
}

# The readiness helpers call each other (the wait calls the resolver, which
# calls the two small helpers), so import the whole set into this script
# scope. Set-Item here (not inside a helper) puts the definitions in the same
# scope as the functions declared above.
foreach ($readinessFunction in @(
        'Get-JarvisReadinessMember'
        'Test-JarvisReadinessTerminalError'
        'Resolve-JarvisChatReadiness'
        'Wait-JarvisChatReady')) {
    Set-Item -Path "function:$readinessFunction" -Value (Get-ReleaseSmokeFunctionBody -Name $readinessFunction)
}

# Builds the decision from frames the way the smoke does: the real SSE
# outcome first, then the real decision.
function New-ReleaseSmokeChatDecision {
    param(
        [object[]]$Events,
        [switch]$AllowChatError
    )
    $outcome = Get-JarvisSseOutcome -Events $Events
    $decision = & (Get-ReleaseSmokeChatOutcomeFunction) -SseOutcome $outcome -AllowChatError:$AllowChatError
    return $decision
}

# One /health/readiness probe result in the envelope the real probe returns.
function New-ReleaseSmokeReadinessProbe {
    param(
        [hashtable]$Conductor,
        [object]$Body,
        [int]$Status = 200,
        [string]$ErrorText = ''
    )
    if ($PSBoundParameters.ContainsKey('Body')) {
        $payload = $Body
    } elseif ($PSBoundParameters.ContainsKey('Conductor')) {
        $payload = [pscustomobject]@{ conductor = [pscustomobject]$Conductor }
    } else {
        $payload = $null
    }
    return [pscustomobject]@{ status = $Status; body = $payload; error = $ErrorText }
}

Describe 'the chat outcome decision' {
    It 'records a terminal result frame as an answer' {
        $decision = New-ReleaseSmokeChatDecision -Events @(
            [pscustomobject]@{ type = 'token'; text = 'smoke' }
            [pscustomobject]@{ type = 'result'; subtype = 'success'; result = 'smoke ok.' }
        )
        $decision.outcome | Should Be 'answer'
        $decision.ok | Should Be $true
        $decision.exit_code | Should Be 0
        ($null -eq $decision.error_class) | Should Be $true
        $decision.subtype | Should Be 'success'
        ($null -eq $decision.code) | Should Be $true
        $decision.text | Should Be 'smoke ok.'
    }

    It 'carries the frame subtype and code out of the parser' {
        # The parser's `ok` says a result frame arrived; it is not a verdict.
        # The decision below is where the verdict is applied.
        $outcome = Get-JarvisSseOutcome -Events @(
            [pscustomobject]@{ type = 'result'; subtype = 'error'; code = 'turn_deadline'; result = 'Unable to connect. Is the computer able to access the url?' }
        )
        $outcome.ok | Should Be $true
        $outcome.type | Should Be 'result'
        $outcome.subtype | Should Be 'error'
        $outcome.code | Should Be 'turn_deadline'
        $outcome.text | Should Be 'Unable to connect. Is the computer able to access the url?'
    }

    It 'never records a subtype error result frame as an answer' {
        # The empty-answer fallback path: a result frame whose own subtype
        # says the turn failed, carrying the friendly retry notice as text.
        $decision = New-ReleaseSmokeChatDecision -Events @(
            [pscustomobject]@{ type = 'result'; subtype = 'error'; code = 'turn_deadline'; result = 'Unable to connect. Is the computer able to access the url?' }
        )
        $decision.outcome | Should Be 'failed'
        $decision.outcome | Should Not Be 'answer'
        $decision.ok | Should Be $false
        $decision.exit_code | Should Be 1
        $decision.error_class | Should Be 'chat_result_subtype_error'
        $decision.subtype | Should Be 'error'
        $decision.code | Should Be 'turn_deadline'
        $decision.reason | Should Match 'terminal_result_subtype_error'
        $decision.text | Should Be 'Unable to connect. Is the computer able to access the url?'
    }

    It 'records a subtype error result frame as tolerated, with its code, when the caller allows it' {
        $decision = New-ReleaseSmokeChatDecision -AllowChatError -Events @(
            [pscustomobject]@{ type = 'result'; subtype = 'error'; code = 'turn_deadline'; result = 'Unable to connect. Is the computer able to access the url?' }
        )
        $decision.outcome | Should Be 'error_tolerated'
        $decision.outcome | Should Not Be 'answer'
        $decision.ok | Should Be $true
        $decision.exit_code | Should Be 0
        $decision.error_class | Should Be 'chat_result_subtype_error'
        $decision.code | Should Be 'turn_deadline'
        $decision.text | Should Be 'Unable to connect. Is the computer able to access the url?'
    }

    It 'never records a subtype partial result frame as an answer' {
        $decision = New-ReleaseSmokeChatDecision -AllowChatError -Events @(
            [pscustomobject]@{ type = 'result'; subtype = 'partial'; code = 'no_progress_repetition'; result = 'The turn stopped making progress.' }
        )
        $decision.outcome | Should Be 'error_tolerated'
        $decision.outcome | Should Not Be 'answer'
        $decision.ok | Should Be $true
        $decision.exit_code | Should Be 0
        $decision.error_class | Should Be 'chat_result_subtype_partial'
        $decision.subtype | Should Be 'partial'
        $decision.code | Should Be 'no_progress_repetition'
        $decision.reason | Should Match 'terminal_result_subtype_partial'
        $decision.text | Should Be 'The turn stopped making progress.'
    }

    It 'fails a subtype partial result frame when the caller does not allow it' {
        $decision = New-ReleaseSmokeChatDecision -Events @(
            [pscustomobject]@{ type = 'result'; subtype = 'partial'; code = 'no_progress_repetition'; result = 'The turn stopped making progress.' }
        )
        $decision.outcome | Should Be 'failed'
        $decision.exit_code | Should Be 1
        $decision.error_class | Should Be 'chat_result_subtype_partial'
    }

    It 'never records a result frame with no success subtype as an answer' {
        # A result frame that declares no subtype at all is not proof of a
        # successful turn; the record says so instead of guessing.
        $decision = New-ReleaseSmokeChatDecision -AllowChatError -Events @(
            [pscustomobject]@{ type = 'result'; result = 'smoke ok.' }
        )
        $decision.outcome | Should Be 'error_tolerated'
        $decision.outcome | Should Not Be 'answer'
        $decision.error_class | Should Be 'chat_result_subtype_unknown'
        $decision.reason | Should Match 'terminal_result_subtype_unknown'
    }

    It 'records a terminal error frame as tolerated, and exits 0, when the caller allows it' {
        $decision = New-ReleaseSmokeChatDecision -AllowChatError -Events @(
            [pscustomobject]@{ type = 'error'; error = 'provider unavailable' }
        )
        $decision.outcome | Should Be 'error_tolerated'
        $decision.ok | Should Be $true
        $decision.exit_code | Should Be 0
        $decision.error_class | Should Be 'chat_terminal_error'
        $decision.type | Should Be 'error'
        $decision.text | Should Be 'provider unavailable'
    }

    It 'keeps the answer distinct from a tolerated error' {
        $answer = New-ReleaseSmokeChatDecision -AllowChatError -Events @(
            [pscustomobject]@{ type = 'result'; subtype = 'success'; result = 'smoke ok.' }
        )
        $tolerated = New-ReleaseSmokeChatDecision -AllowChatError -Events @(
            [pscustomobject]@{ type = 'error'; error = 'provider unavailable' }
        )
        $failedResult = New-ReleaseSmokeChatDecision -AllowChatError -Events @(
            [pscustomobject]@{ type = 'result'; subtype = 'error'; code = 'turn_deadline'; result = 'Unable to connect. Is the computer able to access the url?' }
        )
        $answer.outcome | Should Be 'answer'
        $tolerated.outcome | Should Be 'error_tolerated'
        $failedResult.outcome | Should Be 'error_tolerated'
        $answer.outcome | Should Not Be $tolerated.outcome
        $answer.outcome | Should Not Be $failedResult.outcome
    }

    It 'fails a terminal error frame when the caller does not allow it' {
        $decision = New-ReleaseSmokeChatDecision -Events @(
            [pscustomobject]@{ type = 'error'; error = 'provider unavailable' }
        )
        $decision.outcome | Should Be 'failed'
        $decision.ok | Should Be $false
        $decision.exit_code | Should Be 1
        $decision.error_class | Should Be 'chat_terminal_error'
        $decision.reason | Should Match 'terminal_error'
        $decision.text | Should Be 'provider unavailable'
    }

    It 'fails when no terminal frame arrived' {
        $decision = New-ReleaseSmokeChatDecision -AllowChatError -Events @(
            [pscustomobject]@{ type = 'token'; text = 'smoke' }
        )
        $decision.outcome | Should Be 'failed'
        $decision.ok | Should Be $false
        $decision.exit_code | Should Be 1
        $decision.error_class | Should Be 'chat_no_terminal_event'
        $decision.reason | Should Match 'no_terminal_event'
    }

    It 'fails a cancelled frame even when errors are tolerated' {
        $decision = New-ReleaseSmokeChatDecision -AllowChatError -Events @(
            [pscustomobject]@{ type = 'cancelled' }
        )
        $decision.outcome | Should Be 'failed'
        $decision.ok | Should Be $false
        $decision.exit_code | Should Be 1
        $decision.error_class | Should Be 'chat_terminal_cancelled'
    }
}

Describe 'the chat readiness decision' {
    It 'proceeds when the engine snapshot says ready' {
        $decision = Resolve-JarvisChatReadiness -Probe (New-ReleaseSmokeReadinessProbe -Conductor @{
            enabled = $true
            state   = 'ready'
            model   = 'local-model'
            error   = $null
        })
        $decision.ready | Should Be $true
        $decision.terminal | Should Be $true
        $decision.proceed | Should Be $true
        $decision.ok | Should Be $true
        $decision.exit_code | Should Be 0
        $decision.outcome | Should Be 'ready'
        $decision.signal | Should Be 'readiness_state:ready'
        $decision.state | Should Be 'ready'
        ($null -eq $decision.error_class) | Should Be $true
    }

    It 'keeps waiting on a warming snapshot instead of deciding' {
        $decision = Resolve-JarvisChatReadiness -Probe (New-ReleaseSmokeReadinessProbe -Conductor @{
            enabled = $true
            state   = 'warming'
            model   = 'local-model'
            error   = $null
        })
        $decision.ready | Should Be $false
        $decision.terminal | Should Be $false
        $decision.proceed | Should Be $false
        $decision.outcome | Should Be 'not_ready'
        $decision.signal | Should Be 'readiness_state:warming'
        $decision.state | Should Be 'warming'
    }

    It 'fails a wait that never becomes ready when errors are not tolerated' {
        $decision = Resolve-JarvisChatReadiness -TimedOut -ElapsedMs 240000 -Probe (New-ReleaseSmokeReadinessProbe -Conductor @{
            enabled = $true
            state   = 'warming'
            model   = 'local-model'
            error   = $null
        })
        $decision.ready | Should Be $false
        $decision.terminal | Should Be $true
        $decision.proceed | Should Be $false
        $decision.ok | Should Be $false
        $decision.exit_code | Should Be 1
        $decision.outcome | Should Be 'timeout'
        $decision.error_class | Should Be 'chat_ready_timeout'
        $decision.signal | Should Be 'readiness_state:warming'
        $decision.state | Should Be 'warming'
        $decision.elapsed_ms | Should Be 240000
    }

    It 'records a wait that never becomes ready and proceeds when errors are tolerated' {
        $decision = Resolve-JarvisChatReadiness -TimedOut -ElapsedMs 240000 -AllowChatError -Probe (New-ReleaseSmokeReadinessProbe -Conductor @{
            enabled = $true
            state   = 'warming'
            model   = 'local-model'
            error   = $null
        })
        $decision.proceed | Should Be $true
        $decision.ok | Should Be $true
        $decision.exit_code | Should Be 0
        $decision.outcome | Should Be 'timeout'
        $decision.error_class | Should Be 'chat_ready_timeout'
        $decision.signal | Should Be 'readiness_state:warming'
        $decision.state | Should Be 'warming'
        $decision.elapsed_ms | Should Be 240000
    }

    It 'names a readiness route that never answers as unreachable' {
        $decision = Resolve-JarvisChatReadiness -TimedOut -ElapsedMs 5000 -Probe (New-ReleaseSmokeReadinessProbe -Status 0 -ErrorText 'connection refused')
        $decision.ready | Should Be $false
        $decision.terminal | Should Be $true
        $decision.proceed | Should Be $false
        $decision.ok | Should Be $false
        $decision.outcome | Should Be 'unreachable'
        $decision.error_class | Should Be 'chat_ready_unreachable'
        $decision.state | Should Be 'probe_error'
        $decision.signal | Should Be 'readiness_http:unreachable'
    }

    It 'tolerates an unreachable readiness route when errors are tolerated' {
        $decision = Resolve-JarvisChatReadiness -TimedOut -ElapsedMs 5000 -AllowChatError -Probe (New-ReleaseSmokeReadinessProbe -Status 0 -ErrorText 'connection refused')
        $decision.outcome | Should Be 'unreachable'
        $decision.proceed | Should Be $true
        $decision.ok | Should Be $true
        $decision.exit_code | Should Be 0
    }

    It 'fails at once when the app says no model is configured' {
        $decision = Resolve-JarvisChatReadiness -Probe (New-ReleaseSmokeReadinessProbe -Conductor @{
            enabled = $false
            state   = 'disabled'
            model   = ''
            error   = $null
        })
        $decision.ready | Should Be $false
        $decision.terminal | Should Be $true
        $decision.proceed | Should Be $false
        $decision.ok | Should Be $false
        $decision.exit_code | Should Be 1
        $decision.outcome | Should Be 'not_ready'
        $decision.state | Should Be 'disabled'
        $decision.signal | Should Be 'readiness_state:disabled'
        $decision.error_class | Should Be 'chat_ready_no_model_configured'
    }

    It 'records no model configured and proceeds when errors are tolerated' {
        $decision = Resolve-JarvisChatReadiness -AllowChatError -Probe (New-ReleaseSmokeReadinessProbe -Conductor @{
            enabled = $false
            state   = 'disabled'
            model   = ''
            error   = $null
        })
        $decision.outcome | Should Be 'not_ready'
        $decision.state | Should Be 'disabled'
        $decision.proceed | Should Be $true
        $decision.ok | Should Be $true
        $decision.exit_code | Should Be 0
        $decision.error_class | Should Be 'chat_ready_no_model_configured'
    }

    It 'never treats the liveness /health body as readiness' {
        $decision = Resolve-JarvisChatReadiness -Probe (New-ReleaseSmokeReadinessProbe -Body ([pscustomobject]@{
            ok      = $true
            backend = 'llama_cpp'
            model   = 'local-model'
            git_sha = 'abc1234'
        }))
        $decision.ready | Should Be $false
        $decision.terminal | Should Be $true
        $decision.outcome | Should Be 'not_ready'
        $decision.error_class | Should Be 'chat_ready_signal_unavailable'
        $decision.signal | Should Not Be 'readiness_state:ready'
    }
}

Describe 'the chat readiness wait' {
    It 'waits through warming until ready and records the signal and elapsed time' {
        # Global, not a local: the probe scriptblock runs inside the extracted
        # wait function, which does not share the It block's local scope.
        $global:smokeReadinessStates = [System.Collections.Generic.Queue[string]]::new()
        foreach ($state in @('warming', 'warming', 'ready')) {
            $global:smokeReadinessStates.Enqueue($state)
        }
        $probe = {
            param($Url, $Token)
            New-ReleaseSmokeReadinessProbe -Conductor @{
                enabled = $true
                state   = $global:smokeReadinessStates.Dequeue()
                model   = 'local-model'
                error   = $null
            }
        }
        $result = Wait-JarvisChatReady -Url 'http://127.0.0.1:19877/health/readiness' `
            -Token 'test-token' -Probe $probe -TimeoutSeconds 5 -PollMilliseconds 1
        $result.outcome | Should Be 'ready'
        $result.ready | Should Be $true
        $result.ok | Should Be $true
        $result.exit_code | Should Be 0
        $result.state | Should Be 'ready'
        $result.signal | Should Be 'readiness_state:ready'
        $result.attempts | Should Be 3
        ($result.elapsed_ms -ge 0) | Should Be $true
        ($null -eq $result.error_class) | Should Be $true
    }

    It 'records a timeout as data and proceeds when errors are tolerated' {
        $probe = {
            param($Url, $Token)
            New-ReleaseSmokeReadinessProbe -Conductor @{
                enabled = $true
                state   = 'warming'
                model   = 'local-model'
                error   = $null
            }
        }
        $result = Wait-JarvisChatReady -Url 'http://127.0.0.1:19877/health/readiness' `
            -Token 'test-token' -Probe $probe -TimeoutSeconds 1 -PollMilliseconds 25 -AllowChatError
        # -AllowChatError (DD-EO15) must not Die here: the never-ready engine
        # becomes recorded data and the chat is still sent.
        $result.proceed | Should Be $true
        $result.ok | Should Be $true
        $result.exit_code | Should Be 0
        $result.outcome | Should Be 'timeout'
        $result.error_class | Should Be 'chat_ready_timeout'
        $result.state | Should Be 'warming'
        $result.signal | Should Be 'readiness_state:warming'
        ($result.attempts -ge 2) | Should Be $true
        ($result.elapsed_ms -ge 500) | Should Be $true
        $result.detail | Should Match 'timed out|not ready'
    }

    It 'fails a timeout when errors are not tolerated' {
        $probe = {
            param($Url, $Token)
            New-ReleaseSmokeReadinessProbe -Conductor @{
                enabled = $true
                state   = 'warming'
                model   = 'local-model'
                error   = $null
            }
        }
        $result = Wait-JarvisChatReady -Url 'http://127.0.0.1:19877/health/readiness' `
            -Token 'test-token' -Probe $probe -TimeoutSeconds 1 -PollMilliseconds 25
        $result.proceed | Should Be $false
        $result.ok | Should Be $false
        $result.exit_code | Should Be 1
        $result.outcome | Should Be 'timeout'
        $result.error_class | Should Be 'chat_ready_timeout'
    }

    It 'does not spend the budget when no model is configured' {
        $probe = {
            param($Url, $Token)
            New-ReleaseSmokeReadinessProbe -Conductor @{
                enabled = $false
                state   = 'disabled'
                model   = ''
                error   = $null
            }
        }
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $result = Wait-JarvisChatReady -Url 'http://127.0.0.1:19877/health/readiness' `
            -Token 'test-token' -Probe $probe -TimeoutSeconds 240 -PollMilliseconds 500
        $watch.Stop()
        $result.outcome | Should Be 'not_ready'
        $result.ok | Should Be $false
        $result.proceed | Should Be $false
        $result.error_class | Should Be 'chat_ready_no_model_configured'
        $result.state | Should Be 'disabled'
        # One poll and no sleeping: the whole 240 s budget was not consumed.
        $result.attempts | Should Be 1
        ($result.elapsed_ms -lt 5000) | Should Be $true
        ($watch.Elapsed.TotalSeconds -lt 5) | Should Be $true
    }

    It 'records an unreachable readiness route instead of an answer' {
        $probe = {
            param($Url, $Token)
            New-ReleaseSmokeReadinessProbe -Status 0 -ErrorText 'connection refused'
        }
        $result = Wait-JarvisChatReady -Url 'http://127.0.0.1:19877/health/readiness' `
            -Token 'test-token' -Probe $probe -TimeoutSeconds 1 -PollMilliseconds 25 -AllowChatError
        $result.outcome | Should Be 'unreachable'
        $result.error_class | Should Be 'chat_ready_unreachable'
        $result.proceed | Should Be $true
        $result.ok | Should Be $true
        $result.exit_code | Should Be 0
        ($result.outcome -ne 'answer') | Should Be $true
    }
}

Describe 'the smoke records the chat outcome' {
    It 'writes the outcome, the error class, the error code and the error text into the report' {
        $smoke = Get-Content -Raw -LiteralPath $smokePath
        $smoke | Should Match 'chat_outcome\s+= \$chatOutcome'
        $smoke | Should Match 'chat_error_class\s+= \$chatErrorClass'
        # The server's own cause (turn_deadline, no_progress_repetition, ...)
        # survives into the record beside the class and text.
        $smoke | Should Match 'chat_error_code\s+= \$chatErrorCode'
        $smoke | Should Match 'chat_error\s+= \$chatError'
        # The step entry keeps the terminal text as data, not just prose.
        $smoke | Should Match '-Text \$decision\.text'
    }

    It 'takes the recorded code from the decision, not from the frame type' {
        $smoke = Get-Content -Raw -LiteralPath $smokePath
        $smoke | Should Match '\$chatErrorCode\s+= \$decision\.code'
    }

    It 'drives the chat step through the decision helper' {
        $smoke = Get-Content -Raw -LiteralPath $smokePath
        $smoke | Should Match 'Resolve-JarvisChatOutcome -SseOutcome \$outcome -AllowChatError:\$AllowChatError'
        # A tolerated error must not be printed as a plain terminal result.
        $smoke | Should Not Match 'terminal error tolerated'
    }
}

Describe 'the smoke waits for chat readiness before it chats' {
    It 'places one bounded readiness wait after provenance and before the chat request' {
        $smoke = Get-Content -Raw -LiteralPath $smokePath
        $provenanceIndex = $smoke.IndexOf("Add-Result 'provenance' " + "`$true")
        $readyIndex = $smoke.IndexOf('Wait-JarvisChatReady -Url')
        $chatIndex = $smoke.IndexOf('Sending a chat request')
        ($provenanceIndex -gt 0) | Should Be $true
        ($readyIndex -gt $provenanceIndex) | Should Be $true
        ($chatIndex -gt $readyIndex) | Should Be $true
        # The wait reads the documented snapshot, not /health liveness.
        $smoke | Should Match 'health/readiness'
        $smoke | Should Match 'ChatReadyTimeoutSeconds'
        $smoke | Should Match "Add-Result 'chat-ready'"
    }

    It 'passes the tolerance flag into the readiness wait' {
        $smoke = Get-Content -Raw -LiteralPath $smokePath
        $smoke | Should Match '(?s)Wait-JarvisChatReady -Url \$readinessUrl.*?-AllowChatError:\$AllowChatError'
        # A tolerated not-ready engine must proceed to the chat instead of
        # failing the smoke from the readiness branch.
        $smoke | Should Match 'proceeding because -AllowChatError'
    }

    It 'writes the readiness outcome, signal, state, elapsed time and class into the report' {
        $smoke = Get-Content -Raw -LiteralPath $smokePath
        $smoke | Should Match 'readiness_outcome\s+= \$readinessOutcome'
        $smoke | Should Match 'readiness_signal\s+= \$readinessSignal'
        $smoke | Should Match 'readiness_state\s+= \$readinessState'
        $smoke | Should Match 'readiness_elapsed_ms\s+= \$readinessElapsedMs'
        $smoke | Should Match 'readiness_error_class\s+= \$readinessErrorClass'
    }

    It 'skips the readiness wait with the chat step (-SkipChat)' {
        $smoke = Get-Content -Raw -LiteralPath $smokePath
        $skipGuard = $smoke.IndexOf('if (-not $SkipChat) {')
        $readyIndex = $smoke.IndexOf('Wait-JarvisChatReady -Url')
        $chatIndex = $smoke.IndexOf('Sending a chat request')
        ($skipGuard -gt 0) | Should Be $true
        ($readyIndex -gt $skipGuard) | Should Be $true
        ($chatIndex -gt $readyIndex) | Should Be $true
    }
}
