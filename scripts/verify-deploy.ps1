<#
.SYNOPSIS
    Verifies that the deployed Jarvis runtime matches the repo HEAD.
    Checks git SHA, index.js/tokenizer/proxy hashes, prompts/ directory, manifest existence,
    the NSIS installer hash when an installer is present (skipped cleanly when
    absent), and (if a server is actually listening) that the RUNNING process is
    serving that same build — not just that the files on disk look right.
#>
param(
    [string]$deployDir = "$env:USERPROFILE\OneDrive\Desktop",
    [string]$repoRoot,
    [string]$healthUrl = "http://localhost:19877/health",
    [string]$ExpectSha = ""
)

$ErrorActionPreference = 'Stop'

# ── repoRoot default ──
# There is no hardcoded repo root: a copied verifier (e.g. a worktree copy of
# scripts/) must inspect the worktree it ships in, so the default is the fully
# resolved absolute parent directory of this script's location. It is resolved
# here in the body rather than as a param default because Windows PowerShell
# 5.1 does not populate $PSScriptRoot inside a parameter default when the
# script is invoked via `powershell -File` (PowerShell/PowerShell#4688), and
# `powershell -File scripts\verify-deploy.ps1` is the documented invocation.
# An explicit -repoRoot always overrides the derived default.
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

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

# The offline tokenizer is a shipped artifact in its own right: the server
# lazily requires it, so a missing or substituted copy breaks token counting
# without failing index.js. Verify it exactly like the server bundle.
$tokenizerPath = Join-Path $deployDir 'tokenizer.cjs'
if (-not (Test-Path $tokenizerPath) -or
    (Get-FileHash $tokenizerPath -Algorithm SHA256).Hash -ne $manifest.tokenizer_js_sha256) {
    Write-Error "DEPLOY INCOMPLETE: offline tokenizer bundle tokenizer.cjs is missing or its hash differs from the manifest."
    exit 1
} else {
    Write-Host "tokenizer.cjs hash matches manifest." -ForegroundColor Green
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

$proxyModelsPath = Join-Path $deployDir 'resources\opencode_go_openai_models.json'
if (-not (Test-Path $proxyModelsPath)) {
    Write-Error "DEPLOY INCOMPLETE: OpenCode Go proxy model list is missing."
    exit 1
}
if ($manifest.opencode_go_models_sha256 -and
    (Get-FileHash $proxyModelsPath -Algorithm SHA256).Hash -ne $manifest.opencode_go_models_sha256) {
    Write-Error "DEPLOY INCOMPLETE: OpenCode Go proxy model list hash differs from the manifest."
    exit 1
} else {
    Write-Host "OpenCode Go proxy model list present." -ForegroundColor Green
}

if (-not (Test-Path (Join-Path $deployDir 'prompts'))) {
    Write-Error "DEPLOY INCOMPLETE: prompts/ directory missing!"
    exit 1
} else {
    Write-Host "prompts/ directory exists." -ForegroundColor Green
}

# ── NSIS installer provenance (optional) ──
# A release may also ship an NSIS installer next to the runtime
# (build-windows.ps1 / build-and-deploy.ps1 copy it as Jarvis-installer.exe;
# Tauri's default bundle name is Jarvis_<version>_x64-setup.exe). When one is
# present, verify its SHA-256 against the manifest and confirm it belongs to
# the same git SHA the rest of the deploy came from. When no installer exists,
# skip with a clear message instead of failing — the runtime checks above
# still stand.
$installerCandidates = @(
    (Join-Path $deployDir 'Jarvis-installer.exe'),
    (Join-Path $deployDir 'Jarvis-installer.msi')
)
$installerCandidates += @(
    Get-ChildItem -Path $deployDir -Filter 'Jarvis_*_x64-setup.exe' -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName }
)
$installerPath = $installerCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -First 1

if (-not $installerPath) {
    Write-Host "No NSIS installer present in $deployDir - skipping installer provenance check." -ForegroundColor Yellow
} elseif ([string]::IsNullOrWhiteSpace($manifest.installer_sha256)) {
    # Older manifests predate installer provenance. Don't fail a deploy whose
    # runtime is otherwise verified just because it shipped an unrecorded
    # installer; say so plainly instead.
    Write-Host "[WARN] Installer $([IO.Path]::GetFileName($installerPath)) is present but the manifest has no installer_sha256 - cannot verify it." -ForegroundColor Yellow
} else {
    $installerSha = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
    if ($installerSha -ne $manifest.installer_sha256) {
        Write-Error "DEPLOY INCOMPLETE: installer $([IO.Path]::GetFileName($installerPath)) SHA-256 $installerSha != manifest installer_sha256 $($manifest.installer_sha256)."
        exit 1
    } else {
        Write-Host "NSIS installer hash matches manifest (git_sha $($manifest.git_sha))." -ForegroundColor Green
    }
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
