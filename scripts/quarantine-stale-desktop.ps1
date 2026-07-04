<#
.SYNOPSIS
    Quarantines the STALE Jarvis runtime copy on the classic Windows Desktop
    ($env:USERPROFILE\Desktop), which is a second, out-of-band deploy target
    that predates the OneDrive Desktop bundle build-and-deploy.ps1 maintains.

.DESCRIPTION
    Incident context (2026-07-03/04 diagnosis): the real deploy target is
    $env:USERPROFILE\OneDrive\Desktop (see build-and-deploy.ps1 / verify-deploy.ps1).
    A SECOND, unrelated copy of Jarvis.exe/index.js/prompts/ (plus .bak-* files
    and an old home-base.exe) sits on the CLASSIC Desktop from a June 28 manual
    drop that predates the visible-answer sanitizer and every fix since. That
    copy has no manifest and is never touched by build-and-deploy.ps1, so it
    silently resurrects fixed bugs if anyone double-clicks that icon instead of
    the OneDrive one. This script does not delete anything -- it moves the
    stale, exactly-named runtime files into a dated quarantine folder on the
    SAME classic Desktop, with a manifest.txt recording what moved and why, so
    the move is reversible and auditable.

    Only touches items that exist AND match the known-stale runtime file set:
        Jarvis.exe, Jarvis.exe.bak-*, index.js, index.js.bak-*,
        prompts\ (directory), home-base.exe, home-base.exe.bak-*

    Deliberately never touches (even if present):
        Jarvis-installer.exe, Jarvis_3.0.0_x64-setup.exe,
        home-base-installer.msi, Jarvis_debug.exe, or anything else on the
        Desktop (unrelated projects, screenshots, other apps, etc).

.PARAMETER DryRun
    Default. Print the plan (what would move, from where, to where) without
    touching the filesystem.

.PARAMETER Apply
    Actually perform the move. Mutually exclusive with the default dry-run
    behavior -- pass this explicitly to do real work.

.NOTES
    PowerShell 5.1 compatible: no &&, no ternary, no null-conditional.
    Idempotent: re-running after a successful -Apply finds nothing left to
    move (the candidate files no longer exist at the top level) and exits 0
    with a note, rather than erroring.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\quarantine-stale-desktop.ps1
    powershell -ExecutionPolicy Bypass -File scripts\quarantine-stale-desktop.ps1 -Apply
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg"     -ForegroundColor Green }
function Write-Info($msg) { Write-Host "  $msg" }
function Die($msg)        { Write-Host "`n[REFUSED] $msg" -ForegroundColor Red; exit 1 }

# Default to dry-run unless -Apply is explicitly passed. -DryRun is accepted
# for symmetry/clarity but is a no-op vs the default; -Apply is what flips
# the script into doing real work.
$isApply = [bool]$Apply
if (-not $isApply) { $DryRun = $true }

# ── Target: CLASSIC Desktop only. Never OneDrive Desktop. ────────────────────
$classicDesktop = Join-Path $env:USERPROFILE 'Desktop'
if (-not (Test-Path $classicDesktop -PathType Container)) {
    Die "Classic Desktop not found: $classicDesktop"
}
$oneDriveDesktop = Join-Path $env:USERPROFILE 'OneDrive\Desktop'
if ((Resolve-Path $classicDesktop).Path -eq (Resolve-Path $oneDriveDesktop -ErrorAction SilentlyContinue).Path) {
    Die "Classic Desktop resolved to the same path as OneDrive Desktop -- refusing to run (this script must never touch the live deploy target)."
}

Write-Host "Jarvis stale-Desktop quarantine" -ForegroundColor White
Write-Host "  classic Desktop : $classicDesktop"
Write-Host "  mode            : $(if ($isApply) { 'APPLY (will move files)' } else { 'DRY RUN (read-only)' })"

