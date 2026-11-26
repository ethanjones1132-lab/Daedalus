<#
.SYNOPSIS
    Smoke a built Jarvis release end to end: hash, install, launch, health, chat.

.DESCRIPTION
    The release gap report names the missing piece precisely: "establish a
    reproducible build -> package -> install/copy -> hash -> launch -> health
    -> chat/tool smoke pipeline", and "the optimized release was tested
    locally but not yet copied to the user's actual Desktop/installer target
    and verified there". Until now the installer hash check had never been
    run against a real installer, because there was no pipeline to run it.

    This is that pipeline, minus the build and package steps (which
    release-build.ps1 owns and whose output this script consumes):

      1. hash    - the installer's SHA-256 must equal the release record.
                   A tampered installer fails here, before anything is run.
      2. install - the NSIS installer runs silently into a scratch directory
                   and the installed binary's hash must equal the release
                   record's app_binary hash, proving the installer carries
                   the binary the record describes.
      3. launch  - the installed app (the Jarvis.exe the installer laid down,
                   matched by the hash the record records) is started the way
                   a user starts it: by double-clicking. The app starts its
                   own server with the bundled bun.exe beside the exe on the
                   one port the build actually binds, SERVER_PORT 19877 from
                   server-jarvis/src/server-guards.ts. DD-064 removed the port
                   override, so the smoke cannot move the server to a private
                   port; instead it refuses to start while 19877 is busy, so
                   the health, provenance and chat it reads can only come from
                   the process tree it started. A Bun on PATH is never a
                   launch candidate: a green smoke means the installed app
                   booted its own server, not that a developer's runtime did.
      4. health  - /health must report the git SHA and source-tree digest
                   the release record claims. THIS is the stale-binary
                   check: it is the difference between "the file on disk is
                   the build we made" and "the build answering requests is
                   the build we made". /health is liveness only: Bun answers
                   as soon as it serves requests, not when a model can answer.
      5. readiness - /health/readiness must report that the engine which will
                   answer the chat is ready before a chat is attempted
                   (DD-168). The wait is bounded by -ChatReadyTimeoutSeconds
                   and records the signal it waited on, the last state
                   observed and the elapsed time. A signal that says the
                   engine is configured never to come up (disabled, no model
                   configured) fails at once instead of spending the budget.
                   Without -AllowChatError a not-ready engine fails the smoke
                   before the chat; with it the not-ready outcome is recorded
                   as data and the chat's terminal error stays tolerated
                   exactly as before (DD-EO15).
      6. chat    - one /chat/stream request must reach a terminal frame,
                   answered by the same installed app. The chat step records
                   its outcome as data (answer / error_tolerated / failed):
                   -AllowChatError turns a terminal error frame, or a terminal
                   result frame whose own subtype says the turn failed, into
                   a passing but visibly tolerated outcome, never into an
                   answer.

    The decision functions are pure and separately testable, so the
    interesting rules (hash mismatch, stale build, missing terminal frame,
    engine never ready) are covered by scripts/release-smoke.Tests.ps1 and
    scripts/release-pipeline.Tests.ps1 without needing an installer, a
    certificate or an inference backend.

    Every child this script waits on is bounded (DD-126): the install and the
    uninstall through Wait-JarvisChildExit (WaitForExit(ms)), the app's
    bootstrap pipe through a connect deadline, the owned-process teardown
    through CleanupDeadline, and the health, readiness and chat reads through
    their own deadlines. A step that runs out of budget prints one line naming
    the step and the last line the child wrote, then fails. It never blocks.

.PARAMETER ManifestPath
    The jarvis-release.json written by release-build.ps1.

.PARAMETER InstallerPath
    The installer to test. Defaults to the installer named in the record.

.PARAMETER InstallRoot
    Scratch directory the installer is run into.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\release-smoke.ps1 `
        -ManifestPath dist\release\1.0.0\jarvis-release.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath,

    [string]$InstallerPath = '',

    [string]$InstallRoot = (Join-Path $env:TEMP ('jarvis-release-smoke-' + [guid]::NewGuid().ToString('N'))),

    [switch]$SkipInstall,
    [switch]$SkipLaunch,
    [switch]$SkipChat,

    # Tolerate a terminal 'error' frame, or a terminal 'result' frame whose own
    # subtype is 'error'/'partial': the run still exits 0, but the outcome is
    # recorded as 'error_tolerated' with the error class, code and text, never
    # as 'answer'. For a release build the packaging is what is under test;
    # inference credentials are a separate concern with a separate owner.
    [switch]$AllowChatError,

    # DD-168: the budget for the engine readiness wait between health and
    # chat. Large enough for a first model load on a cold install. The wait
    # does not spend this budget when the readiness snapshot says the engine
    # is disabled or configured with no model to load; that is decided at
    # once. With -AllowChatError a not-ready engine is recorded as data and
    # the smoke still sends the chat (DD-EO15) rather than failing here.
    [int]$ChatReadyTimeoutSeconds = 240,

    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

# DD-064: the packaged server binds the fixed SERVER_PORT declared in
# server-jarvis/src/server-guards.ts (19877) and no longer honours a port
# override, so the smoke cannot choose its own port. It therefore refuses to
# run while 19877 is busy: only then can /health, the provenance fields and the
# chat stream be attributed to the process this script started.
$ServerPort = 19877

. (Join-Path $PSScriptRoot 'lib\release-common.ps1')
. (Join-Path $PSScriptRoot 'lib\local-api.ps1')

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Die($msg)        { Write-Host "`n[FAILED] $msg" -ForegroundColor Red; exit 1 }

# ── Runtime helpers ──────────────────────────────────────────────────────────

