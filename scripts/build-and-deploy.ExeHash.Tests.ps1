# DD-027: the built exe path must follow the cargo target root.
#
# build-windows.ps1 redirects cargo into %USERPROFILE%\.cargo-target\home-base
# through CARGO_TARGET_DIR. build-and-deploy.ps1 used to hardcode
# src-tauri\target\release\home-base.exe, so with a redirected target dir it
# looked for -- and shipped -- a binary that cargo never built: a stale exe
# left over in the default target dir, or nothing at all. The deploy manifest
# then recorded the provenance of the wrong file.
#
# The NSIS bundle lookup already honored CARGO_TARGET_DIR. The exe lookup did
# not. One root, one exe path, and the default is still src-tauri\target.
#
# The assertions below are text parses of the script (the same style as
# scripts/build-and-deploy.Tests.ps1) plus behavioral checks: the script's OWN
# path assignments are evaluated against a fake repo root, so the derived path
# is checked, not just its spelling. Nothing is built, nothing is deployed,
# and the real environment is restored afterwards.

$scriptPath = Join-Path $PSScriptRoot 'build-and-deploy.ps1'
$source = Get-Content -LiteralPath $scriptPath -Raw

function Contains-Literal {
    param([string]$Haystack, [string]$Needle)
    return $Haystack.IndexOf($Needle, [System.StringComparison]::Ordinal) -ge 0
}

# Compare paths by their normalized form: the same path spelled with either
# separator is the same path.
function ConvertTo-NormalizedPath {
    param([string]$Path)
    return ($Path -replace '\\', '/').ToLowerInvariant()
}

# Run the script's own path assignments against a fake repo root and report
# the exe path they produce. Only the path arithmetic runs.
function Get-ScriptExePath {
    param(
        [string]$Text,
        [string]$FakeRepo,
        # An empty string means "CARGO_TARGET_DIR is not set".
        [string]$CargoTargetDir
    )

    # The three assignments that decide where the built exe lives. They are
    # single-line statements, and they are evaluated in source order.
    $statements = @()
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^\s*\$(tauriDir|cargoTargetRoot|exeOut)\s*=') { $statements += $line }
    }
    if ($statements.Count -lt 3) { throw 'cargo_target_path_statements_not_found' }

    $savedTargetDir = $env:CARGO_TARGET_DIR
    try {
        if ([string]::IsNullOrEmpty($CargoTargetDir)) {
            Remove-Item Env:\CARGO_TARGET_DIR -ErrorAction SilentlyContinue
        } else {
            $env:CARGO_TARGET_DIR = $CargoTargetDir
        }
        $code = ($statements -join "`n")
        return (& {
            param($RepoRoot, $Code)
            $repo = $RepoRoot
            Invoke-Expression $Code
            return $exeOut
        } $FakeRepo $code)
    } finally {
        if ($null -eq $savedTargetDir) {
            Remove-Item Env:\CARGO_TARGET_DIR -ErrorAction SilentlyContinue
        } else {
            $env:CARGO_TARGET_DIR = $savedTargetDir
        }
    }
}

# Validator 1: the exe path must be DERIVED from $cargoTargetRoot, so the
# same root decides where the exe is built, found, copied and recorded.
function Test-ExePathFollowsCargoTargetRoot {
    param([string]$Text)
    $pattern = [regex]::Escape('$exeOut') + '\s*=\s*' +
        [regex]::Escape('Join-Path $cargoTargetRoot') + '\s*' +
        [regex]::Escape("'release\home-base.exe'")
    return ($Text -match $pattern)
}

# Validator 2: $cargoTargetRoot honors CARGO_TARGET_DIR and falls back to
# cargo's own default, src-tauri\target.
function Test-CargoTargetRootHonorsEnv {
    param([string]$Text)
    $head = [regex]::Escape('$cargoTargetRoot') + '\s*=\s*if\s*\(\s*' +
        [regex]::Escape('$env:CARGO_TARGET_DIR') + '\s*\)\s*\{'
    $tail = '\}\s*else\s*\{\s*' +
        [regex]::Escape('Join-Path $tauriDir') + '\s*' +
        [regex]::Escape("'target'") + '\s*\}'
    return (($Text -match $head) -and ($Text -match $tail))
}

# Validator 3: the hardcoded default exe path is gone from the script.
function Test-NoHardcodedExePath {
    param([string]$Text)
    foreach ($needle in @('src-tauri\target\release\home-base.exe', 'src-tauri/target/release/home-base.exe')) {
        if (Contains-Literal $Text $needle) { return $false }
    }
    return $true
}

# Validator 4: the NSIS bundle lookup shares the same cargo target root, so
# the installer and the exe can never come from different trees.
function Test-InstallerLookupSharesTargetRoot {
    param([string]$Text)
    $pattern = [regex]::Escape('$nsisDir') + '\s*=\s*' +
        [regex]::Escape('Join-Path $cargoTargetRoot') + '\s*' +
        [regex]::Escape("'release\bundle\nsis'")
    return ($Text -match $pattern)
}

Describe 'build-and-deploy built-exe path follows the cargo target root' {
    It 'derives the exe path from $cargoTargetRoot' {
        Test-ExePathFollowsCargoTargetRoot $source | Should Be $true
    }

    It 'honors CARGO_TARGET_DIR and keeps src-tauri\target as the default target root' {
        Test-CargoTargetRootHonorsEnv $source | Should Be $true
    }

    It 'never hardcodes the default exe path' {
        Test-NoHardcodedExePath $source | Should Be $true
    }

    It 'looks for the NSIS bundle under the same cargo target root' {
        Test-InstallerLookupSharesTargetRoot $source | Should Be $true
    }

    It 'rejects a mutant that hardcodes the exe path again' {
        $mutant = $source.Replace(
            "Join-Path `$cargoTargetRoot 'release\home-base.exe'",
            "Join-Path `$repo 'src-tauri\target\release\home-base.exe'"
        )
        $mutant | Should Not Be $source
        Test-ExePathFollowsCargoTargetRoot $mutant | Should Be $false
        Test-NoHardcodedExePath $mutant | Should Be $false
    }
}

Describe 'the derived exe path' {
    It 'is src-tauri\target\release\home-base.exe when CARGO_TARGET_DIR is unset' {
        $path = Get-ScriptExePath -Text $source -FakeRepo 'C:\fake\repo' -CargoTargetDir ''
        ($null -ne $path) | Should Be $true
        (ConvertTo-NormalizedPath $path) | Should Be 'c:/fake/repo/src-tauri/target/release/home-base.exe'
    }

    It 'follows CARGO_TARGET_DIR when it is set' {
        $path = Get-ScriptExePath -Text $source -FakeRepo 'C:\fake\repo' -CargoTargetDir 'C:\fake\cargo-target'
        ($null -ne $path) | Should Be $true
        (ConvertTo-NormalizedPath $path) | Should Be 'c:/fake/cargo-target/release/home-base.exe'
    }
}

Describe 'the deploy ships the derived exe' {
    It 'copies $exeOut to Jarvis.exe and to home-base.exe' {
        (Contains-Literal $source "Deploy-File `$exeOut 'Jarvis.exe'") | Should Be $true
        (Contains-Literal $source "Deploy-File `$exeOut 'home-base.exe'") | Should Be $true
    }

    It 'checks the derived exe exists before deploying it' {
        (Contains-Literal $source 'if (-not (Test-Path $exeOut))') | Should Be $true
    }
}
