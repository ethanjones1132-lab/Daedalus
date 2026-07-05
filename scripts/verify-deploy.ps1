<#
.SYNOPSIS
    Verifies that the deployed Jarvis runtime matches the repo HEAD.
    Checks git SHA, index.js hash, prompts/ directory, manifest existence,
    and (if a server is actually listening) that the RUNNING process is
    serving that same build — not just that the files on disk look right.
#>
param(
    [string]$deployDir = "$env:USERPROFILE\OneDrive\Desktop",
    [string]$repoRoot = "C:\Projects\home-base-recovered",
    [string]$healthUrl = "http://localhost:19877/health"
)

$ErrorActionPreference = 'Stop'

$manifestPath = Join-Path $deployDir '.jarvis-deploy-manifest.json'

if (-not (Test-Path $manifestPath)) {
    Write-Error "No deploy manifest found at $manifestPath. Run build-and-deploy.ps1 first."
    exit 1
}

$manifest = Get-Content $manifestPath | ConvertFrom-Json
$gitSha = git -C $repoRoot rev-parse HEAD

if ($manifest.git_sha -ne $gitSha) {
    Write-Error "DEPLOY STALE: manifest git_sha $($manifest.git_sha) != repo HEAD $gitSha"
    exit 1
} else {
    Write-Host "Deploy matches repo HEAD." -ForegroundColor Green
}

if ((Get-FileHash "$deployDir\index.js" -Algorithm SHA256).Hash -ne $manifest.index_js_sha256) {
    Write-Error "DEPLOY CORRUPT: index.js hash mismatch!"
    exit 1
} else {
    Write-Host "index.js hash matches manifest." -ForegroundColor Green
}

if (-not (Test-Path (Join-Path $deployDir 'prompts'))) {
    Write-Error "DEPLOY INCOMPLETE: prompts/ directory missing!"
    exit 1
} else {
    Write-Host "prompts/ directory exists." -ForegroundColor Green
}

Write-Host "Deploy verification passed." -ForegroundColor Green

# ── Running-server check ──
# Everything above only proves the FILES on disk match repo HEAD. It says
# nothing about which build is actually answering requests right now — that
# gap is exactly how a stale bundle served leaked-JSON bugs for days while
# the repo already had the fix (2026-07 incident). /health now reports
# git_sha (baked in at build time via `bun build --define`, see
# build-and-deploy.ps1 Stage 1), so cross-check it against the manifest.
Write-Host "`nChecking running server at $healthUrl ..."
$health = $null
try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3
} catch {
    Write-Host "[WARN] No server reachable at $healthUrl - skipping running-build check (file verification above still stands)." -ForegroundColor Yellow
}

if ($null -ne $health) {
    $runningSha = $health.git_sha
    if ([string]::IsNullOrEmpty($runningSha)) {
        # A reachable server whose /health has no git_sha field predates the
        # provenance change entirely — that is a STALE build by definition
        # (every post-provenance bundle reports one). Treat it like a
        # mismatch, not a warn: this exact shape is the 2026-07 incident.
        Write-Error "DEPLOY MISMATCH: running server /health has no git_sha field - it predates the provenance change and cannot be the build just verified on disk. Remedy: restart Jarvis (relaunch the deployed Jarvis.exe / index.js), then verify again."
        exit 1
    } elseif ($runningSha -eq 'dev') {
        Write-Host "[WARN] Running server reports git_sha 'dev' - it is running from source (bun run), not the deployed bundle. File verification above does not describe what's actually serving requests." -ForegroundColor Yellow
    } elseif ($runningSha -ne $manifest.git_sha) {
        Write-Error "DEPLOY MISMATCH: running server git_sha $runningSha != manifest git_sha $($manifest.git_sha). The running server is a different build than the one just deployed/verified on disk. Remedy: restart Jarvis (relaunch the deployed Jarvis.exe / index.js) or re-run build-and-deploy.ps1, then verify again."
        exit 1
    } else {
        Write-Host "Running server git_sha matches manifest ($runningSha)." -ForegroundColor Green
    }
}