function Read-JarvisSseStream {
    [CmdletBinding()]
    param(
        [string]$Url,
        [hashtable]$Body,
        [int]$Timeout,
        [string]$Token
    )
    $client = New-JarvisLocalHttpClient
    $client.Timeout = [TimeSpan]::FromSeconds($Timeout)
    $deadline = [datetime]::UtcNow.AddSeconds($Timeout)
    $response = $null
    $request = $null
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Post, $Url)
        $request.Headers.Add('Authorization', (Get-JarvisLocalHeaders $Url $Token).Authorization)
        $json = $Body | ConvertTo-Json -Depth 8 -Compress
        $request.Content = [System.Net.Http.StringContent]::new(
            $json, [System.Text.Encoding]::UTF8, 'application/json')
        $response = $client.SendAsync(
            $request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "stream_http_status:$([int]$response.StatusCode)"
        }
        $reader = [System.IO.StreamReader]::new(
            $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult())
        $events = [System.Collections.Generic.List[object]]::new()
        try {
            while (($line = Read-JarvisLineWithDeadline -Reader $reader -Deadline $deadline) -ne $null) {
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
        if ($response) { $response.Dispose() }
        if ($request) { $request.Dispose() }
        $client.Dispose()
    }
}

function Wait-JarvisHealth {
    <#
    .SYNOPSIS
        Poll /health until it answers or the budget runs out.

    .DESCRIPTION
        On the fixed port the only listener may be the process this smoke
        started, so an owned process that exits without answering is reported
        instead of being polled until the timeout.
    #>
    [CmdletBinding()]
    param(
        [string]$Url,
        [int]$TimeoutSeconds,
        $Process,
        [string]$Token
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = 'no attempt'
    while ((Get-Date) -lt $deadline) {
        if ($Process -and $Process.HasExited) {
            throw "server_exited_before_health:$($Process.ExitCode)"
        }
        try {
            return Invoke-RestMethod -Uri $Url -Headers (Get-JarvisLocalHeaders $Url $Token) -MaximumRedirection 0 -TimeoutSec 5
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
        }
    }
    throw "health_timeout:$Url ($lastError)"
}

function Get-JarvisReadinessProbe {
    <#
    .SYNOPSIS
        One bounded read of /health/readiness, returned as an envelope.

    .DESCRIPTION
        /health is liveness: Bun answers requests. /health/readiness is the
        engine snapshot the app publishes about the model that will answer a
        chat (enabled/state pending|warming|ready|degraded|disabled, model,
        error). The envelope keeps the HTTP status separate from the body so
        the decision layer can tell a route this build does not expose (404)
        from a server that has not answered yet (status 0) or a 5xx while it
        boots.

        The client comes from lib/local-api.ps1 (New-JarvisLocalHttpClient and
        Get-JarvisLocalHeaders); this function adds no second HTTP path.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [string]$Token
    )
    # Resolved before the try: a missing/invalid credential is a caller bug,
    # not a readiness state, and must not be polled away as a timeout.
    $headers = Get-JarvisLocalHeaders $Url $Token
    $client = New-JarvisLocalHttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(5)
    $request = $null
    $response = $null
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Url)
        $request.Headers.Add('Authorization', $headers.Authorization)
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $status = [int]$response.StatusCode
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $body = $null
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            try { $body = $text | ConvertFrom-Json } catch { $body = $null }
        }
        return [pscustomobject]@{ status = $status; body = $body; error = $null }
    } catch {
        return [pscustomobject]@{ status = 0; body = $null; error = $_.Exception.Message }
    } finally {
        if ($response) { $response.Dispose() }
        if ($request) { $request.Dispose() }
        $client.Dispose()
    }
}

