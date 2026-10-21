<#
.SYNOPSIS
    Signs the Jarvis NSIS installer with an Authenticode certificate and
    verifies the result.

.DESCRIPTION
    "Signed Windows installer v1.0" is the north star, and nothing in the
    tree signs today. Tauri can sign a bundle when
    `bundle.windows.certificateThumbprint` is set in tauri.conf.json, but
    that requires the certificate to already be in the Windows certificate
    store, and it is a build-time decision that cannot be expressed
    "sign if a secret happens to be present". This script is the CI-shaped
    alternative: it is run AFTER the bundle is built, it signs when a
    certificate is reachable, and it FAILS LOUDLY when signing was asked
    for but could not happen.

    That last property is the point. A release pipeline that quietly
    publishes an unsigned installer under a release titled "signed" is
    worse than no pipeline at all: it manufactures the trust the artifact
    does not have.

    The signing logic itself lives in scripts/lib/release-common.ps1, which
    release-build.ps1 also uses so that a release is signed before its
    record is written -- signing changes the bytes, so a record written
    before signing would describe an installer that no longer exists.

    The same fact applies to an installer that was built first and signed
    here afterwards: it already has a release record, written while the
    bytes were unsigned. After signing, this script refreshes the record
    entry that names this installer and regenerates SHA256SUMS.txt through
    the shared writer, so the published hash and the downloadable checksums
    describe the artifact that actually ships. The record's version, commit
    and every unrelated artifact are left alone, and a record that is
    missing, malformed or about a different installer is never silently
    reported as healthy.

.PARAMETER InstallerPath
    The NSIS installer to sign.

.PARAMETER Thumbprint
    SHA-1 thumbprint of a code-signing certificate already present in the
    Windows certificate store.

.PARAMETER PfxPath
    Path to a .pfx file to import into the current user's store before
    signing. Used when the certificate is supplied as a CI secret rather
    than pre-installed.

.PARAMETER PfxPassword
    Password for the .pfx. Prefer $env:JARVIS_SIGNING_PFX_PASSWORD over
    passing it on the command line, where it is visible in the process
    table.

.PARAMETER TimestampUrl
    RFC 3161 timestamp authority. Timestamping is what keeps a signature
    valid after the certificate expires, so it is not optional in practice.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\sign-installer.ps1 `
        -InstallerPath src-tauri\target\release\bundle\nsis\Jarvis_1.0.0_x64-setup.exe `
        -Thumbprint $env:JARVIS_SIGNING_THUMBPRINT
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [string]$Thumbprint = $env:JARVIS_SIGNING_THUMBPRINT,

    [string]$PfxPath = $env:JARVIS_SIGNING_PFX_PATH,

    [string]$PfxPassword = $env:JARVIS_SIGNING_PFX_PASSWORD,

    [string]$TimestampUrl = 'http://timestamp.digicert.com',

    # A signing-service command (Azure Artifact Signing, SignPath, ...).
    # Invoked with the artifact path as its only argument. The provider
    # signs the artifact itself; no private key ever reaches this machine.
    [string]$Command = $env:JARVIS_SIGNING_COMMAND,

    # Verify an existing signature without attempting to sign.
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Die($msg)        { Write-Host "`n[FAILED] $msg" -ForegroundColor Red; exit 1 }

# ── Entry point ──────────────────────────────────────────────────────────────

$resolvedInstaller = $null
if (-not [string]::IsNullOrWhiteSpace($InstallerPath)) {
    $resolvedInstaller = Resolve-Path -LiteralPath $InstallerPath -ErrorAction SilentlyContinue
}
if (-not $resolvedInstaller) {
    Die "installer not found: $InstallerPath"
}

if ($VerifyOnly) {
    $status = Get-JarvisAuthenticodeStatus -Path $resolvedInstaller.Path
    Write-Ok "status:     $($status.status)"
    Write-Ok "subject:    $($status.subject)"
    Write-Ok "issuer:     $($status.issuer)"
    Write-Ok "thumbprint: $($status.thumbprint)"
    if ($status.status -ne 'Valid') {
        Die "signature is not valid: $($status.status)"
    }
    Write-Host "`nSignature verification passed." -ForegroundColor Green
    exit 0
}

try {
    Write-Step 'Resolving the signing configuration'
    $configuration = Resolve-JarvisSigningConfiguration `
        -Thumbprint $Thumbprint `
        -PfxPath $PfxPath `
        -PfxPassword $PfxPassword `
        -TimestampUrl $TimestampUrl `
        -Command $Command
    if ($configuration.mode -eq 'command') {
        Write-Ok "signing service command: $($configuration.command)"
    } else {
        Write-Ok "thumbprint $($configuration.thumbprint)"
    }

    if ($configuration.pfx_path) {
        Write-Step 'Importing the signing certificate'
        $imported = Import-JarvisSigningCertificate -PfxPath $configuration.pfx_path -Password $PfxPassword
        Write-Ok "imported $($imported.Thumbprint) into Cert:\CurrentUser\My"
        $configuration.thumbprint = $imported.Thumbprint.ToUpperInvariant()
    }

    Write-Step "Signing $($resolvedInstaller.Path)"
    $status = Invoke-JarvisInstallerSigning `
        -InstallerPath $resolvedInstaller.Path `
        -Configuration $configuration
    Write-Ok "signature status: $($status.status)"
    Write-Ok "subject: $($status.subject)"
    Write-Ok "issuer:  $($status.issuer)"

    Write-Step 'Refreshing the release record'
    try {
        $refresh = Update-JarvisReleaseInstallerRecord `
            -InstallerPath $resolvedInstaller.Path `
            -Signature $status
    } catch {
        Die "the installer was signed, but its release record could not be refreshed: $($_.Exception.Message)"
    }
    if ($refresh.refreshed) {
        Write-Ok "release record: $($refresh.manifest)"
        Write-Ok "checksums:      $($refresh.sums)"
        Write-Ok "sha256:         $($refresh.sha256)"
    } else {
        # A bare installer signed on its own has no record to refresh, and
        # inventing one would claim a build identity this script cannot know.
        Write-Warn "no release record to refresh: $($refresh.reason)"
        Write-Warn 'signing did not create one; run release-build.ps1 for a recorded release'
    }

    Write-Host "`nInstaller signed and verified." -ForegroundColor Green
    Write-Ok "sha256: $((Get-JarvisFileSha256 -Path $resolvedInstaller.Path))"
    exit 0
} catch {
    Die $_.Exception.Message
}
