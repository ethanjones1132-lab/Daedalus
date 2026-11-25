<#
.SYNOPSIS
    Offline tests for the release smoke's chat outcome.

.DESCRIPTION
    The smoke's chat step used to be one boolean: a terminal 'error' frame was
    a pass whenever -AllowChatError was set, and the run's record could not
    tell that pass from a real answer. The step now records one of three
    outcomes -- answer / error_tolerated / failed -- together with the
    terminal error text and a named error class, so a manifest reader can see
    that the published installer never answered a chat.

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
    decision helper.

    The decision helper lives inside scripts/release-smoke.ps1, which has a
    mandatory -ManifestPath and a live entry point, so it is extracted by AST
    -- the same way scripts/probe-cold-start.Tests.ps1 drives the probe's
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

# Extracts the smoke's Resolve-JarvisChatOutcome function by AST and returns
# its body as a runnable scriptblock, so the cases below drive the real
# decision without running the smoke (whose entry point would install,
# launch and listen).
function Get-ReleaseSmokeChatOutcomeFunction {
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
        ($node.Name -eq 'Resolve-JarvisChatOutcome')
    }, $true))
    if ($definitions.Count -ne 1) {
        throw 'Resolve-JarvisChatOutcome not found exactly once in release-smoke.ps1'
    }
    # Body.GetScriptBlock() compiles the same AST as a runnable scriptblock;
    # Body.Extent.Text would carry the function body's own braces.
    return $definitions[0].Body.GetScriptBlock()
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
