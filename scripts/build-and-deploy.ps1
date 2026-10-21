<#
.SYNOPSIS
    One-shot rebuild of the entire Jarvis stack (server bundle + UI + Rust app),
    then deploy the runtime to the OneDrive Desktop.

.DESCRIPTION
    Stages, fail-fast (stops on the first error):
      1. Server  -> bun build server-jarvis/src/index.ts  -> server-jarvis/dist/index.js
      2. UI      -> bun run build (tsc -b && vite build)   -> src-ui/dist
      3. Rust    -> cargo build --release                  -> <cargo target root>\release\home-base.exe
                    (the cargo target root is $env:CARGO_TARGET_DIR when it is
                     set, src-tauri\target otherwise; Tauri embeds src-ui/dist
                     into the binary at compile time, so the UI MUST be built
                     before this step — stage 2 guarantees it.)
      4. Deploy  -> copy the freshly built artifacts to the OneDrive Desktop:
                      home-base.exe  -> <Desktop>\Jarvis.exe   (and \home-base.exe)
                      dist/index.js  -> <Desktop>\index.js
                      proxy script  -> <Desktop>\resources\claude_cli_proxy.py
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

. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg"     -ForegroundColor Green }
function Die($msg)        { Write-Host "`n[FAILED] $msg" -ForegroundColor Red; exit 1 }

# ── Paths ────────────────────────────────────────────────────────────────────
$repo       = Split-Path -Parent $PSScriptRoot
$serverDir  = Join-Path $repo 'server-jarvis'
$uiDir      = Join-Path $repo 'src-ui'
$tauriDir   = Join-Path $repo 'src-tauri'
# The cargo target root is where cargo actually puts the build, and it is NOT
# always src-tauri\target: build-windows.ps1 (and any job that redirects the
# target dir) sets CARGO_TARGET_DIR. The built exe AND the NSIS bundle both
# live under it, so both are derived from this ONE value. A script that looked
# for the exe under a hardcoded src-tauri\target while cargo built into the
# redirected dir would ship - and record the provenance of - a stale binary
# that this build never produced, or find no exe at all.
$cargoTargetRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $tauriDir 'target' }
$exeOut     = Join-Path $cargoTargetRoot 'release\home-base.exe'
$distJs     = Join-Path $repo 'server-jarvis\dist\index.js'
$promptsSrc = Join-Path $repo 'server-jarvis\src\prompts'
$metricsScript = Join-Path $repo 'automate_inference_metrics.py'
$proxyScript = Join-Path $repo 'scripts\claude_cli_proxy.py'
$proxyModelsJson = Join-Path $repo 'scripts\opencode_go_openai_models.json'
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

# ── Stage 1: frontend artifacts ──────────────────────────────────────────────
Write-Step 'Stage 1/3 - Building server bundle and UI (bun)'
# Bake the build identity into the bundle so /health can report WHICH build is
# actually serving (2026-07 incident: a stale deploy silently served
# leaked-JSON bugs for days because /health only ever returned the static
# "3.0.0" version string). bun's --define replaces process.env.<NAME> member
# expressions at bundle time.
#
# The bake itself lives in server-jarvis/src/build-frontend.ts and is the
# SINGLE implementation of it, shared with the Tauri release build
# (scripts/release-build.ps1 -> `cargo tauri build` -> the same
# beforeBuildCommand). Two copies of this recipe is how the deploy path and
# the release path end up reporting different builds.
#
# The QUOTING TRAP that used to live here is now gone rather than
# documented: the inner quotes around a --define value must survive
# PowerShell 5.1's native-argument rebuild, and a bare backtick-escaped
# quote loses them, so bun folds the value as a BARE JS identifier
# (`var SHA = abc123 ?? "dev"` -> ReferenceError at module load -> the
# deployed server fails to boot, with bun build still exiting 0). Running
# the bake from bun instead of PowerShell removes the failure mode: bun
# receives its argv directly, with no shell in between to eat the quotes.
$buildGitSha = (git -C $repo rev-parse HEAD)
$buildBuiltAt = (Get-Date -Format 'o')
$buildGitDirty = -not [string]::IsNullOrWhiteSpace((git -C $repo status --porcelain))
$sourceTreeSha256 = Get-JarvisSourceTreeSha256 -RepoRoot $repo
$env:JARVIS_BUILD_GIT_SHA = $buildGitSha
$env:JARVIS_BUILD_BUILT_AT = $buildBuiltAt
$env:JARVIS_BUILD_GIT_DIRTY = $buildGitDirty.ToString().ToLowerInvariant()
$env:JARVIS_BUILD_SOURCE_TREE_SHA256 = $sourceTreeSha256
try {
    & $bun run (Join-Path $repo 'server-jarvis\src\build-frontend.ts')
    if ($LASTEXITCODE -ne 0) { Die 'frontend build failed' }
} finally {
    Remove-Item Env:\JARVIS_BUILD_GIT_SHA -ErrorAction SilentlyContinue
    Remove-Item Env:\JARVIS_BUILD_BUILT_AT -ErrorAction SilentlyContinue
    Remove-Item Env:\JARVIS_BUILD_GIT_DIRTY -ErrorAction SilentlyContinue
    Remove-Item Env:\JARVIS_BUILD_SOURCE_TREE_SHA256 -ErrorAction SilentlyContinue
}
if (-not (Test-Path $distJs)) { Die "server bundle not produced at $distJs" }
$distMcp = Join-Path $serverDir 'dist\mcp-stdio-server.js'
if (-not (Test-Path $distMcp)) { Die "mcp-stdio-server bundle not produced at $distMcp" }
# The bake must have folded the identity in. A bundle that still reads the
# environment at runtime reports git_sha "dev" and /health can no longer
# tell which build is answering - so this is checked, not assumed.
$bundleProvenance = Test-JarvisBundleProvenance -BundlePath $distJs -Identity ([pscustomobject]@{
    git_sha            = $buildGitSha
    source_tree_sha256 = $sourceTreeSha256
})
if (-not $bundleProvenance.ok) { Die "server bundle provenance check failed: $($bundleProvenance.reason)" }
Write-Ok "server bundle -> $distJs (git_sha $buildGitSha)"
Write-Ok "mcp-stdio-server -> $distMcp"
Write-Ok 'UI -> src-ui/dist'

