<#
.SYNOPSIS
    Build a Jarvis release: the NSIS installer plus one inspectable record.

.DESCRIPTION
    Runs the release build and writes a release manifest that names every
    shipped artifact with its SHA-256:

        dist/release/<version>/jarvis-release.json
        dist/release/<version>/SHA256SUMS.txt

    The record covers the installer, the app binary, the server bundle, the
    MCP stdio sidecar, the Claude proxy and the OpenCode Go model list, so
    "what is in this release" is one file rather than three manifests that
    have to be cross-referenced.

    Three things this script refuses to do, each of which has bitten this
    repo before:

      * build with a version the surfaces disagree on. The frontend, the
        backend, the sidecar and the installer must all say the same
        version; a v1.0 that ships labelled 3.0.0 is a mislabelled v1.0.

      * ship a bundle whose build identity did not fold in. The identity is
        passed to the frontend build through the environment and folded in
        with `bun build --define`; a bundle that still reads the
        environment at runtime reports `git_sha: "dev"` and /health can no
        longer tell which build is answering. That is the 2026-07
        stale-bundle incident.

      * build from a dirty tree silently. A dirty build is recorded as
        dirty in the manifest rather than refused, because a local dev
        build is a legitimate thing to want; but the record says so.

.PARAMETER RepoRoot
    Repository root. Defaults to the parent of this script's directory.

.PARAMETER OutputRoot
    Where the release record is written. Defaults to <repo>/dist/release.

.PARAMETER SkipTauriBuild
    Retained only to reject old invocations explicitly. Reusing an old
    installer while rebuilding frontend artifacts cannot attest provenance.

.PARAMETER AllowDirty
    Do not warn about a dirty worktree.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\release-build.ps1
#>
[CmdletBinding()]
param(
    # Resolved in the body, not here: $PSScriptRoot is not populated when a
    # param default is evaluated under PowerShell 5.1.
    [string]$RepoRoot = '',
    [string]$OutputRoot = '',
    [switch]$SkipTauriBuild,
    [switch]$AllowDirty,

    # Sign the installer before the record is written. Requires
    # JARVIS_SIGNING_THUMBPRINT (a certificate already in the Windows
    # certificate store) or JARVIS_SIGNING_PFX_PATH plus
    # JARVIS_SIGNING_PFX_PASSWORD.
    [switch]$Sign,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',

    # A signing-service command (Azure Artifact Signing, SignPath, ...).
    # Invoked with the artifact path as its only argument.
    [string]$SigningCommand = $env:JARVIS_SIGNING_COMMAND,

    # Budget for the silent install the build runs to read the shipped
    # app binary out of the installer.
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

if ($SkipTauriBuild) {
    throw 'skip_tauri_build_unsupported: rebuild the installer from this source; use sign-installer.ps1 only to inspect/sign an existing artifact.'
}

. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Die($msg)        { Write-Host "`n[FAILED] $msg" -ForegroundColor Red; exit 1 }

$RepoRoot = if ([string]::IsNullOrWhiteSpace($RepoRoot)) { Split-Path -Parent $PSScriptRoot } else { $RepoRoot }
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $RepoRoot 'dist\release'
}

Write-Host "Jarvis release build" -ForegroundColor White
Write-Host "  repo   : $RepoRoot"
Write-Host "  output : $OutputRoot"

# ── Identity ─────────────────────────────────────────────────────────────────
# Captured ONCE, before the build. The manifest's git_sha is this value,
# and it is the same value folded into the server bundle, so the two can
# never disagree.
Write-Step 'Resolving build identity'
$identity = Get-JarvisBuildIdentity -RepoRoot $RepoRoot
Write-Ok "git_sha           $($identity.git_sha)"
Write-Ok "git_dirty         $($identity.git_dirty)"
Write-Ok "source_tree_sha256 $($identity.source_tree_sha256)"
if ($identity.git_dirty -and -not $AllowDirty) {
    Write-Warn 'worktree is dirty - the release record will say so. Use -AllowDirty to silence.'
}

# ── Version ──────────────────────────────────────────────────────────────────
Write-Step 'Checking version consistency'
try {
    $version = Get-JarvisReleaseVersion -RepoRoot $RepoRoot
} catch {
    Die $_.Exception.Message
}
Write-Ok "version $version (frontend, backend, sidecar and installer agree)"

