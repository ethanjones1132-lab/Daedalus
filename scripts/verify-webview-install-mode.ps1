<#
.SYNOPSIS
    Check the installer states which WebView2 mode it ships, and that the
    release record agrees.

.DESCRIPTION
    Tauri's bundle.windows.webviewInstallMode decides what the NSIS installer
    does about the WebView2 runtime. Absent, Tauri silently uses its implicit
    default (downloadBootstrapper), so neither the config nor the release
    record says how a machine without WebView2 is provisioned. This check
    makes both explicit:

      1. reads src-tauri/tauri.conf.json and fails, naming the file and
         bundle.windows.webviewInstallMode, when the key is missing or left
         at Tauri's implicit default;
      2. reads the release record the pipeline already writes
         (dist/release/<version>/jarvis-release.json) and fails when it does
         not name the installer and the WebView2 mode the config selected.

    A source-only run has no release record and no installer, so step 2
    reports SKIP rather than failing. A record that exists but is incomplete
    is a failure, not a skip: that is the release whose provenance is wrong.

    Exit codes: 0 when the config is explicit and any record agrees (or there
    is no record to check), 1 otherwise.

.PARAMETER RepoRoot
    Repository root. Defaults to the parent of this script's directory.

.PARAMETER ConfigPath
    The tauri.conf.json to read. Defaults to <repo>/src-tauri/tauri.conf.json.
    Pass a copy to check a candidate config without touching the tree.

.PARAMETER ManifestPath
    The release record to check. Defaults to the newest jarvis-release.json
    under -ReleaseRoot, or jarvis-release.json beside -InstallerPath.

.PARAMETER ReleaseRoot
    Where the release pipeline writes records. Defaults to <repo>/dist/release.

.PARAMETER InstallerPath
    Optional built installer. When given, the record must name this exact
    file; a missing record then fails instead of skipping.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-webview-install-mode.ps1

.EXAMPLE
    # negative check: a config without the key must fail (exit 1)
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-webview-install-mode.ps1 `
        -ConfigPath "$env:TEMP\tauri-no-webview.json"
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$ConfigPath = '',
    [string]$ManifestPath = '',
    [string]$ReleaseRoot = '',
    [string]$InstallerPath = ''
)

$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
    Write-Host "[FAIL] repo_root_missing:$RepoRoot" -ForegroundColor Red
    exit 1
}
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $RepoRoot 'src-tauri\tauri.conf.json'
}
if (-not [IO.Path]::IsPathRooted($ConfigPath)) {
    $ConfigPath = Join-Path (Get-Location).Path $ConfigPath
}
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)

if (-not [string]::IsNullOrWhiteSpace($InstallerPath)) {
    if (-not [IO.Path]::IsPathRooted($InstallerPath)) {
        $InstallerPath = Join-Path (Get-Location).Path $InstallerPath
    }
    $InstallerPath = [IO.Path]::GetFullPath($InstallerPath)
}

# ── 1. The config must state the mode ────────────────────────────────────────
$config = Get-JarvisWebViewInstallMode -ConfigPath $ConfigPath
if (-not $config.ok) {
    Write-Host "[FAIL] $($config.reason)" -ForegroundColor Red
    Write-Host "       $ConfigPath" -ForegroundColor Red
    Write-Host "       Set $($config.key) explicitly, e.g. { `"type`": `"embedBootstrapper`" }." -ForegroundColor Red
    exit 1
}
Write-Host "[ OK ] $ConfigPath" -ForegroundColor Green
Write-Host "       $($config.key) = $($config.mode)" -ForegroundColor Green

# ── 2. The release record, when there is one, must agree ─────────────────────
$sourceOnly = $false
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    if (-not [string]::IsNullOrWhiteSpace($InstallerPath)) {
        # A built installer with no record beside it is a provenance hole, so
        # say so by failing on the missing record instead of skipping.
        $ManifestPath = Join-Path (Split-Path -Parent $InstallerPath) 'jarvis-release.json'
    } else {
        if ([string]::IsNullOrWhiteSpace($ReleaseRoot)) {
            $ReleaseRoot = Join-Path $RepoRoot 'dist\release'
        }
        $record = $null
        if (Test-Path -LiteralPath $ReleaseRoot -PathType Container) {
            $record = Get-ChildItem -Path $ReleaseRoot -Filter 'jarvis-release.json' -Recurse -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTimeUtc -Descending |
                Select-Object -First 1
        }
        if (-not $record) {
            $sourceOnly = $true
        } else {
            $ManifestPath = $record.FullName
        }
    }
}

if ($sourceOnly) {
    Write-Host "[SKIP] $ReleaseRoot has no release record (source-only run; no installer to check)" -ForegroundColor Yellow
    exit 0
}

if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    Write-Host "[FAIL] webview_install_mode_manifest_missing:$ManifestPath" -ForegroundColor Red
    exit 1
}

try {
    $manifest = Read-JarvisReleaseManifest -Path $ManifestPath
} catch {
    Write-Host "[FAIL] release_manifest_malformed:${ManifestPath}:$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

$record = Test-JarvisWebViewInstallModeRecorded `
    -Manifest $manifest `
    -ManifestPath $ManifestPath `
    -ExpectedMode $config.mode `
    -InstallerPath $InstallerPath

if (-not $record.ok) {
    Write-Host "[FAIL] $($record.reason)" -ForegroundColor Red
    Write-Host "       $ManifestPath" -ForegroundColor Red
    Write-Host "       Rebuild with scripts\release-build.ps1 so the record states webview_install_mode." -ForegroundColor Red
    exit 1
}

Write-Host "[ OK ] $ManifestPath" -ForegroundColor Green
Write-Host "       installer $($record.installer_name) ships $($record.mode)" -ForegroundColor Green
exit 0
