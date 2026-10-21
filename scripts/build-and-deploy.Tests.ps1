$scriptPath = Join-Path $PSScriptRoot 'build-and-deploy.ps1'
$source = Get-Content -LiteralPath $scriptPath -Raw
$buildFrontendPath = Join-Path $PSScriptRoot '..\server-jarvis\src\build-frontend.ts'
$buildFrontendSource = Get-Content -LiteralPath $buildFrontendPath -Raw

# ── Pure validators for the bun --define bake (DD-030) ──────────────────────
# The bake itself lives ONLY in server-jarvis/src/build-frontend.ts; this
# script must merely DELEGATE to it (why: see the second Describe below).
# Each validator takes source TEXT and returns $true/$false, so it can be
# run on the real production files above and on in-memory mutants. No
# validator touches the filesystem or spawns anything.

function Contains-Literal {
    param([string]$Haystack, [string]$Needle)
    return $Haystack.IndexOf($Needle, [System.StringComparison]::Ordinal) -ge 0
}

# Validator 1: the ingest in build-frontend.ts must fold the build identity
# as QUOTED JavaScript literals. bun replaces the member expression with the
# literal that follows it: process.env.JARVIS_GIT_SHA="13d..." (real double
# quotes). A bare identifier would fold to a ReferenceError at module load,
# and `bun build` still exits 0 in that case.
function Test-BakeDefines {
    param([string]$Text)
    if (-not (Contains-Literal $Text '["process.env.JARVIS_GIT_SHA", process.env.JARVIS_BUILD_GIT_SHA]')) { return $false }
    if (-not (Contains-Literal $Text '["process.env.JARVIS_BUILT_AT", process.env.JARVIS_BUILD_BUILT_AT]')) { return $false }
    if (-not (Contains-Literal $Text 'defines.push(`${expression}="${value}"`)')) { return $false }
    return $true
}

# Validator 2: bun must receive its argv directly (no shell in between to
# eat the inner quotes), and each define must be its OWN argv element -
# "--define" and the value separate - spread into the bun build
# ./src/index.ts argument array.
function Test-BakeInvocation {
    param([string]$Text)
    if (-not (Contains-Literal $Text 'spawnSync(command, args, { cwd, stdio: "inherit", shell: false }')) { return $false }
    if (Contains-Literal $Text 'shell: true') { return $false }
    if (-not (Contains-Literal $Text 'defines.flatMap((define) => ["--define", define])')) { return $false }
    if (-not (Contains-Literal $Text '"build", "./src/index.ts"')) { return $false }
    if (-not (Contains-Literal $Text '...defineArgs]')) { return $false }
    return $true
}

# Validator 3: build-and-deploy.ps1 must run build-frontend.ts through bun
# (not bake anything itself) yet still verify the fold afterwards.
function Test-DelegatesBake {
    param([string]$Text)
    foreach ($needle in @(
        'server-jarvis\src\build-frontend.ts',
        '& $bun run',
        '$env:JARVIS_BUILD_GIT_SHA',
        '$env:JARVIS_BUILD_BUILT_AT',
        'Test-JarvisBundleProvenance'
    )) {
        if (-not (Contains-Literal $Text $needle)) { return $false }
    }
    foreach ($needle in @('& $bun build', 'bun build ./src/index.ts', '--define process.env.JARVIS_')) {
        if (Contains-Literal $Text $needle) { return $false }
    }
    return $true
}

Describe 'build-and-deploy prompt deployment preflight' {
    It 'validates the prompt source before mutating the Desktop runtime' {
        $guard = [regex]::Match(
            $source,
            'if\s*\(\s*-not\s*\(Test-Path\s+\$promptsSrc\s+-PathType\s+Container\)\s*\)'
        )
        $firstDesktopMutation = [regex]::Match(
            $source,
            "Deploy-File\s+\`$exeOut\s+'Jarvis\.exe'"
        )

        $guard.Success | Should Be $true
        $firstDesktopMutation.Success | Should Be $true
        $guard.Index | Should BeLessThan $firstDesktopMutation.Index
    }
}

