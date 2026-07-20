<#
.SYNOPSIS
    Verifies that the deployed Jarvis runtime matches the repo HEAD.
    Checks git SHA, index.js/proxy hashes, prompts/ directory, manifest existence,
    and (if a server is actually listening) that the RUNNING process is
    serving that same build — not just that the files on disk look right.
#>
param(
    [string]$deployDir = "$env:USERPROFILE\OneDrive\Desktop",
    [string]$repoRoot = "C:\Projects\home-base-recovered",
    [string]$healthUrl = "http://localhost:19877/health",
    [string]$ExpectSha = ""
)

$ErrorActionPreference = 'Stop'

$manifestPath = Join-Path $deployDir '.jarvis-deploy-manifest.json'

if (-not (Test-Path $manifestPath)) {
    Write-Error "No deploy manifest found at $manifestPath. Run build-and-deploy.ps1 first."
    exit 1
}

$manifest = Get-Content $manifestPath | ConvertFrom-Json
$gitSha = git -C $repoRoot rev-parse HEAD
$gitDirty = -not [string]::IsNullOrWhiteSpace((git -C $repoRoot status --porcelain))
$sourceRoots = @(
    (Join-Path $repoRoot 'server-jarvis\src'),
    (Join-Path $repoRoot 'src-tauri\src'),
    (Join-Path $repoRoot 'src-ui\src'),
    (Join-Path $repoRoot 'scripts')
)
$sourceFiles = Get-ChildItem -LiteralPath $sourceRoots -Recurse -File | Sort-Object FullName
$sourceTreeText = foreach ($file in $sourceFiles) {
    $relative = $file.FullName.Substring($repoRoot.Length).TrimStart('\')
    "${relative}:$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
}
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $sourceTreeBytes = [Text.Encoding]::UTF8.GetBytes(($sourceTreeText -join "`n"))
    $sourceTreeSha256 = ([BitConverter]::ToString($sha256.ComputeHash($sourceTreeBytes))).Replace('-', '')
} finally {
    $sha256.Dispose()
}

if (-not [string]::IsNullOrWhiteSpace($ExpectSha) -and $ExpectSha -ne $gitSha) {
    Write-Error "EXPECTATION INVALID: requested SHA $ExpectSha != repo HEAD $gitSha"
    exit 1
}

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
if ([bool]$manifest.git_dirty -ne $gitDirty) {
    Write-Error "DEPLOY STALE: manifest git_dirty $($manifest.git_dirty) != current worktree dirty state $gitDirty"
    exit 1
}
if ($manifest.source_tree_sha256 -ne $sourceTreeSha256) {
    Write-Error "DEPLOY STALE: manifest source_tree_sha256 does not match the current source tree"
    exit 1
} else {
    Write-Host "Source tree digest matches manifest." -ForegroundColor Green
}

$metricsPath = Join-Path $deployDir 'automate_inference_metrics.py'
if (-not (Test-Path $metricsPath) -or
    (Get-FileHash $metricsPath -Algorithm SHA256).Hash -ne $manifest.inference_metrics_sha256) {
    Write-Error "DEPLOY INCOMPLETE: inference metrics script is missing or its hash differs from the manifest."
    exit 1
} else {
    Write-Host "inference metrics script hash matches manifest." -ForegroundColor Green
}

$proxyPath = Join-Path $deployDir 'resources\claude_cli_proxy.py'
if (-not (Test-Path $proxyPath) -or
    (Get-FileHash $proxyPath -Algorithm SHA256).Hash -ne $manifest.claude_proxy_sha256) {
    Write-Error "DEPLOY INCOMPLETE: Claude proxy script is missing or its hash differs from the manifest."
    exit 1
} else {
    Write-Host "Claude proxy script hash matches manifest." -ForegroundColor Green
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
        if ([bool]$health.git_dirty -ne [bool]$manifest.git_dirty) {
            Write-Error "DEPLOY MISMATCH: running server git_dirty $($health.git_dirty) != manifest git_dirty $($manifest.git_dirty)."
            exit 1
        }
        if ($health.source_tree_sha256 -ne $manifest.source_tree_sha256) {
            Write-Error "DEPLOY MISMATCH: running server source_tree_sha256 differs from manifest."
            exit 1
        }
        $listener = Get-NetTCPConnection -State Listen -LocalPort 19877 -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $listener) {
            Write-Error "DEPLOY MISMATCH: /health responded but no listener was found on port 19877."
            exit 1
        }
        $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
        $expectedIndex = [IO.Path]::GetFullPath((Join-Path $deployDir 'index.js'))
        $commandLine = [string]$listenerProcess.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine) -or
            $commandLine.IndexOf($expectedIndex, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Write-Error "DEPLOY MISMATCH: port 19877 is served by an unexpected command line: $commandLine"
            exit 1
        }
        Write-Host "Listener provenance matches deployed index.js (PID $($listener.OwningProcess))." -ForegroundColor Green
    }
}
