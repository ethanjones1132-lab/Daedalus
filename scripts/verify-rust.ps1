<#
.SYNOPSIS
    Build the Tauri inputs and run the Rust library tests in one command,
    from a freshly cloned worktree with no build outputs.

.DESCRIPTION
    `cargo test --lib` in src-tauri does not run in a fresh checkout. Tauri's
    build script (src-tauri/build.rs) and `tauri::generate_context!()`
    (src-tauri/src/lib.rs) need generated inputs that are gitignored and are
    therefore absent until something builds them:

      server-jarvis/dist/index.js (plus tokenizer.cjs, mcp-stdio-server.js)
          the Bun server bundle, produced by server-jarvis/src/build-frontend.ts
          - the same script tauri.conf.json's beforeBuildCommand calls
      src-ui/dist
          tauri.conf.json's frontendDist; without it generate_context! fails to
          compile with "frontendDist ... doesn't exist"

    This script produces both, then runs `cargo test --lib` in src-tauri, and
    prints one verdict line. Each step's output is captured and repeated only
    when that step fails, so a green run is a few lines.

    It is safe as a gate check: it writes only inside the checkout it is run
    from, only to gitignored build outputs (node_modules/, dist/,
    src-tauri/target/), and it never commits anything.

    Exit codes: 0 when every step passed, 1 when any step failed or a
    prerequisite is missing.

.PARAMETER RepoRoot
    The checkout to verify. Defaults to the repository containing this
    script.

.PARAMETER BunCommand
    The Bun executable to use. Defaults to `bun`. Tests pass a stub here so
    Pester never spends a real build.

.PARAMETER CargoCommand
    The Cargo executable to use. Defaults to `cargo`. Tests pass a stub here
    so Pester never spends a real compile.

.EXAMPLE
    From a fresh gate worktree, with no dist/ and no src-tauri/target/:

        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-rust.ps1

.EXAMPLE
    Verify a different checkout (another worktree) without cd-ing into it:

        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-rust.ps1 `
            -RepoRoot C:\rh-wt\daedalus-gate

.EXAMPLE
    Gate on the exit code in a script or CI step:

        powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-rust.ps1
        if ($LASTEXITCODE -ne 0) { throw 'rust gate failed' }

.NOTES
    `docs/release-pipeline.md` ("Checking the Rust crate in a fresh worktree")
    documents this command for reviewers.
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',

    [string]$BunCommand = 'bun',

    [string]$CargoCommand = 'cargo'
)

$ErrorActionPreference = 'Stop'

$script:logDir = Join-Path ([IO.Path]::GetTempPath()) ('verify-rust-' + [guid]::NewGuid().ToString('N'))

function Complete-VerifyRust {
    param(
        [Parameter(Mandatory = $true)][bool]$Succeeded,
        [Parameter(Mandatory = $true)][string]$Detail,
        [Parameter(Mandatory = $true)][int]$Code
    )

    if ($Succeeded) {
        Write-Host ("VERIFY-RUST: PASS - {0}" -f $Detail) -ForegroundColor Green
    } else {
        Write-Host ("VERIFY-RUST: FAIL - {0}" -f $Detail) -ForegroundColor Red
    }
    if (Test-Path -LiteralPath $script:logDir) {
        Remove-Item -LiteralPath $script:logDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    exit $Code
}

function Invoke-VerifyStep {
    <#
        Run one step in its own working directory, capturing its output. Prints
        a single progress line; the captured output is repeated only when the
        step fails. Returns $true when the step exited 0.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$Executable,
        [string[]]$Arguments = @()
    )

    $logPath = Join-Path $script:logDir (($Label -replace '[^A-Za-z0-9]+', '-') + '.log')
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $code = 1
    $startError = $null

    Write-Host ("[{0}] {1} {2}" -f $Label, $Executable, ($Arguments -join ' ')) -NoNewline

    Push-Location -LiteralPath $WorkingDirectory
    try {
        # Native stderr is an error record; with 'Stop' in force a noisy tool
        # (cargo warnings, bun install notes) would abort the step instead of
        # being logged. Capture it, then restore the caller's preference.
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $Executable @Arguments *> $logPath
            $code = $LASTEXITCODE
        } catch {
            $startError = $_.Exception.Message
            $code = 1
        } finally {
            $ErrorActionPreference = $previousPreference
        }
    } finally {
        Pop-Location
    }
    $watch.Stop()

    if ($null -eq $code) { $code = 1 }

    if ($code -eq 0) {
        Write-Host (" ... ok ({0:n1}s)" -f $watch.Elapsed.TotalSeconds) -ForegroundColor Green
        return $true
    }

    Write-Host ' ... FAILED' -ForegroundColor Red
    if ($startError) {
        Write-Host ("  could not start '{0}': {1}" -f $Executable, $startError)
    }
    Write-Host ("  exit code {0} after {1:n1}s, working directory {2}" -f `
        $code, $watch.Elapsed.TotalSeconds, $WorkingDirectory)
    if (Test-Path -LiteralPath $logPath) {
        Get-Content -LiteralPath $logPath | ForEach-Object { Write-Host ("    {0}" -f $_) }
    }
    return $false
}