# ── Stage 3: Rust app ────────────────────────────────────────────────────────
Write-Step 'Stage 2/3 - Building Rust app (cargo build --release)'
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

Write-Step "Stage 3/3 - Deploying to $desktop"
if (-not (Test-Path $desktop)) { Die "OneDrive Desktop not found: $desktop" }
if (-not (Test-Path $promptsSrc -PathType Container)) {
    Die "Jarvis prompt source not found: $promptsSrc"
}
if (-not (Test-Path $metricsScript -PathType Leaf)) {
    Die "Inference metrics script not found: $metricsScript"
}
if (-not (Test-Path $proxyScript -PathType Leaf)) {
    Die "Claude proxy script not found: $proxyScript"
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
    $dstParent = Split-Path -Parent $dst
    if (-not (Test-Path $dstParent)) { New-Item -ItemType Directory -Force -Path $dstParent | Out-Null }
    if (Test-Path $dst) { Copy-Item $dst "$dst.bak-$ts" -Force }
    Copy-Item $src $dst -Force
    Write-Ok "$dstName"
}

Deploy-File $exeOut 'Jarvis.exe'
Deploy-File $exeOut 'home-base.exe'
Deploy-File $distJs 'index.js'
$distMcpJs = Join-Path $serverDir 'dist\mcp-stdio-server.js'
Deploy-File $distMcpJs 'mcp-stdio-server.js'
Deploy-File $metricsScript 'automate_inference_metrics.py'
Deploy-File $proxyScript 'resources\claude_cli_proxy.py'
Deploy-File $proxyModelsJson 'resources\opencode_go_openai_models.json'

# prompts/ is a directory — replace wholesale (back up the old one first)
$promptsDst = Join-Path $desktop 'prompts'
if (Test-Path $promptsDst) {
    Move-Item $promptsDst "$promptsDst.bak-$ts" -Force
}
Copy-Item $promptsSrc $promptsDst -Recurse -Force
Write-Ok 'prompts/'