Describe 'bun --define bake in build-frontend.ts (pure validators)' {
    # The PS 5.1 native-arg trap behind the OLD assertions in this file: the
    # backtick-only form (`"$var`") puts a literal " in the PowerShell string
    # but PS 5.1 strips it when rebuilding the native command line, so bun
    # folded the value as a BARE IDENTIFIER -> ReferenceError at module load,
    # while `bun build` still exited 0 (2026-07-04 incident, fixed in
    # d9e2460). That recipe is gone from this script; the bake lives in
    # build-frontend.ts, which hands bun its argv directly. These tests pin
    # the bake TEXT in the TypeScript instead: positive tests run the
    # validators on the real source, negative tests build in-memory mutants,
    # show the mutant actually differs, and require the validator to reject
    # it.

    It 'keeps both identity mappings and folds them as quoted string literals' {
        Test-BakeDefines $buildFrontendSource | Should Be $true
    }

    It 'rejects a fold whose "${value}" lost its quotes (bare-identifier trap)' {
        $mutant = $buildFrontendSource.Replace('defines.push(`${expression}="${value}"`)', 'defines.push(`${expression}=${value}`)')
        $mutant | Should Not Be $buildFrontendSource
        Test-BakeDefines $mutant | Should Be $false
    }

    It 'rejects a mutant that drops the JARVIS_BUILT_AT identity mapping' {
        $mutant = $buildFrontendSource.Replace('["process.env.JARVIS_BUILT_AT", process.env.JARVIS_BUILD_BUILT_AT],', '')
        $mutant | Should Not Be $buildFrontendSource
        Test-BakeDefines $mutant | Should Be $false
    }

    It 'invokes bun itself with shell-less argv and two-element define args' {
        Test-BakeInvocation $buildFrontendSource | Should Be $true
    }

    It 'rejects a mutant that hands bun to a shell (shell: true)' {
        $mutant = $buildFrontendSource.Replace('shell: false', 'shell: true')
        $mutant | Should Not Be $buildFrontendSource
        Test-BakeInvocation $mutant | Should Be $false
    }

    It 'rejects a mutant that joins "--define" and the value into one token' {
        $mutant = $buildFrontendSource.Replace('defines.flatMap((define) => ["--define", define])', 'defines.flatMap((define) => ["--define " + define])')
        $mutant | Should Not Be $buildFrontendSource
        Test-BakeInvocation $mutant | Should Be $false
    }
}

Describe 'build-and-deploy.ps1 delegates the bake to build-frontend.ts' {
    It 'runs build-frontend.ts through bun and keeps the identity env vars' {
        (Contains-Literal $source 'server-jarvis\src\build-frontend.ts') | Should Be $true
        (Contains-Literal $source '& $bun run') | Should Be $true
        (Contains-Literal $source '$env:JARVIS_BUILD_GIT_SHA') | Should Be $true
        (Contains-Literal $source '$env:JARVIS_BUILD_BUILT_AT') | Should Be $true
        (Contains-Literal $source 'Test-JarvisBundleProvenance') | Should Be $true
    }

    It 'never bakes the identity with a direct bun build command line' {
        (Contains-Literal $source '& $bun build') | Should Be $false
        (Contains-Literal $source 'bun build ./src/index.ts') | Should Be $false
        (Contains-Literal $source '--define process.env.JARVIS_') | Should Be $false
    }

    It 'passes the delegation validator on the real script' {
        Test-DelegatesBake $source | Should Be $true
    }

    It 'rejects a mutant that re-adds a direct bun build --define recipe' {
        $mutant = $source + "`n" + '& $bun build ./src/index.ts --outdir ./dist --target bun --define process.env.JARVIS_GIT_SHA="$buildGitSha"'
        $mutant | Should Not Be $source
        Test-DelegatesBake $mutant | Should Be $false
    }
}
