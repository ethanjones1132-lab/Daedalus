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
                   the build we made".
      5. chat    - one /chat/stream request must reach a terminal frame,
                   answered by the same installed app.

    The decision functions are pure and separately testable, so the
    interesting rules (hash mismatch, stale build, missing terminal frame)
    are covered by scripts/release-pipeline.Tests.ps1 without needing an
    installer, a certificate or an inference backend.

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

    # Treat a chat terminal frame of type 'error' as a pass. For a release
    # build the packaging is what is under test; inference credentials are
    # a separate concern with a separate owner.
    [switch]$AllowChatError,

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

# ── Entry point ──────────────────────────────────────────────────────────────

if ($MyInvocation.InvocationName -eq '.') { return }

$results = [System.Collections.Generic.List[object]]::new()
function Add-Result([string]$Step, [bool]$Ok, [string]$Detail) {
    $results.Add([pscustomobject]@{ step = $Step; ok = $Ok; detail = $Detail })
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

    # ── 5. Chat ───────────────────────────────────────────────────────────────
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
        $via = "via the installed app (pid $($serverProcess.Id))"
        if ($outcome.ok) {
            Add-Result 'chat' $true "terminal result: $($outcome.text) ($via)"
        } elseif ($AllowChatError -and $outcome.type -eq 'error') {
            Add-Result 'chat' $true "terminal error tolerated: $($outcome.text) ($via)"
        } else {
            Add-Result 'chat' $false $outcome.reason
            Die "the chat request did not reach a successful terminal frame: $($outcome.reason)"
        }
    } else {
        Write-Warn 'skipping chat (-SkipChat)'
    }
} else {
    Write-Warn 'skipping launch (-SkipLaunch)'
}

} finally {
    try {
        if ($serverProcess) { Stop-JarvisOwnedProcesses -Process $serverProcess }
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
    steps         = $results.ToArray()
}
$summary | ConvertTo-Json -Depth 5 | Write-Output

Write-Host "`nRelease smoke passed." -ForegroundColor Green
exit 0