# ── Installer provenance (NSIS) ──
# `cargo build --release` alone does NOT bundle an installer; only a prior
# `cargo tauri build` writes one under <cargo target root>\release\bundle\nsis.
# When that bundle exists, ship it next to the runtime and record its SHA-256
# in the deploy manifest, so verify-deploy.ps1 can cross-check the exact
# installer that belongs to this git_sha. When no installer exists the
# installer_* manifest fields stay $null and verification skips cleanly.
$installerName = $null
$installerSha256 = $null
# The NSIS bundle sits under the SAME cargo target root as the exe above
# ($cargoTargetRoot, resolved in the Paths block): when CARGO_TARGET_DIR is
# set, the bundle is there and not under src-tauri\target.
$nsisDir = Join-Path $cargoTargetRoot 'release\bundle\nsis'
$installer = Get-ChildItem -Path $nsisDir -Filter '*.exe' -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if ($installer) {
    Deploy-File $installer.FullName 'Jarvis-installer.exe'
    $installerName = 'Jarvis-installer.exe'
    $installerSha256 = (Get-FileHash (Join-Path $desktop 'Jarvis-installer.exe') -Algorithm SHA256).Hash
    Write-Ok "installer provenance: $installerName $installerSha256"
} else {
    Write-Host "  [SKIP] no NSIS installer bundle under $nsisDir - installer provenance not recorded." -ForegroundColor Yellow
}

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
    claude_proxy_sha256 = (Get-FileHash "$desktop\resources\claude_cli_proxy.py" -Algorithm SHA256).Hash
    opencode_go_models_sha256 = (Get-FileHash "$desktop\resources\opencode_go_openai_models.json" -Algorithm SHA256).Hash
    exe_mtime = (Get-Item "$desktop\Jarvis.exe" -ErrorAction SilentlyContinue).LastWriteTimeUtc.ToString("o")
    prompts_tree_sha256 = (git -C $repo ls-tree HEAD server-jarvis/src/prompts | Select-Object -First 1).Split()[2]
    installer_name = $installerName
    installer_sha256 = $installerSha256
    deployed_at = (Get-Date -Format "o")
} | ConvertTo-Json -Depth 2
$manifest | Out-File "$desktop\.jarvis-deploy-manifest.json" -Encoding utf8
Write-Ok "deploy manifest -> .jarvis-deploy-manifest.json"

# ── Optional: relaunch the server so the next prompt streams immediately ──────
if ($RestartServer) {
    # ── Claude CLI proxy (:19878) — the delegate write path ──────────────────
    # This deploy has always COPIED claude_cli_proxy.py to the Desktop and then
    # done nothing with it. On 2026-07-21 the proxy stopped and nothing
    # restarted it; the delegate (policy: delegate_first, the PRIMARY write
    # path) kept launching the `claude` CLI with
    # ANTHROPIC_BASE_URL=127.0.0.1:19878, getting connection refused, and
    # terminating instantly. Writes silently fell back to a free-tier
    # text-protocol executor that rarely emits write calls, and it took eleven
    # days and a replay-harness rule to notice. Every deploy in between shipped
    # a dead write path without a word. Verify it here instead.
    # ASCII-only in console output: PS 5.1 renders non-ASCII here as mojibake.
    Write-Step 'Verifying Claude CLI proxy (:19878 - delegate write path)'
    $proxyPort = 19878
    $logsDir = Join-Path $env:USERPROFILE '.openclaw\jarvis\logs'
    if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Force -Path $logsDir | Out-Null }
    $proxyUp = [bool](Get-NetTCPConnection -State Listen -LocalPort $proxyPort -ErrorAction SilentlyContinue)
    if ($proxyUp) {
        Write-Ok "proxy already listening on http://127.0.0.1:$proxyPort"
    }
    else {
        $python = (Get-Command python -ErrorAction SilentlyContinue).Source
        if (-not $python) {
            Write-Host "  [WARN] python not found on PATH - cannot start the Claude CLI proxy." -ForegroundColor Red
            Write-Host "         The delegate write path will be DEAD: file edits will fall back to" -ForegroundColor Red
            Write-Host "         the native executor, which writes far less reliably." -ForegroundColor Red
        }
        else {
            $deployedProxy = Join-Path $desktop 'resources\claude_cli_proxy.py'
            $proxyOut = Join-Path $logsDir "claude-proxy-stdout-$ts.log"
            $proxyErr = Join-Path $logsDir "claude-proxy-stderr-$ts.log"
            Start-Process -FilePath $python -ArgumentList "`"$deployedProxy`"" -WindowStyle Hidden -RedirectStandardOutput $proxyOut -RedirectStandardError $proxyErr
            for ($i = 0; $i -lt 15; $i++) {
                Start-Sleep -Milliseconds 500
                if (Get-NetTCPConnection -State Listen -LocalPort $proxyPort -ErrorAction SilentlyContinue) { $proxyUp = $true; break }
            }
            if ($proxyUp) {
                Write-Ok "proxy started on http://127.0.0.1:$proxyPort"
                Write-Ok "logging to $proxyOut"
            }
            else {
                Write-Host "  [WARN] proxy did not bind :$proxyPort within ~7s." -ForegroundColor Red
                Write-Host "         The delegate write path is DEAD - file edits will fall back to" -ForegroundColor Red
                Write-Host "         the native executor, which writes far less reliably." -ForegroundColor Red
                Write-Host "         See $proxyErr" -ForegroundColor Red
            }
        }
    }

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
Write-Host ("`nDONE in {0:N0}s. Deployed Jarvis.exe + index.js + proxy + metrics script + prompts/ to {1}" -f $elapsed.TotalSeconds, $desktop) -ForegroundColor Green