function Get-JarvisReadinessMember {
    <#
    .SYNOPSIS
        Read one member from a JSON-shaped object (PSCustomObject or hashtable).
    #>
    param($InputObject, [string]$Name)
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        if ($InputObject.Contains($Name)) { return $InputObject[$Name] }
        return $null
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Test-JarvisReadinessTerminalError {
    <#
    .SYNOPSIS
        Does a degraded readiness error describe a state waiting cannot fix?

    .DESCRIPTION
        A degraded snapshot can be transient (a warm-up that timed out and may
        be retried, a model server that is still starting) or hopeless (the
        configured model or file is missing). Only the second kind is a
        "never ready" answer; everything else keeps polling inside the budget.
    #>
    param([string]$Message)
    if ([string]::IsNullOrWhiteSpace($Message)) { return $false }
    return [bool]($Message -match '(?i)\bmissing\b|\babsent\b|not\s+configured|unconfigured|no\s+model|not\s+served|no\s+such\s+file|\benoent\b|does\s+not\s+exist|not\s+found')
}

function Resolve-JarvisChatReadiness {
    <#
    .SYNOPSIS
        Turn one readiness probe into ready / keep waiting / a final outcome.

    .DESCRIPTION
        The decision the wait needs, as data:

          ready        the engine snapshot says 'ready'; the signal is
                       readiness_state:ready and a chat can be attempted.
          not ready    a probe that has not reached the server yet, or a
                       pending/warming/transiently degraded state. Not ready,
                       not terminal: the wait keeps polling inside the budget.
          not_ready    the app says the engine is configured never to come up
                       (disabled / no model configured), the route is absent,
                       the credential is refused, or a degraded snapshot names
                       an unloadable engine. Waiting cannot change any of
                       those, so this is terminal and immediate (DD-168).
          timeout      the budget ran out while the signal was still not
                       ready; the last observed state is carried along.
          unreachable  the budget ran out without /health/readiness ever
                       answering.

        -AllowChatError (DD-EO15, 2026-11-25) does not turn a not-ready engine
        into an answer: it makes the readiness step a passing, recorded
        outcome (proceed = $true, exit_code = 0) so the smoke can still send
        the chat, whose terminal error stays tolerated exactly as before.
        Without it, a terminal not-ready/timeout/unreachable outcome fails the
        smoke before any chat is sent (proceed = $false, exit_code = 1).

        Pure: no HTTP, no clock, no exit, so scripts/release-smoke.Tests.ps1
        drives every state without a port or a backend.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object]$Probe,
        [int]$ElapsedMs = 0,
        [switch]$TimedOut,
        [switch]$AllowChatError
    )

    $status = 200
    $body = $Probe
    $probeError = ''
    if ($null -eq $Probe) {
        $status = 0
    } elseif ($null -ne (Get-JarvisReadinessMember $Probe 'status')) {
        $status = [int](Get-JarvisReadinessMember $Probe 'status')
        $body = Get-JarvisReadinessMember $Probe 'body'
        $probeError = [string](Get-JarvisReadinessMember $Probe 'error')
    }

    $ready = $false
    $terminal = $false
    $unreachable = $false
    $state = 'unknown'
    $signal = 'readiness_state:unknown'
    $detail = 'no probe result'
    $errorClass = $null

    if ($status -eq 0) {
        # No HTTP answer yet: the server or its route may still be coming up.
        $unreachable = $true
        $state = 'probe_error'
        $signal = 'readiness_http:unreachable'
        $detail = if ($probeError) { $probeError } else { 'no response from /health/readiness' }
    } elseif ($status -eq 404 -or $status -eq 405) {
        # The server answered but has no readiness route: waiting cannot add
        # one to a build that does not expose it.
        $terminal = $true
        $state = 'signal_unavailable'
        $signal = 'readiness_state:absent'
        $detail = "GET /health/readiness answered HTTP $status; this build exposes no readiness snapshot"
        $errorClass = 'chat_ready_signal_unavailable'
    } elseif ($status -eq 401 -or $status -eq 403) {
        $terminal = $true
        $state = 'signal_unauthorized'
        $signal = "readiness_http:$status"
        $detail = "GET /health/readiness answered HTTP $status; the launch credential is not accepted"
        $errorClass = 'chat_ready_signal_unauthorized'
    } elseif ($status -lt 200 -or $status -ge 300) {
        # 5xx and the rest: the server is up enough to answer, but not with a
        # readiness snapshot. Keep polling inside the budget.
        $state = 'probe_error'
        $signal = "readiness_http:$status"
        $detail = "GET /health/readiness answered HTTP $status"
    } else {
        $conductor = Get-JarvisReadinessMember $body 'conductor'
        if ($null -eq $conductor) {
            # A liveness body (/health) is not a readiness body. Never ready,
            # and never going to become one by polling it again.
            $terminal = $true
            $state = 'signal_unavailable'
            $signal = 'readiness_state:absent'
            $detail = 'the 200 response carried no conductor readiness snapshot (liveness is not readiness)'
            $errorClass = 'chat_ready_signal_unavailable'
        } else {
            $enabled = Get-JarvisReadinessMember $conductor 'enabled'
            $conductorState = [string](Get-JarvisReadinessMember $conductor 'state')
            $model = [string](Get-JarvisReadinessMember $conductor 'model')
            $conductorError = [string](Get-JarvisReadinessMember $conductor 'error')
            if ([string]::IsNullOrWhiteSpace($conductorState)) { $conductorState = 'unknown' }

            if ($enabled -eq $false -or $conductorState -eq 'disabled') {
                # The app itself says the engine is configured never to come
                # up: no model will be loaded, so the budget is not spent.
                $terminal = $true
                $state = 'disabled'
                $signal = 'readiness_state:disabled'
                $detail = "the app reports no engine to wait for (enabled=$enabled, state=$conductorState); no model is configured to load"
                $errorClass = 'chat_ready_no_model_configured'
            } elseif ($conductorState -eq 'ready') {
                $ready = $true
                $terminal = $true
                $state = 'ready'
                $signal = 'readiness_state:ready'
                $detail = if ($model) { "engine model '$model' reports ready" } else { 'engine readiness reports ready' }
            } elseif ($conductorState -eq 'degraded' -and (Test-JarvisReadinessTerminalError $conductorError)) {
                $terminal = $true
                $state = 'degraded'
                $signal = 'readiness_state:degraded'
                $detail = "engine readiness degraded with an unloadable configuration: $conductorError"
                $errorClass = 'chat_ready_engine_missing'
            } else {
                # pending, warming, a transient degraded state, or a state a
                # later build adds: not ready yet, still worth waiting for.
                $state = $conductorState
                $signal = "readiness_state:$conductorState"
                $detail = if ($conductorError) { "state $conductorState ($conductorError)" } else { "state $conductorState" }
            }
        }
    }

    if ($ready) {
        return [pscustomobject]@{
            ready = $true; terminal = $true; proceed = $true; ok = $true; exit_code = 0
            outcome = 'ready'; state = $state; signal = $signal; detail = $detail
            error_class = $null; elapsed_ms = $ElapsedMs
        }
    }

    if ($TimedOut) {
        $terminal = $true
        if ($unreachable) {
            $outcome = 'unreachable'
            $errorClass = 'chat_ready_unreachable'
            $detail = "never became ready and never answered /health/readiness ($detail)"
        } else {
            $outcome = 'timeout'
            $errorClass = 'chat_ready_timeout'
            $detail = "not ready after $ElapsedMs ms; last observed state '$state' ($detail)"
        }
    } elseif ($terminal) {
        $outcome = 'not_ready'
    } else {
        # Still worth waiting: this is an observation, not a verdict.
        return [pscustomobject]@{
            ready = $false; terminal = $false; proceed = $false; ok = $false; exit_code = 1
            outcome = $(if ($unreachable) { 'unreachable' } else { 'not_ready' })
            state = $state; signal = $signal; detail = $detail
            error_class = $null; elapsed_ms = $ElapsedMs
        }
    }

    # A terminal not-ready decision. -AllowChatError records it and proceeds to
    # the chat; without the flag the smoke fails here, before the chat.
    $tolerate = [bool]$AllowChatError
    return [pscustomobject]@{
        ready = $false; terminal = $true
        proceed = $tolerate; ok = $tolerate
        exit_code = $(if ($tolerate) { 0 } else { 1 })
        outcome = $outcome; state = $state; signal = $signal; detail = $detail
        error_class = $errorClass; elapsed_ms = $ElapsedMs
    }
}