# ── Safety: refuse if anything is actually RUNNING from the classic Desktop ──
# Jarvis.exe / home-base.exe would show the classic Desktop in their own
# process Path. bun.exe never does (it always lives under %USERPROFILE%\.bun\
# bin\bun.exe) -- what matters for bun is which SCRIPT it was launched with,
# so that check inspects the command line instead of the exe path.
Write-Step 'Safety check: any Jarvis/home-base/bun process running from the classic Desktop?'
$classicDesktopNorm = $classicDesktop.TrimEnd('\')
$blockers = @()

Get-Process -Name 'Jarvis', 'home-base' -ErrorAction SilentlyContinue | ForEach-Object {
    $p = $_
    $procPath = $null
    try { $procPath = $p.Path } catch { $procPath = $null }
    if ($procPath -and $procPath.StartsWith($classicDesktopNorm, [System.StringComparison]::OrdinalIgnoreCase)) {
        $blockers += "PID $($p.Id) ($($p.ProcessName)) is running from $procPath"
    }
}

# bun.exe: check command line for a reference to the classic Desktop path
# (covers `bun <ClassicDesktop>\index.js` launches).
try {
    $bunProcs = Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue
    foreach ($bp in $bunProcs) {
        if ($bp.CommandLine -and $bp.CommandLine.ToLowerInvariant().Contains($classicDesktopNorm.ToLowerInvariant())) {
            $blockers += "PID $($bp.ProcessId) (bun.exe) command line references the classic Desktop: $($bp.CommandLine)"
        }
    }
} catch {
    Write-Info "[WARN] Could not query Win32_Process for bun.exe command lines ($($_.Exception.Message)) -- continuing with path-only checks."
}

if ($blockers.Count -gt 0) {
    Write-Host ""
    $blockers | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Die "A Jarvis/home-base/bun process appears to be running from the classic Desktop. Close it first, then re-run this script. Refusing to quarantine files that may be in use."
}
Write-Ok 'no Jarvis/home-base/bun process is running from the classic Desktop'

# ── Candidate set: exact names + .bak-* / directory patterns only ────────────
# Explicitly NOT included (must survive untouched even though they live in
# the same folder): Jarvis-installer.exe, Jarvis_3.0.0_x64-setup.exe,
# home-base-installer.msi, Jarvis_debug.exe, and everything else on the Desktop.
$filePatterns = @('Jarvis.exe', 'Jarvis.exe.bak-*', 'index.js', 'index.js.bak-*', 'home-base.exe', 'home-base.exe.bak-*')
$dirNames     = @('prompts')

$foundFiles = @()
foreach ($pattern in $filePatterns) {
    $foundFiles += Get-ChildItem -Path $classicDesktop -Filter $pattern -File -ErrorAction SilentlyContinue
}
$foundDirs = @()
foreach ($name in $dirNames) {
    $candidate = Join-Path $classicDesktop $name
    if (Test-Path $candidate -PathType Container) {
        $foundDirs += Get-Item $candidate
    }
}

$allItems = @()
$allItems += $foundFiles
$allItems += $foundDirs

if ($allItems.Count -eq 0) {
    Write-Step 'Nothing to quarantine'
    Write-Ok "no stale Jarvis runtime files found on $classicDesktop -- already clean (idempotent no-op)."
    exit 0
}

Write-Step 'Plan'
$quarantineDirName = "_jarvis-stale-quarantine-$(Get-Date -Format 'yyyyMMdd')"
$quarantineDir = Join-Path $classicDesktop $quarantineDirName
Write-Info "quarantine folder: $quarantineDir"
foreach ($item in $allItems) {
    $kind = if ($item.PSIsContainer) { 'dir ' } else { 'file' }
    Write-Info "  [$kind] $($item.Name)  ->  $quarantineDirName\$($item.Name)"
}

if (-not $isApply) {
    Write-Host "`n[DRY RUN] No files were moved. Re-run with -Apply to perform this move." -ForegroundColor Yellow
    exit 0
}

# ── Apply: move items + write manifest ───────────────────────────────────────
Write-Step "Applying: moving $($allItems.Count) item(s) into $quarantineDirName"
if (-not (Test-Path $quarantineDir)) {
    New-Item -ItemType Directory -Path $quarantineDir -Force | Out-Null
}

$manifestLines = @()
$manifestLines += "Jarvis stale-Desktop quarantine"
$manifestLines += "Run at:      $(Get-Date -Format 'o')"
$manifestLines += "Source:      $classicDesktop"
$manifestLines += "Quarantine:  $quarantineDir"
$manifestLines += ""
$manifestLines += "Incident reference:"
$manifestLines += "  A stale June-28 Jarvis runtime (Jarvis.exe/index.js/prompts, plus"
$manifestLines += "  .bak-* variants and an old home-base.exe) was found on the classic"
$manifestLines += "  Desktop, predating the visible-answer sanitizer and every fix landed"
$manifestLines += "  since. Diagnosed 2026-07-03/04 while auditing deploy hygiene (Task 8)."
$manifestLines += "  The live deploy target is $env:USERPROFILE\OneDrive\Desktop, maintained"
$manifestLines += "  by scripts\build-and-deploy.ps1. This classic-Desktop copy was never"
$manifestLines += "  touched by that script and had no deploy manifest of its own."
$manifestLines += ""
$manifestLines += "Items moved:"

foreach ($item in $allItems) {
    $dst = Join-Path $quarantineDir $item.Name
    $kind = if ($item.PSIsContainer) { 'dir ' } else { 'file' }
    Move-Item -Path $item.FullName -Destination $dst -Force
    Write-Ok "$($item.Name) -> $quarantineDirName\$($item.Name)"
    $manifestLines += ("  [{0}] {1}  (from {2})" -f $kind, $item.Name, $item.FullName)
}

$manifestPath = Join-Path $quarantineDir 'manifest.txt'
$manifestLines | Out-File -FilePath $manifestPath -Encoding utf8
Write-Ok "manifest -> $manifestPath"

Write-Host "`nDONE. $($allItems.Count) item(s) quarantined to $quarantineDir" -ForegroundColor Green
