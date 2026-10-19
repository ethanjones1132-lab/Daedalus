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
      3. launch  - the packaged server bundle is started on its own port
                   (never the default 19877, so a live Jarvis is not
                   disturbed) with the release identity baked in.
      4. health  - /health must report the git SHA and source-tree digest
                   the release record claims. THIS is the stale-binary
                   check: it is the difference between "the file on disk is
                   the build we made" and "the build answering requests is
                   the build we made".
      5. chat    - one /chat/stream request must reach a terminal frame.

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

.PARAMETER Port
    Port the packaged server is launched on. Deliberately NOT 19877.

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

    # Not the default 19877: a live Jarvis may own that port, and the
    # smoke must not disturb it or read its /health.
    [int]$Port = 19888,

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

. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

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
        [int]$Timeout
    )
    Add-Type -AssemblyName System.Net.Http
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($Timeout)
    $deadline = [datetime]::UtcNow.AddSeconds($Timeout)
    $response = $null
    $request = $null
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Post, $Url)
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
    #>
    [CmdletBinding()]
    param(
        [string]$Url,
        [int]$TimeoutSeconds
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastError = 'no attempt'
    while ((Get-Date) -lt $deadline) {
        try {
            return Invoke-RestMethod -Uri $Url -TimeoutSec 5
        } catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
        }
    }
    throw "health_timeout:$Url ($lastError)"
}

function Start-JarvisServerBundle {
    <#
    .SYNOPSIS
        Launch the packaged server bundle on the smoke's own port.
    #>
    [CmdletBinding()]
    param(
        [string]$BundlePath,
        [int]$Port,
        [string]$WorkingDirectory
    )
    $bunCommand = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bunCommand) {
        $fallback = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
        if (-not (Test-Path -LiteralPath $fallback)) { throw 'bun_not_found' }
        $bunPath = $fallback
    } else {
        $bunPath = $bunCommand.Source
    }
    $previousPort = $env:JARVIS_SERVER_PORT
    $env:JARVIS_SERVER_PORT = [string]$Port
    try {
        $logDir = Join-Path $env:TEMP 'jarvis-release-smoke'
        New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        $stdout = Join-Path $logDir 'server.out.log'
        $stderr = Join-Path $logDir 'server.err.log'
        $startedProcess = Start-Process -FilePath $bunPath -ArgumentList @('"' + $BundlePath + '"') `
            -WorkingDirectory $WorkingDirectory -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $startedProcess | Add-Member -NotePropertyName JarvisOwnedStartTime -NotePropertyValue $startedProcess.StartTime
        return $startedProcess
    } finally {
        $env:JARVIS_SERVER_PORT = $previousPort
    }
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

# ── 3. Install ───────────────────────────────────────────────────────────────
$installOwned = $false
$serverProcess = $null
try {
if (-not $SkipLaunch) { Assert-JarvisPortAvailable -Port $Port }
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
        $installedExe = Find-JarvisInstalledBinary -InstallRoot $InstallRoot `
            -ExpectedSha256 $appBinaryEntry.sha256 `
            -BinaryName ([string]$manifest.app_binary_name)
        if (-not $installedExe) {
            Add-Result 'installed_binary_hash' $false "no installed binary matches the recorded sha256 $($appBinaryEntry.sha256)"
            Die "the install does not contain the binary the release record describes"
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
    Write-Step 'Launching the packaged server'
    $bundlePath = Join-Path $InstallRoot 'index.js'
    if (-not (Test-Path -LiteralPath $bundlePath -PathType Leaf)) {
        Die "packaged server bundle missing: $bundlePath"
    }
    $healthUrl = "http://127.0.0.1:$Port/health"
    try {
        $serverProcess = Start-JarvisServerBundle -BundlePath $bundlePath -Port $Port -WorkingDirectory (Split-Path -Parent $bundlePath)
    } catch {
        Add-Result 'launch' $false $_.Exception.Message
        Die "the packaged server could not be launched: $($_.Exception.Message)"
    }
    Add-Result 'launch' $true "server started on port $Port"
    try {
        $health = Wait-JarvisHealth -Url $healthUrl -TimeoutSeconds $TimeoutSeconds
    } catch {
        Add-Result 'health' $false $_.Exception.Message
        Die "the packaged server never became healthy: $($_.Exception.Message)"
    }
    Add-Result 'health' $true "server answered on port $Port"

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
        $streamUrl = "http://127.0.0.1:$Port/chat/stream"
        $sessionId = [guid]::NewGuid().ToString()
        try {
            $events = Read-JarvisSseStream -Url $streamUrl -Timeout $TimeoutSeconds -Body @{
                message    = 'Reply with exactly: smoke ok.'
                session_id = $sessionId
            }
        } catch {
            Add-Result 'chat' $false $_.Exception.Message
            Die "the chat request failed: $($_.Exception.Message)"
        }
        $outcome = Get-JarvisSseOutcome -Events $events
        if ($outcome.ok) {
            Add-Result 'chat' $true "terminal result: $($outcome.text)"
        } elseif ($AllowChatError -and $outcome.type -eq 'error') {
            Add-Result 'chat' $true "terminal error tolerated: $($outcome.text)"
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
            Remove-JarvisReleaseInstall -InstallRoot $InstallRoot | Out-Null
            Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$summary = [pscustomobject]@{
    ok       = (@($results | Where-Object { -not $_.ok }).Count -eq 0)
    version  = $manifest.version
    git_sha  = $manifest.git_sha
    steps    = $results.ToArray()
}
$summary | ConvertTo-Json -Depth 5 | Write-Output

Write-Host "`nRelease smoke passed." -ForegroundColor Green
exit 0