function Wait-JarvisChatReady {
    <#
    .SYNOPSIS
        Wait, inside one budget, for the engine that answers chat to be ready.

    .DESCRIPTION
        Polls the readiness probe until Resolve-JarvisChatReadiness says ready,
        the signal says no wait can help, or the budget runs out. The result
        says which outcome happened (ready / not_ready / timeout /
        unreachable), which signal was observed last, the last state, how many
        polls it took and how long it took, so a model that needed 60 s to load
        is distinguishable from one that was never coming.

        The clock, the wait and the probe are injectable so the offline tests
        can drive sequences (warming -> ready, never ready, timeout) without
        sleeping for minutes or opening a port; production uses Get-Date,
        Start-Sleep and Get-JarvisReadinessProbe.

        -AllowChatError is passed through to the decision, so a not-ready
        engine becomes a recorded, passing outcome here rather than a thrown
        failure (DD-EO15). An owned process that exits during the wait is
        still reported immediately (`server_exited_before_chat_ready`), like
        Wait-JarvisHealth does.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [int]$TimeoutSeconds = 240,
        [string]$Token,
        [scriptblock]$Probe,
        [int]$PollMilliseconds = 1000,
        [scriptblock]$Now,
        [scriptblock]$Wait,
        [switch]$AllowChatError,
        $Process
    )
    if (-not $Probe) {
        $Probe = { param($ReadyUrl, $ReadyToken) Get-JarvisReadinessProbe -Url $ReadyUrl -Token $ReadyToken }
    }
    if (-not $Now) { $Now = { Get-Date } }
    if (-not $Wait) { $Wait = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds } }

    $startedAt = & $Now
    $deadline = $startedAt.AddSeconds([Math]::Max(0, $TimeoutSeconds))
    $attempts = 0
    $lastProbe = $null
    $lastVerdict = $null

    while ((& $Now) -lt $deadline) {
        if ($Process -and $Process.HasExited) {
            throw "server_exited_before_chat_ready:$($Process.ExitCode)"
        }
        $attempts++
        $lastProbe = & $Probe $Url $Token
        $elapsedMs = [int](((& $Now) - $startedAt).TotalMilliseconds)
        $verdict = Resolve-JarvisChatReadiness -Probe $lastProbe -ElapsedMs $elapsedMs `
            -AllowChatError:$AllowChatError
        $lastVerdict = $verdict
        if ($verdict.ready -or $verdict.terminal) {
            return [pscustomobject]@{
                outcome = $verdict.outcome; ready = $verdict.ready; terminal = $verdict.terminal
                proceed = $verdict.proceed; ok = $verdict.ok; exit_code = $verdict.exit_code
                state = $verdict.state; signal = $verdict.signal; detail = $verdict.detail
                error_class = $verdict.error_class; elapsed_ms = $elapsedMs; attempts = $attempts
            }
        }
        & $Wait $PollMilliseconds
    }

    $elapsedMs = [int](((& $Now) - $startedAt).TotalMilliseconds)
    $verdict = Resolve-JarvisChatReadiness -Probe $lastProbe -ElapsedMs $elapsedMs `
        -TimedOut -AllowChatError:$AllowChatError
    $detail = if ($lastVerdict) {
        "$($verdict.detail); last signal $($lastVerdict.signal)"
    } else {
        "$($verdict.detail); no probe completed"
    }
    return [pscustomobject]@{
        outcome = $verdict.outcome; ready = $verdict.ready; terminal = $verdict.terminal
        proceed = $verdict.proceed; ok = $verdict.ok; exit_code = $verdict.exit_code
        state = $verdict.state; signal = $verdict.signal; detail = $detail
        error_class = $verdict.error_class; elapsed_ms = $elapsedMs; attempts = $attempts
    }
}

