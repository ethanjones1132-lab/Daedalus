<#
.SYNOPSIS
    Verifies that the deployed Jarvis runtime matches the repo HEAD.
    Checks git SHA, index.js hash, prompts/ directory, and manifest existence.
#>
param(
    [string]$deployDir = "$env:USERPROFILE\OneDrive\Desktop",
    [string]$repoRoot = "C:\Projects\home-base-recovered"
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