# ── Build ────────────────────────────────────────────────────────────────────
# The build identity travels to the frontend build through the environment
# and is folded in with `bun build --define`. See
# server-jarvis/src/build-frontend.ts for why that indirection exists.
Write-Step 'Building release artifacts'
$env:JARVIS_BUILD_GIT_SHA = $identity.git_sha
$env:JARVIS_BUILD_BUILT_AT = $identity.built_at
$env:JARVIS_BUILD_GIT_DIRTY = $identity.git_dirty.ToString().ToLowerInvariant()
$env:JARVIS_BUILD_SOURCE_TREE_SHA256 = $identity.source_tree_sha256

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) { Die 'cargo not found on PATH' }
Push-Location (Join-Path $RepoRoot 'src-tauri')
try {
    # The beforeBuildCommand builds the frontend from the same identity.
    & $cargo.Source tauri build
    if ($LASTEXITCODE -ne 0) { Die "cargo tauri build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# ── Verify the bundle carries the identity ───────────────────────────────────
Write-Step 'Verifying the server bundle carries the build identity'
$indexJs = Join-Path $RepoRoot 'server-jarvis\dist\index.js'
$provenance = Test-JarvisBundleProvenance -BundlePath $indexJs -Identity $identity
if (-not $provenance.ok) {
    Die $provenance.reason
}
Write-Ok "index.js reports git_sha $($identity.git_sha)"

# ── Locate the bundle ────────────────────────────────────────────────────────
# `cargo build --release` alone does NOT bundle an installer; only
# `cargo tauri build` writes one under target/release/bundle/nsis.
$cargoTargetRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $RepoRoot 'src-tauri\target' }
$nsisDir = Join-Path $cargoTargetRoot 'release\bundle\nsis'
$installer = Get-ChildItem -Path $nsisDir -Filter '*.exe' -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $installer) {
    Die "no NSIS installer found under $nsisDir. Check that the bundle target is 'nsis'."
}
Write-Ok "installer $($installer.Name)"

# ── Package ──────────────────────────────────────────────────────────────────
# Stage every shipped artifact into one directory, so the release is a
# self-contained thing that can be launched, installed and hashed without
# reaching back into the build tree.
Write-Step 'Packaging the release'
$versionDir = Join-Path $OutputRoot $version
if (Test-Path -LiteralPath $versionDir) {
    Remove-Item -LiteralPath $versionDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $versionDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $versionDir 'resources') | Out-Null

$stagedInstaller = Join-Path $versionDir $installer.Name
Copy-Item -LiteralPath $installer.FullName -Destination $stagedInstaller -Force
Copy-Item -LiteralPath $indexJs -Destination (Join-Path $versionDir 'index.js') -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot 'server-jarvis\dist\mcp-stdio-server.js') -Destination (Join-Path $versionDir 'mcp-stdio-server.js') -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\claude_cli_proxy.py') -Destination (Join-Path $versionDir 'resources\claude_cli_proxy.py') -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot 'scripts\opencode_go_openai_models.json') -Destination (Join-Path $versionDir 'resources\opencode_go_openai_models.json') -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot 'server-jarvis\src\prompts') -Destination (Join-Path $versionDir 'prompts') -Recurse -Force
Write-Ok "staged -> $versionDir"