function Assert-VerifyTool {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Hint
    )

    if (-not (Get-Command -Name $Name -ErrorAction SilentlyContinue)) {
        Write-Host ("VERIFY-RUST: FAIL - tool_not_found: '{0}' is not available. {1}" -f $Name, $Hint) -ForegroundColor Red
        exit 1
    }
}

$root = if ([string]::IsNullOrWhiteSpace($RepoRoot)) { Split-Path -Parent $PSScriptRoot } else { $RepoRoot }
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    Write-Host ("VERIFY-RUST: FAIL - repo_root_missing: {0}" -f $root) -ForegroundColor Red
    exit 1
}
$root = (Resolve-Path -LiteralPath $root).Path

foreach ($relative in @('server-jarvis', 'src-ui', 'src-tauri')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Container)) {
        Write-Host ("VERIFY-RUST: FAIL - checkout_incomplete: {0} is missing under {1}" -f $relative, $root) -ForegroundColor Red
        exit 1
    }
}

New-Item -ItemType Directory -Force -Path $script:logDir | Out-Null
$total = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host ("== verify-rust: {0} ==" -f $root)

Assert-VerifyTool -Name $BunCommand -Hint 'Install Bun (https://bun.sh) and re-run.'
Assert-VerifyTool -Name $CargoCommand -Hint 'Install Rust 1.85 or newer with rustup and re-run.'

# 1. Dependencies. A fresh worktree has no node_modules, and both packages'
#    own build scripts (invoked below) need them.
$installed = @()
foreach ($package in @('server-jarvis', 'src-ui')) {
    $packageDir = Join-Path $root $package
    if (Test-Path -LiteralPath (Join-Path $packageDir 'node_modules') -PathType Container) { continue }
    if (-not (Invoke-VerifyStep -Label ('deps ' + $package) -WorkingDirectory $packageDir `
            -Executable $BunCommand -Arguments @('install', '--frozen-lockfile'))) {
        Complete-VerifyRust -Succeeded $false -Detail ("dependency install failed in {0}" -f $package) -Code 1
    }
    $installed += $package
}
if ($installed.Count -eq 0) {
    Write-Host '[deps] node_modules already present in server-jarvis and src-ui'
}

# 2. server-jarvis/dist/index.js and siblings. `bun run build` is the
#    package's own script (build-frontend.ts --server-only) - the same bundler
#    tauri.conf.json's beforeBuildCommand and the release build use.
if (-not (Invoke-VerifyStep -Label 'server bundle' -WorkingDirectory (Join-Path $root 'server-jarvis') `
        -Executable $BunCommand -Arguments @('run', 'build'))) {
    Complete-VerifyRust -Succeeded $false -Detail 'the server bundle build failed' -Code 1
}
foreach ($relative in @(
        'server-jarvis\dist\index.js',
        'server-jarvis\dist\tokenizer.cjs',
        'server-jarvis\dist\mcp-stdio-server.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf)) {
        Write-Host ("[server bundle] missing after a successful build: {0}" -f $relative) -ForegroundColor Red
        Complete-VerifyRust -Succeeded $false -Detail ("build_output_missing: {0}" -f $relative) -Code 1
    }
}

# 3. src-ui/dist, which generate_context!() embeds as frontendDist.
if (-not (Invoke-VerifyStep -Label 'ui bundle' -WorkingDirectory (Join-Path $root 'src-ui') `
        -Executable $BunCommand -Arguments @('run', 'build'))) {
    Complete-VerifyRust -Succeeded $false -Detail 'the UI bundle build failed' -Code 1
}
$uiEntry = Join-Path $root 'src-ui\dist\index.html'
if (-not (Test-Path -LiteralPath $uiEntry -PathType Leaf)) {
    Write-Host '[ui bundle] missing after a successful build: src-ui/dist/index.html' -ForegroundColor Red
    Complete-VerifyRust -Succeeded $false -Detail 'build_output_missing: src-ui\dist\index.html' -Code 1
}

# 4. The Rust library tests. Run from src-tauri so the crate's own
#    Cargo.toml is the manifest, exactly as a reviewer would.
if (-not (Invoke-VerifyStep -Label 'cargo test --lib' -WorkingDirectory (Join-Path $root 'src-tauri') `
        -Executable $CargoCommand -Arguments @('test', '--lib'))) {
    Complete-VerifyRust -Succeeded $false -Detail 'cargo test --lib failed' -Code 1
}

$total.Stop()
Complete-VerifyRust -Succeeded $true -Detail ("rust lib tests passed ({0:n0}s)" -f $total.Elapsed.TotalSeconds) -Code 0
