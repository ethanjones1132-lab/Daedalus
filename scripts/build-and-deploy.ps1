<#
.SYNOPSIS
    One-shot rebuild of the entire Jarvis stack (server bundle + UI + Rust app),
    then deploy the runtime to the OneDrive Desktop.

.DESCRIPTION
    Stages, fail-fast (stops on the first error):
      1. Server  -> bun build server-jarvis/src/index.ts  -> server-jarvis/dist/index.js
      2. UI      -> bun run build (tsc -b && vite build)   -> src-ui/dist
      3. Rust    -> cargo build --release                  -> src-tauri/target/release/home-base.exe
                    (Tauri embeds src-ui/dist into the binary at compile time, so
                     the UI MUST be built before this step — stage 2 guarantees it.)
      4. Deploy  -> copy the freshly built artifacts to the OneDrive Desktop:
                      home-base.exe  -> <Desktop>\Jarvis.exe   (and \home-base.exe)
                      dist/index.js  -> <Desktop>\index.js
                      src/prompts/   -> <Desktop>\prompts\
                    The Bun server reads prompts/*.md from disk at runtime (they are
                    NOT compiled into index.js), so index.js + prompts/ must ship
                    alongside the exe or the orchestrator chat path breaks with
                    "Prompt file not found: coordinator.md".

.PARAMETER SkipDeploy
    Build everything but do not copy to the Desktop.

.PARAMETER RestartServer
    After deploying, launch the freshly deployed bundle (bun <Desktop>\index.js)
    on port 19877 and wait for it to report healthy, so the next chat prompt
    streams immediately without relaunching the app. stdout/stderr are always
    captured to timestamped files under %USERPROFILE%\.openclaw\jarvis\logs\.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1
    powershell -ExecutionPolicy Bypass -File scripts\build-and-deploy.ps1 -RestartServer
#>
[CmdletBinding()]
param(
    [switch]$SkipDeploy,
    [switch]$RestartServer
)

$ErrorActionPreference = 'Stop'
$startedAt = Get-Date

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg"     -ForegroundColor Green }
function Die($msg)        { Write-Host "`n[FAILED] $msg" -ForegroundColor Red; exit 1 }

# ── Paths ────────────────────────────────────────────────────────────────────
$repo       = Split-Path -Parent $PSScriptRoot
$serverDir  = Join-Path $repo 'server-jarvis'
$uiDir      = Join-Path $repo 'src-ui'
$tauriDir   = Join-Path $repo 'src-tauri'
$exeOut     = Join-Path $repo 'src-tauri\target\release\home-base.exe'
$distJs     = Join-Path $repo 'server-jarvis\dist\index.js'
$promptsSrc = Join-Path $repo 'server-jarvis\src\prompts'
$metricsScript = Join-Path $repo 'automate_inference_metrics.py'
$desktop    = Join-Path $env:USERPROFILE 'OneDrive\Desktop'

# ── Locate toolchain (prefer PATH, fall back to standard install dirs) ────────
function Resolve-Tool($name, $fallback) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    if (Test-Path $fallback) { return $fallback }
    Die "$name not found on PATH or at $fallback"
}
$bun   = Resolve-Tool 'bun'   (Join-Path $env:USERPROFILE '.bun\bin\bun.exe')
$cargo = Resolve-Tool 'cargo' (Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe')

Write-Host "Jarvis one-shot build + deploy" -ForegroundColor White
Write-Host "  repo : $repo"
Write-Host "  bun  : $bun"
Write-Host "  cargo: $cargo"

# ── Stage 1: server bundle ───────────────────────────────────────────────────
Write-Step 'Stage 1/4 - Building server bundle (bun)'
# Bake the build identity into the bundle so /health can report WHICH build is
# actually serving (2026-07 incident: a stale deploy silently served
# leaked-JSON bugs for days because /health only ever returned the static
# "3.0.0" version string). bun's --define replaces process.env.<NAME> member
# expressions at bundle time (verified: `bun build --define
# "process.env.X=\"...\""` folds the literal into the output, and running the
# unbundled source with `bun run` still reads the live env var / "dev"
# fallback, so source runs are unaffected).
#
# QUOTING TRAP (PS 5.1 native-arg passing): the inner quotes around the value
# MUST be backslash-escaped (\`") not merely backtick-escaped (`"). A bare
# backtick-escaped quote puts a literal " in the PowerShell string, but PS 5.1
# does not re-escape embedded quotes when it rebuilds the command line for a
# native exe, so bun's argv loses them and folds the value as a BARE JS
# identifier: `var SHA = abc123 ?? "dev"` -> ReferenceError at module load ->
# the deployed server fails to boot. bun build still exits 0, so the error
# gate below cannot catch it. \`" survives to bun as \" and folds correctly
# to a quoted string literal (verified both ways via scratch repro 2026-07-04).
$buildGitSha = (git -C $repo rev-parse HEAD)
$buildBuiltAt = (Get-Date -Format 'o')
$buildGitDirty = -not [string]::IsNullOrWhiteSpace((git -C $repo status --porcelain))
$sourceRoots = @(
    (Join-Path $repo 'server-jarvis\src'),
    (Join-Path $repo 'src-tauri\src'),
    (Join-Path $repo 'src-ui\src'),
    (Join-Path $repo 'scripts')
)
$sourceFiles = Get-ChildItem -LiteralPath $sourceRoots -Recurse -File | Sort-Object FullName
$sourceTreeText = foreach ($file in $sourceFiles) {
    $relative = $file.FullName.Substring($repo.Length).TrimStart('\')
    "${relative}:$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
}
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $sourceTreeBytes = [Text.Encoding]::UTF8.GetBytes(($sourceTreeText -join "`n"))
    $sourceTreeSha256 = ([BitConverter]::ToString($sha256.ComputeHash($sourceTreeBytes))).Replace('-', '')
} finally {
    $sha256.Dispose()
}
Push-Location $serverDir
try {
    & $bun build ./src/index.ts --outdir ./dist --target bun `
        --define "process.env.JARVIS_GIT_SHA=\`"$buildGitSha\`"" `
        --define "process.env.JARVIS_BUILT_AT=\`"$buildBuiltAt\`"" `
        --define "process.env.JARVIS_GIT_DIRTY=\`"$($buildGitDirty.ToString().ToLowerInvariant())\`"" `
        --define "process.env.JARVIS_SOURCE_TREE_SHA256=\`"$sourceTreeSha256\`""
    if ($LASTEXITCODE -ne 0) { Die 'server bundle build failed' }
} finally { Pop-Location }
if (-not (Test-Path $distJs)) { Die "server bundle not produced at $distJs" }
Write-Ok "server bundle -> $distJs"

# ── Stage 2: UI ──────────────────────────────────────────────────────────────
Write-Step 'Stage 2/4 - Building UI (bun run build)'
Push-Location $uiDir
try {
    & $bun run build
    if ($LASTEXITCODE -ne 0) { Die 'UI build failed' }
} finally { Pop-Location }
Write-Ok 'UI -> src-ui/dist'

# ── Stage 3: Rust app ────────────────────────────────────────────────────────
Write-Step 'Stage 3/4 - Building Rust app (cargo build --release)'
Push-Location $tauriDir
try {
    & $cargo build --release
    if ($LASTEXITCODE -ne 0) { Die 'cargo build --release failed' }
} finally { Pop-Location }
if (-not (Test-Path $exeOut)) { Die "exe not produced at $exeOut" }
$exeInfo = Get-Item $exeOut
Write-Ok ("exe -> {0} ({1:N1} MB, {2})" -f $exeOut, ($exeInfo.Length / 1MB), $exeInfo.LastWriteTime)

# ── Stage 4: deploy ──────────────────────────────────────────────────────────
if ($SkipDeploy) {
    Write-Host "`n[SkipDeploy] Build complete; not copying to Desktop." -ForegroundColor Yellow
    exit 0
}

Write-Step "Stage 4/4 - Deploying to $desktop"
if (-not (Test-Path $desktop)) { Die "OneDrive Desktop not found: $desktop" }
if (-not (Test-Path $promptsSrc -PathType Container)) {
    Die "Jarvis prompt source not found: $promptsSrc"
}
if (-not (Test-Path $metricsScript -PathType Leaf)) {
    Die "Inference metrics script not found: $metricsScript"
}

# Release file locks: stop the running app and any Bun server bound to 19877
# (the deployed bundle locks <Desktop>\index.js while running).
Get-Process 'Jarvis','home-base' -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  stopping running process $($_.ProcessName) (pid $($_.Id))"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
try {
    Get-NetTCPConnection -State Listen -LocalPort 19877 -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "  stopping server on :19877 (pid $($_.OwningProcess))"
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
} catch {}
Start-Sleep -Seconds 1

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
function Deploy-File($src, $dstName) {
    $dst = Join-Path $desktop $dstName
    if (Test-Path $dst) { Copy-Item $dst "$dst.bak-$ts" -Force }
    Copy-Item $src $dst -Force
    Write-Ok "$dstName"
}

Deploy-File $exeOut 'Jarvis.exe'
Deploy-File $exeOut 'home-base.exe'
Deploy-File $distJs 'index.js'
Deploy-File $metricsScript 'automate_inference_metrics.py'

# prompts/ is a directory — replace wholesale (back up the old one first)
$promptsDst = Join-Path $desktop 'prompts'
if (Test-Path $promptsDst) {
    Move-Item $promptsDst "$promptsDst.bak-$ts" -Force
}
Copy-Item $promptsSrc $promptsDst -Recurse -Force
Write-Ok 'prompts/'

# ── Deploy manifest ──
# Reuse $buildGitSha (captured before Stage 1) rather than re-running
# `git rev-parse HEAD` here, so the manifest's git_sha is guaranteed to match
# the SHA actually baked into index.js via --define, even in the (unlikely)
# case HEAD moves mid-run.
$manifest = @{
    git_sha = $buildGitSha
    git_dirty = $buildGitDirty
    source_tree_sha256 = $sourceTreeSha256
    index_js_sha256 = (Get-FileHash "$desktop\index.js" -Algorithm SHA256).Hash
    inference_metrics_sha256 = (Get-FileHash "$desktop\automate_inference_metrics.py" -Algorithm SHA256).Hash
    exe_mtime = (Get-Item "$desktop\Jarvis.exe" -ErrorAction SilentlyContinue).LastWriteTimeUtc.ToString("o")
    prompts_tree_sha256 = (git -C $repo ls-tree HEAD server-jarvis/src/prompts | Select-Object -First 1).Split()[2]
    deployed_at = (Get-Date -Format "o")
} | ConvertTo-Json -Depth 2
$manifest | Out-File "$desktop\.jarvis-deploy-manifest.json" -Encoding utf8
Write-Ok "deploy manifest -> .jarvis-deploy-manifest.json"

# ── Optional: relaunch the server so the next prompt streams immediately ──────
if ($RestartServer) {
    Write-Step 'Restarting Jarvis server (bun <Desktop>\index.js on :19877)'
    $deployedJs = Join-Path $desktop 'index.js'
    # Server stdout/stderr previously went nowhere (Start-Process -WindowStyle
    # Hidden with no redirection silently discards it) — that gap made a real
    # production incident (2026-07-01 empty-completion cascade bug) much
    # harder to diagnose than it should have been. Always capture output now,
    # timestamped per restart so history survives across restarts instead of
    # being overwritten.
    $logsDir = Join-Path $env:USERPROFILE '.openclaw\jarvis\logs'
    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Force -Path $logsDir | Out-Null }
    $logOut = Join-Path $logsDir "server-stdout-$ts.log"
    $logErr = Join-Path $logsDir "server-stderr-$ts.log"
    Start-Process -FilePath $bun -ArgumentList "`"$deployedJs`"" -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr
    $healthy = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 700
        try {
            $r = Invoke-WebRequest -Uri 'http://127.0.0.1:19877/health' -TimeoutSec 2 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        } catch {}
    }
    if ($healthy) {
        Write-Ok 'server healthy on http://127.0.0.1:19877'
        Write-Ok "logging to $logOut"
    }
    else { Write-Host '  [WARN] server did not report healthy within ~14s' -ForegroundColor Yellow }
}

$elapsed = (Get-Date) - $startedAt
Write-Host ("`nDONE in {0:N0}s. Deployed Jarvis.exe + index.js + metrics script + prompts/ to {1}" -f $elapsed.TotalSeconds, $desktop) -ForegroundColor Green