# ── The binary as it actually ships ──────────────────────────────────────────
# The app binary is taken from a real install of the installer, not from
# target/release. They are NOT the same bytes: Tauri's bundler patches a
# copy of the exe (bundle type information) and that copy is what the
# installer carries, so a record that hashed the build-tree exe would
# describe a file no user ever runs. The install is deterministic, so the
# smoke reproduces these exact bytes from a second install.
Write-Step 'Reading the app binary from a real install'
$probeRoot = Join-Path $env:TEMP ('jarvis-release-probe-' + [guid]::NewGuid().ToString('N'))
$mainBinaryName = Get-JarvisMainBinaryName -RepoRoot $RepoRoot
$probeOwned = $false
try {
    $probeRoot = Install-JarvisRelease -InstallerPath $stagedInstaller -InstallRoot $probeRoot -TimeoutSeconds $TimeoutSeconds
    $probeOwned = $true
    $probeBinary = Join-Path $probeRoot "$mainBinaryName.exe"
    if (-not (Test-Path -LiteralPath $probeBinary -PathType Leaf)) {
        throw "installed_binary_missing:$probeBinary"
    }
    $stagedExe = Join-Path $versionDir 'Jarvis.exe'
    Copy-Item -LiteralPath $probeBinary -Destination $stagedExe -Force
    Write-Ok "app binary read from the install ($mainBinaryName.exe)"
} finally {
    if ($probeOwned) {
        Remove-JarvisReleaseInstall -InstallRoot $probeRoot | Out-Null
        Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── Sign ─────────────────────────────────────────────────────────────────────
# Signing changes the bytes, so it has to happen BEFORE the record is
# written. A record written before signing would describe an installer
# whose hash no longer matches the file on disk - and the release smoke's
# hash check would (correctly) fail on the release it had just produced.
$signatureStatus = $null
$signed = $false
if ($Sign) {
    Write-Step 'Signing the installer'
    try {
        $configuration = Resolve-JarvisSigningConfiguration `
            -Thumbprint $env:JARVIS_SIGNING_THUMBPRINT `
            -PfxPath $env:JARVIS_SIGNING_PFX_PATH `
            -PfxPassword $env:JARVIS_SIGNING_PFX_PASSWORD `
            -TimestampUrl $TimestampUrl `
            -Command $SigningCommand
        if ($configuration.mode -eq 'command') {
            Write-Ok "signing service command: $($configuration.command)"
        } else {
            Write-Ok "thumbprint $($configuration.thumbprint)"
        }
        if ($configuration.pfx_path) {
            $imported = Import-JarvisSigningCertificate -PfxPath $configuration.pfx_path -Password $env:JARVIS_SIGNING_PFX_PASSWORD
            $configuration.thumbprint = $imported.Thumbprint.ToUpperInvariant()
            Write-Ok "imported certificate $($configuration.thumbprint)"
        }
        $signatureStatus = Invoke-JarvisInstallerSigning -InstallerPath $stagedInstaller -Configuration $configuration
        $signed = $true
        Write-Ok "signature status: $($signatureStatus.status)"
    } catch {
        Die "signing failed: $($_.Exception.Message)"
    }
} else {
    Write-Warn 'not signing (-Sign not supplied); the release record will say so'
}

$promptsTree = (& git -C $RepoRoot ls-tree HEAD server-jarvis/src/prompts 2>$null | Out-String).Trim()
$promptsTreeSha = $null
if ($promptsTree) { $promptsTreeSha = ($promptsTree -split '\s+')[2] }

# ── Release record ───────────────────────────────────────────────────────────
Write-Step 'Writing the release record'
$manifestPath = Join-Path $versionDir 'jarvis-release.json'

$artifacts = @(
    @{ role = 'installer';     path = $stagedInstaller; published = $true }
    @{ role = 'app_binary';    path = $stagedExe }
    @{ role = 'server_bundle'; path = (Join-Path $versionDir 'index.js') }
    @{ role = 'mcp_stdio';     path = (Join-Path $versionDir 'mcp-stdio-server.js') }
    @{ role = 'claude_proxy';  path = (Join-Path $versionDir 'resources\claude_cli_proxy.py') }
    @{ role = 'go_models';     path = (Join-Path $versionDir 'resources\opencode_go_openai_models.json') }
)
foreach ($artifact in $artifacts) {
    if (-not (Test-Path -LiteralPath $artifact.path -PathType Leaf)) {
        Die "release artifact missing: $($artifact.role) at $($artifact.path)"
    }
}

$manifest = New-JarvisReleaseManifest `
    -Version $version `
    -Identity $identity `
    -Artifacts $artifacts `
    -Root $versionDir `
    -Extra @{
        prompts_tree_sha256  = $promptsTreeSha
        installer_name       = $installer.Name
        app_binary_name      = "$mainBinaryName.exe"
        signed               = $signed
        signature_status     = $(if ($signatureStatus) { $signatureStatus.status } else { $null })
        signature_subject    = $(if ($signatureStatus) { $signatureStatus.subject } else { $null })
    }

$written = Write-JarvisReleaseManifest -Manifest $manifest -Path $manifestPath
Write-Ok "release record -> $($written.manifest)"
Write-Ok "checksums       -> $($written.sums)"

Write-Host "`nRelease artifacts:" -ForegroundColor White
foreach ($file in $manifest.files) {
    Write-Host ("  {0,-14} {1}  {2}" -f $file.role, $file.sha256.Substring(0, 16), $file.name)
}

# GitHub Actions consumes these to find the artifacts it has to sign,
# smoke and publish. Emitting them here means the workflow never has to
# guess the version directory.
if ($env:GITHUB_OUTPUT) {
    @(
        "version=$version"
        "manifest_path=$($written.manifest)"
        "installer_path=$stagedInstaller"
        "release_dir=$versionDir"
    ) | Out-File -FilePath $env:GITHUB_OUTPUT -Append -Encoding utf8
}

Write-Host "`nRelease built. Sign it with:" -ForegroundColor Cyan
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\sign-installer.ps1 ``" -ForegroundColor Gray
Write-Host "    -InstallerPath `"$stagedInstaller`" ``" -ForegroundColor Gray
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\release-smoke.ps1 ``" -ForegroundColor Gray
Write-Host "    -ManifestPath `"$($written.manifest)`" -InstallerPath `"$stagedInstaller`"" -ForegroundColor Gray
exit 0
