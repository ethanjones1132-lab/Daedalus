$scriptPath = Join-Path $PSScriptRoot 'verify-deploy.ps1'
$source = Get-Content -LiteralPath $scriptPath -Raw

$buildPath = Join-Path $PSScriptRoot 'build-and-deploy.ps1'
$buildSource = Get-Content -LiteralPath $buildPath -Raw

# Extracts the repoRoot default-resolution statement from verify-deploy.ps1,
# from its `if` guard through the matching closing brace, so the tests below
# can evaluate exactly that statement without running the verifier (which
# would otherwise consult the real Desktop and /health endpoint).
function Find-RepoRootResolutionBlock {
    $lines = $source -split "\r?\n"
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Contains('if ([string]::IsNullOrWhiteSpace($repoRoot))')) { $start = $i; break }
    }
    if ($start -lt 0) { throw "repoRoot default-resolution block not found in verify-deploy.ps1" }
    $end = -1
    for ($j = $start + 1; $j -lt $lines.Count; $j++) {
        if ($lines[$j].Trim() -eq '}') { $end = $j; break }
    }
    if ($end -lt 0) { throw "closing brace of the repoRoot resolution block not found in verify-deploy.ps1" }
    $lines[$start..$end] -join "`n"
}

# Evaluates the extracted resolution statement with $PSScriptRoot rewritten to
# an absolute literal directory (emulating a copied verify-deploy.ps1) and,
# when -PresetRepoRoot is given, seeding $repoRoot first (emulating an explicit
# -repoRoot override). The evaluated text starts by assigning $repoRoot so the
# statement is hermetic: no $repoRoot defined in any outer session scope can
# leak into it. Returns the resulting $repoRoot value.
function Invoke-RepoRootResolution {
    param([string]$BlockText, [string]$ScriptDir, [string]$PresetRepoRoot)
    $escapedDir = $ScriptDir.ToString().Replace("'", "''")
    $evaluated = $BlockText.Replace('$PSScriptRoot', "'$escapedDir'")
    if ($PSBoundParameters.ContainsKey('PresetRepoRoot')) {
        $evaluated = "`$repoRoot = '$($PresetRepoRoot.Replace("'", "''"))'`n$evaluated"
    } else {
        $evaluated = "`$repoRoot = `$null`n$evaluated"
    }
    $evaluated += "`n`$repoRoot"
    & ([scriptblock]::Create($evaluated))
}

Describe 'verify-deploy installer provenance' {
    It 'verifies the NSIS installer hash against the manifest when present' {
        $source | Should Match ([regex]::Escape('$manifest.installer_sha256'))
        $source | Should Match ([regex]::Escape('Get-FileHash -LiteralPath $installerPath -Algorithm SHA256'))
    }

    It 'skips with a clear message when no installer is present' {
        $source | Should Match 'skipping installer provenance check'
        $source | Should Match ([regex]::Escape('-not $installerPath'))
    }
}

Describe 'verify-deploy repoRoot default resolution' {
    It 'no longer hardcodes a repo root path (a copied verifier inspects its own tree)' {
        # Regression for the removed C:\Projects\home-base-recovered default.
        ($source.Contains('home-base-recovered')) | Should Be $false
    }

    It 'accepts an explicit -repoRoot parameter with no default value in the param block' {
        $tokens = $null
        $parseErrors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
        $parseErrors | Should BeNullOrEmpty
        $repoRootParams = @($ast.ParamBlock.Parameters | Where-Object { $_.Name.VariablePath.UserPath -eq 'repoRoot' })
        $repoRootParams.Count | Should Be 1
        $repoRootParams[0].DefaultValue | Should BeNullOrEmpty
    }

    It 'resolves the default in the script body from PSScriptRoot under an emptiness guard' {
        # Windows PowerShell 5.1 leaves $PSScriptRoot empty inside a parameter
        # default when the script is run via `powershell -File`
        # (PowerShell/PowerShell#4688), so the resolution must run in the body.
        $source | Should Match ([regex]::Escape('if ([string]::IsNullOrWhiteSpace($repoRoot))'))
        $source | Should Match ([regex]::Escape('(Resolve-Path (Join-Path $PSScriptRoot ''..'')).Path'))
    }

    It 'defaults a verifier copy (path containing spaces) to its own absolute repo parent' {
        $tempDirName = "dd-028 repoRoot space test $([guid]::NewGuid().ToString('N'))\scripts"
        $tempScripts = New-Item -ItemType Directory -Force -Path (Join-Path ([IO.Path]::GetTempPath()) $tempDirName)
        try {
            $resolved = Invoke-RepoRootResolution -BlockText (Find-RepoRootResolutionBlock) -ScriptDir $tempScripts.FullName
            [IO.Path]::IsPathRooted($resolved) | Should Be $true
            $expected = [IO.Path]::GetFullPath((Split-Path -Parent $tempScripts.FullName)).TrimEnd('\')
            [IO.Path]::GetFullPath($resolved).TrimEnd('\') | Should Be $expected
        } finally {
            Remove-Item -LiteralPath $tempScripts.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'preserves an explicit -repoRoot override and never resolves the script parent for it' {
        $override = 'C:\dd-028 override test\other checkout'
        # The scriptDir does not exist: if the override guard were broken, the
        # block would attempt Resolve-Path on it and throw.
        $resolved = Invoke-RepoRootResolution -BlockText (Find-RepoRootResolutionBlock) -ScriptDir 'C:\dd-028 override test\scripts' -PresetRepoRoot $override
        [IO.Path]::GetFullPath($resolved).TrimEnd('\') | Should Be ([IO.Path]::GetFullPath($override).TrimEnd('\'))
    }
}

Describe 'build-and-deploy installer provenance emission' {
    It 'deploys the NSIS bundle as Jarvis-installer.exe' {
        $buildSource | Should Match ([regex]::Escape("Deploy-File `$installer.FullName 'Jarvis-installer.exe'"))
    }

    It 'records the installer name and SHA-256 in the deploy manifest' {
        $buildSource | Should Match ([regex]::Escape('installer_name = $installerName'))
        $buildSource | Should Match ([regex]::Escape('installer_sha256 = $installerSha256'))
    }
}