function Start-JarvisInstalledApp {
    <#
    .SYNOPSIS
        Launch the installed Jarvis.exe -- the artifact a user double-clicks.

    .DESCRIPTION
        The app owns its server: on startup it starts the bundled bun.exe
        beside the exe (find_bun_executable checks that directory first) and
        that server binds the fixed SERVER_PORT. Starting the app therefore
        starts the real process tree, and Stop-JarvisOwnedProcesses tears it
        down again -- the app and the server it spawned.

        There is no Bun-from-PATH path here on purpose: the launch target has
        already been proven to be the installed exe, and using another
        runtime would let a green smoke report a server the installer never
        started.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$AppPath,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [ref]$Token
    )
    if (-not (Test-Path -LiteralPath $AppPath -PathType Leaf)) {
        throw "installed_app_binary_missing:$AppPath"
    }
    $null = Assert-JarvisInstalledAppTarget -AppPath $AppPath -InstallRoot $InstallRoot
    $logDir = Join-Path $env:TEMP 'jarvis-release-smoke'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stdout = Join-Path $logDir 'app.out.log'
    $stderr = Join-Path $logDir 'app.err.log'
    $startedProcess = Start-JarvisPrivateLaunch -AppPath $AppPath -WorkingDirectory $InstallRoot `
        -StdoutPath $stdout -StderrPath $stderr -Token $Token
    $startedProcess | Add-Member -NotePropertyName JarvisOwnedStartTime -NotePropertyValue $startedProcess.StartTime
    return $startedProcess
}

function Resolve-JarvisChatOutcome {
    <#
    .SYNOPSIS
        Decide what the chat step records for one /chat/stream response.

    .DESCRIPTION
        The chat step has three outcomes, not two:

          answer           a terminal 'result' frame whose own subtype is
                           'success': the published installer actually answered
                           a chat.
          error_tolerated  a terminal 'error' frame, or a terminal 'result'
                           frame whose subtype says the turn failed, while
                           -AllowChatError is set. The step still passes and
                           the run still exits 0, but the outcome is recorded
                           as its own value with the frame's code and text, so
                           a reader can see that the published installer never
                           answered a chat.
          failed           the same non-success frames without the flag, a
                           'cancelled' frame, or no terminal frame at all.

        A 'result' frame is not an answer by virtue of its type alone (DD-167).
        The server publishes the whole truth on that frame: subtype 'error' or
        'partial' with a code (for example turn_deadline) means the turn
        failed, and the empty-answer fallback path even finishes a failed turn
        with its friendly retry notice as the result text. So only
        subtype 'success' is an answer; a result frame with any other subtype,
        including no subtype at all, never records one.

        Each failing outcome names its class (chat_terminal_error,
        chat_terminal_cancelled, chat_no_terminal_event,
        chat_result_subtype_error, chat_result_subtype_partial,
        chat_result_subtype_unknown) so the record says why the request did not
        produce an answer.

        Pure: it takes the Get-JarvisSseOutcome record and the caller's
        intent and returns the decision. No I/O and no exit, so
        scripts/release-smoke.Tests.ps1 drives every case without an
        installer, a network port or an inference backend.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowNull()][object]$SseOutcome,
        [switch]$AllowChatError
    )

    $type = if ($null -ne $SseOutcome) { [string]$SseOutcome.type } else { '' }
    $subtype = if ($null -ne $SseOutcome) { [string]$SseOutcome.subtype } else { '' }
    $code = if ($null -ne $SseOutcome) { [string]$SseOutcome.code } else { '' }
    $text = if ($null -ne $SseOutcome) { [string]$SseOutcome.text } else { '' }
    # `ok` on the parser record means a terminal 'result' frame arrived. It is
    # not a verdict: the verdict is the frame's own subtype.
    $isResultFrame = ($null -ne $SseOutcome) -and [bool]$SseOutcome.ok
    $answered = $isResultFrame -and ($subtype -eq 'success')

    if ($answered) {
        return [pscustomobject]@{
            outcome     = 'answer'
            ok          = $true
            exit_code   = 0
            error_class = $null
            type        = $type
            subtype     = $subtype
            code        = $(if ($code) { $code } else { $null })
            text        = $text
            reason      = $null
        }
    }

    if ($isResultFrame) {
        # A terminal result frame whose subtype is not 'success': the turn
        # failed even though a result frame arrived. Never an answer.
        $subtypeSlug = if ($subtype) { ($subtype -replace '[^A-Za-z0-9_-]', '_') } else { 'unknown' }
        $errorClass = "chat_result_subtype_$subtypeSlug"
        $reason = "terminal_result_subtype_$subtypeSlug"
        if ($AllowChatError) {
            # Tolerated, not answered: the step passes but the outcome keeps
            # saying that the terminal frame was not a success.
            return [pscustomobject]@{
                outcome     = 'error_tolerated'
                ok          = $true
                exit_code   = 0
                error_class = $errorClass
                type        = $type
                subtype     = $subtype
                code        = $(if ($code) { $code } else { $null })
                text        = $text
                reason      = $reason
            }
        }
        return [pscustomobject]@{
            outcome     = 'failed'
            ok          = $false
            exit_code   = 1
            error_class = $errorClass
            type        = $type
            subtype     = $subtype
            code        = $(if ($code) { $code } else { $null })
            text        = $text
            reason      = $reason
        }
    }

    if ($type -eq 'error') {
        $errorClass = 'chat_terminal_error'
        $reason = 'terminal_error'
        if ($AllowChatError) {
            # Tolerated, not answered: the step passes but the outcome keeps
            # saying that the terminal frame was an error.
            return [pscustomobject]@{
                outcome     = 'error_tolerated'
                ok          = $true
                exit_code   = 0
                error_class = $errorClass
                type        = $type
                subtype     = $(if ($subtype) { $subtype } else { $null })
                code        = $(if ($code) { $code } else { $null })
                text        = $text
                reason      = $reason
            }
        }
    } elseif ($type -eq 'cancelled') {
        $errorClass = 'chat_terminal_cancelled'
        $reason = 'terminal_cancelled'
    } else {
        $errorClass = 'chat_no_terminal_event'
        $reason = 'no_terminal_event'
    }

    return [pscustomobject]@{
        outcome     = 'failed'
        ok          = $false
        exit_code   = 1
        error_class = $errorClass
        type        = $type
        subtype     = $(if ($subtype) { $subtype } else { $null })
        code        = $(if ($code) { $code } else { $null })
        text        = $text
        reason      = $reason
    }
}

# ── Entry point ──────────────────────────────────────────────────────────────

if ($MyInvocation.InvocationName -eq '.') { return }

$results = [System.Collections.Generic.List[object]]::new()
function Add-Result([string]$Step, [bool]$Ok, [string]$Detail, [string]$Outcome = '', [string]$ErrorClass = '', [string]$Text = '') {
    # outcome/error_class/text are written only by a step that classifies its
    # result (the chat step does); every other step keeps the original
    # step/ok/detail shape.
    $entry = [ordered]@{ step = $Step; ok = $Ok; detail = $Detail }
    if ($Outcome) { $entry['outcome'] = $Outcome }
    if ($ErrorClass) { $entry['error_class'] = $ErrorClass }
    if ($Text) { $entry['text'] = $Text }
    $results.Add([pscustomobject]$entry)
    if ($Ok) { Write-Ok "$Step - $Detail" } else { Write-Host "  [FAIL] $Step - $Detail" -ForegroundColor Red }
}

Write-Host "Jarvis release smoke" -ForegroundColor White
Write-Host "  manifest: $ManifestPath"

# ── 1. Record ────────────────────────────────────────────────────────────────
Write-Step 'Reading the release record'
try {
    $manifest = Read-JarvisReleaseManifest -Path $ManifestPath
} catch {
    Die $_.Exception.Message
}
if ([string]$manifest.schema -ne 'jarvis.release/1') {
    Die "unexpected release record schema: $($manifest.schema)"
}
Write-Ok "version $($manifest.version), git_sha $($manifest.git_sha)"

$installerEntry = $manifest.files | Where-Object { $_.role -eq 'installer' } | Select-Object -First 1
$appBinaryEntry = $manifest.files | Where-Object { $_.role -eq 'app_binary' } | Select-Object -First 1
$serverEntry = $manifest.files | Where-Object { $_.role -eq 'server_bundle' } | Select-Object -First 1
if (-not $installerEntry) { Die 'the release record names no installer' }
if (-not $appBinaryEntry) { Die 'the release record names no app binary' }
if (-not $serverEntry) { Die 'the release record names no server bundle' }
if ($SkipInstall -and -not $SkipLaunch) { Die 'skip_install_requires_skip_launch: runtime provenance requires installed resources' }

# The record stores paths relative to the release directory so it stays
# portable; resolve them against the directory the record lives in.
$installerEntryPath = Resolve-JarvisManifestPath -ManifestPath $ManifestPath -ArtifactPath $installerEntry.path
$serverEntryPath = Resolve-JarvisManifestPath -ManifestPath $ManifestPath -ArtifactPath $serverEntry.path

# ── 2. Hash ──────────────────────────────────────────────────────────────────
Write-Step 'Verifying the installer hash'
if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    $InstallerPath = $installerEntryPath
}
$hash = Test-JarvisArtifactHash -Path $InstallerPath -ExpectedSha256 $installerEntry.sha256
if (-not $hash.ok) { Add-Result 'hash' $false $hash.reason; Die "installer hash check failed: $($hash.reason)" }
Add-Result 'hash' $true "installer sha256 $($hash.actual)"

# ── 3. Fixed-port preflight and install ──────────────────────────────────────
$installOwned = $false
$serverProcess = $null
$installedExe = $null
$resolveError = $null
$healthSource = $null
# The chat step's recorded outcome. 'not_run' is the honest value when the
# step was skipped; the three real outcomes come from
# Resolve-JarvisChatOutcome.
$chatOutcome = 'not_run'
$chatErrorClass = $null
$chatErrorCode = $null
$chatError = $null
# The readiness step's record (DD-168): the outcome value, the signal it
# waited on, the last state it observed, elapsed ms and the failure class.
# 'not_run' means the chat step was skipped, so nothing waited for an engine.
$readinessOutcome = 'not_run'
$readinessSignal = $null
$readinessState = $null
$readinessElapsedMs = $null
$readinessErrorClass = $null
$readinessDetail = $null
try {
if (-not $SkipLaunch) {
    Write-Step 'Preflighting the fixed server port'
    try {
        # DD-095: the port query is bounded like the rest of the pipeline's
        # OS queries. A listener query that stops answering must fail the
        # preflight inside its own deadline instead of stalling the smoke
        # before the install has even started.
        $null = Assert-JarvisPortAvailable -Port $ServerPort -Deadline ((Get-Date).AddSeconds(15))
    } catch {
        Add-Result 'preflight' $false $_.Exception.Message
        if ($_.Exception.Message -notlike 'port_already_in_use*') {
            Die "the preflight could not prove port $ServerPort free ($($_.Exception.Message)); the smoke will not attribute a listener it cannot identify to the process it starts."
        }
        Die "port $ServerPort is already in use, and the packaged server always binds that fixed port (server-jarvis/src/server-guards.ts SERVER_PORT). The smoke will not measure another process's listener: stop the process that owns $ServerPort and re-run. ($($_.Exception.Message))"
    }
    Add-Result 'preflight' $true "port $ServerPort is free"
}
if (-not $SkipInstall) {
    Write-Step 'Installing the release'
    try {
        $InstallRoot = Install-JarvisRelease -InstallerPath $InstallerPath -InstallRoot $InstallRoot -TimeoutSeconds $TimeoutSeconds
        $installOwned = $true
    } catch {
        Add-Result 'install' $false $_.Exception.Message
        Die "install failed: $($_.Exception.Message)"
    }
    Add-Result 'install' $true "installed to $InstallRoot"

    if ($appBinaryEntry) {
        # Matched by hash: the installer lays the binary down under the
        # crate name, and the bytes it carries are the ones the release
        # record describes (the record reads them from a real install).
        # The same resolution is what the launch step starts, so the exe
        # whose hash was proven here is the exe that must answer /health.
        try {
            $installedExe = Resolve-JarvisAppLaunchTarget -InstallRoot $InstallRoot `
                -ExpectedSha256 $appBinaryEntry.sha256 `
                -BinaryName ([string]$manifest.app_binary_name)
        } catch {
            $resolveError = $_.Exception.Message
            $installedExe = $null
        }
        if (-not $installedExe) {
            $why = if ($resolveError) { $resolveError } else {
                "no installed binary matches the recorded sha256 $($appBinaryEntry.sha256)"
            }
            Add-Result 'installed_binary_hash' $false $why
            Die "the install does not contain the binary the release record describes ($why)"
        }
        Add-Result 'installed_binary_hash' $true "installed binary matches the release record ($([IO.Path]::GetFileName($installedExe)))"
    }
    $resources = Test-JarvisInstalledResources -InstallRoot $InstallRoot -Manifest $manifest
    if (-not $resources.ok) { Die "installed resources do not match the release record: $($resources.reason)" }
    Add-Result 'installed_resources' $true 'installed server bundle and sidecars match the record'
} else {
    Write-Warn 'skipping install (-SkipInstall)'
}

# ── 4. Launch and health ─────────────────────────────────────────────────────
if (-not $SkipLaunch) {
    # The launch step starts the artifact a user double-clicks: the installed
    # exe whose hash the install step just proved. The app starts its own
    # server with the bundled bun.exe beside it, so /health and /chat/stream
    # answer through the installer's process tree and nowhere else.
    Write-Step 'Launching the installed app'
    if (-not $installedExe) {
        try {
            $installedExe = Resolve-JarvisAppLaunchTarget -InstallRoot $InstallRoot `
                -ExpectedSha256 $appBinaryEntry.sha256 `
                -BinaryName ([string]$manifest.app_binary_name)
        } catch {
            Add-Result 'launch' $false $_.Exception.Message
            Die "the installed app could not be located: $($_.Exception.Message)"
        }
    }
    $healthUrl = "http://127.0.0.1:$ServerPort/health"
    $serverToken = ''
    try {
        $serverProcess = Start-JarvisInstalledApp -AppPath $installedExe -InstallRoot $InstallRoot -Token ([ref]$serverToken)
    } catch {
        Add-Result 'launch' $false $_.Exception.Message
        Die "the installed app could not be launched: $($_.Exception.Message)"
    }
    $healthSource = "installed_app:$([IO.Path]::GetFileName($installedExe)):pid_$($serverProcess.Id)"
    Add-Result 'launch' $true "installed app $([IO.Path]::GetFileName($installedExe)) started (pid $($serverProcess.Id)); it owns the server on port $ServerPort"
    try {
        $health = Wait-JarvisHealth -Url $healthUrl -TimeoutSeconds $TimeoutSeconds -Process $serverProcess -Token $serverToken
    } catch {
        Add-Result 'health' $false $_.Exception.Message
        Die "the installed app's server never became healthy: $($_.Exception.Message)"
    }
    Add-Result 'health' $true "the installed app (pid $($serverProcess.Id)) owns the server that answered /health on port $ServerPort"

    Write-Step 'Verifying the running build matches the release record'
    $provenance = Test-JarvisHealthProvenance -Health $health -Manifest $manifest
    if (-not $provenance.ok) {
        Add-Result 'provenance' $false $provenance.reason
        Die "the running build is not the build in the release record: $($provenance.reason)"
    }
    Add-Result 'provenance' $true "running build is $($health.git_sha)"

    # ── 5. Chat readiness ────────────────────────────────────────────────────
    if (-not $SkipChat) {
        # /health above proved liveness and provenance only: Bun answers as
        # soon as it serves requests, not when a model can answer. DD-168:
        # wait (bounded) for the app's own engine snapshot before opening the
        # chat stream, and record which signal satisfied the wait.
        Write-Step 'Waiting for the chat engine to become ready'
        $readinessUrl = "http://127.0.0.1:$ServerPort/health/readiness"
        try {
            $readiness = Wait-JarvisChatReady -Url $readinessUrl `
                -TimeoutSeconds $ChatReadyTimeoutSeconds `
                -Token $serverToken -Process $serverProcess `
                -AllowChatError:$AllowChatError
        } catch {
            $readinessOutcome = 'unreachable'
            $readinessSignal = 'readiness_http:unreachable'
            $readinessState = 'probe_error'
            $readinessErrorClass = 'chat_ready_probe_failed'
            $readinessDetail = $_.Exception.Message
            Add-Result 'chat-ready' $false $_.Exception.Message `
                -Outcome 'unreachable' -ErrorClass 'chat_ready_probe_failed'
            Die "the chat readiness wait failed: $($_.Exception.Message)"
        }
        $readinessOutcome = $readiness.outcome
        $readinessSignal = $readiness.signal
        $readinessState = $readiness.state
        $readinessElapsedMs = [int]$readiness.elapsed_ms
        $readinessErrorClass = $readiness.error_class
        $readinessDetail = $readiness.detail
        if (-not $readiness.proceed) {
            # Without -AllowChatError a never-ready engine fails the smoke
            # here, before the chat, with the signal and the last state it saw.
            Add-Result 'chat-ready' $false ("{0} after {1} ms; last observed state '{2}'; signal {3}; {4}" -f
                $readiness.outcome, $readiness.elapsed_ms, $readiness.state, $readiness.signal, $readiness.detail) `
                -Outcome $readiness.outcome -ErrorClass $readiness.error_class
            Die "the chat engine never became ready ($($readiness.outcome), signal $($readiness.signal), last state '$($readiness.state)', $($readiness.elapsed_ms) ms): $($readiness.detail)"
        }
        if ($readiness.ready) {
            Add-Result 'chat-ready' $true ("ready after {0} ms ({1} polls); signal {2}; last observed state '{3}'" -f
                $readiness.elapsed_ms, $readiness.attempts, $readiness.signal, $readiness.state) `
                -Outcome 'ready'
        } else {
            # -AllowChatError (DD-EO15): the not-ready engine is recorded as
            # data and the smoke still sends the chat, whose terminal error is
            # tolerated exactly as before. This changes no exit code on the
            # CI path.
            Add-Result 'chat-ready' $true ("{0} after {1} ms; signal {2}; last observed state '{3}'; proceeding because -AllowChatError; the chat's terminal error stays tolerated" -f
                $readiness.outcome, $readiness.elapsed_ms, $readiness.signal, $readiness.state) `
                -Outcome $readiness.outcome -ErrorClass $readiness.error_class
        }
    }

    # ── 6. Chat ───────────────────────────────────────────────────────────────
    if (-not $SkipChat) {
        Write-Step 'Sending a chat request'
        $streamUrl = "http://127.0.0.1:$ServerPort/chat/stream"
        $sessionId = [guid]::NewGuid().ToString()
        try {
            $events = Read-JarvisSseStream -Url $streamUrl -Timeout $TimeoutSeconds -Token $serverToken -Body @{
                message    = 'Reply with exactly: smoke ok.'
                session_id = $sessionId
            }
        } catch {
            Add-Result 'chat' $false $_.Exception.Message
            Die "the chat request failed: $($_.Exception.Message)"
        }
        $outcome = Get-JarvisSseOutcome -Events $events
        $decision = Resolve-JarvisChatOutcome -SseOutcome $outcome -AllowChatError:$AllowChatError
        $chatOutcome = $decision.outcome
        $chatErrorClass = $decision.error_class
        # The server names the cause on the frame (turn_deadline,
        # no_progress_repetition, ...). Keep it beside the class and text so a
        # scan of the record says why a non-answer ended the way it did.
        $chatErrorCode = $decision.code
        $chatError = if ($decision.outcome -eq 'answer') { $null } else { [string]$decision.text }
        $via = "via the installed app (pid $($serverProcess.Id))"
        if ($decision.exit_code -ne 0) {
            # A terminal result frame that is not subtype success lands here:
            # the frame arrived, the turn failed, and the record must not call
            # it an answer.
            $failure = "$($decision.error_class): $($decision.reason)"
            if ($decision.code) { $failure = "$failure [$($decision.code)]" }
            Add-Result 'chat' $false $failure `
                -Outcome 'failed' -ErrorClass $decision.error_class -Text $decision.text
            Die "the chat request did not reach a successful terminal frame: $($decision.reason)"
        }
        if ($decision.outcome -eq 'answer') {
            Add-Result 'chat' $true "outcome answer; terminal result: $($decision.text) ($via)" `
                -Outcome 'answer' -Text $decision.text
        } else {
            # A tolerated terminal error is a passing step, not an answer: the
            # recorded outcome, error class, code and text are what tell a
            # manifest reader that the published installer never answered a
            # chat.
            $toleratedDetail = "outcome error_tolerated; terminal $($decision.type)"
            if ($decision.subtype) { $toleratedDetail = "$toleratedDetail/$($decision.subtype)" }
            if ($decision.code) { $toleratedDetail = "$toleratedDetail [$($decision.code)]" }
            $toleratedDetail = "$toleratedDetail $($decision.text) ($via)"
            Add-Result 'chat' $true $toleratedDetail `
                -Outcome 'error_tolerated' -ErrorClass $decision.error_class -Text $decision.text
        }
    } else {
        Write-Warn 'skipping chat (-SkipChat)'
    }
} else {
    Write-Warn 'skipping launch (-SkipLaunch)'
}

} finally {
    try {
        if ($serverProcess) {
            # DD-126: teardown is a child wait too. The CIM enumeration that
            # finds the server the app spawned must not outlive the smoke's
            # own verdict, so it gets a deadline; a lost query warns instead
            # of turning a finished run into a hang.
            Stop-JarvisOwnedProcesses -Process $serverProcess -CleanupDeadline ((Get-Date).AddSeconds(20))
        }
    } catch {
        Write-Warn "owned process teardown failed: $($_.Exception.Message)"
    } finally {
        if ($installOwned) {
            Remove-JarvisReleaseScratchInstall -InstallRoot $InstallRoot
        }
    }
}

$summary = [pscustomobject]@{
    ok            = (@($results | Where-Object { -not $_.ok }).Count -eq 0)
    version       = $manifest.version
    git_sha       = $manifest.git_sha
    # health_source names what produced the health answer: the installed app
    # this smoke started, which owns the server that answered. A Bun from
    # PATH can never appear here.
    health_source = $healthSource
    # The chat step's outcome as data. 'answer' is the only value that means
    # the installed app answered a chat: a terminal 'result' frame whose
    # subtype is not 'success' is a failed turn even though the frame arrived,
    # so it records 'error_tolerated' (passing, with -AllowChatError) or
    # 'failed', never 'answer'. chat_error_code keeps the server's own cause
    # (turn_deadline, no_progress_repetition, ...) and chat_error its text, so
    # the record cannot be mistaken for a real answer. 'not_run' means the
    # step was skipped (-SkipChat).
    chat_outcome     = $chatOutcome
    chat_error_class = $chatErrorClass
    chat_error_code  = $chatErrorCode
    chat_error       = $chatError
    # DD-168: the readiness wait that precedes the chat. On a run that reached
    # a ready engine this is 'ready'; with -AllowChatError a never-ready engine
    # records 'not_ready' / 'timeout' / 'unreachable' here and the smoke still
    # proceeds to the chat whose own error is tolerated. readiness_signal says
    # which signal satisfied (or was last seen by) the wait, readiness_state is
    # the last state the app reported, readiness_elapsed_ms how long the wait
    # took, readiness_error_class names a terminal failure, and
    # readiness_detail keeps the observed text. 'not_run' means the chat step
    # was skipped, so nothing waited for an engine.
    readiness_outcome     = $readinessOutcome
    readiness_signal      = $readinessSignal
    readiness_state       = $readinessState
    readiness_elapsed_ms  = $readinessElapsedMs
    readiness_error_class = $readinessErrorClass
    readiness_detail      = $readinessDetail
    steps                 = $results.ToArray()
}
$summary | ConvertTo-Json -Depth 5 | Write-Output

Write-Host "`nRelease smoke passed." -ForegroundColor Green
exit 0
