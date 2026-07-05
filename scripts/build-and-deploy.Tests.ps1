$scriptPath = Join-Path $PSScriptRoot 'build-and-deploy.ps1'
$source = Get-Content -LiteralPath $scriptPath -Raw

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

Describe 'build-and-deploy --define quoting (PS 5.1 native-arg trap)' {
    # The backtick-only form (`"$var`") puts a literal " in the PowerShell
    # string but PS 5.1 strips it when rebuilding the native command line, so
    # bun folds the value as a BARE IDENTIFIER -> ReferenceError at module
    # load, while `bun build` still exits 0 (2026-07-04 incident, fixed in
    # d9e2460). The working form escapes the inner quote for the native argv:
    # \`" -> \" -> bun sees ". These assertions pin the fixed form.
    It 'passes --define values with backslash-escaped inner quotes' {
        $source | Should Match ([regex]::Escape('--define "process.env.JARVIS_GIT_SHA=\`"$buildGitSha\`""'))
        $source | Should Match ([regex]::Escape('--define "process.env.JARVIS_BUILT_AT=\`"$buildBuiltAt\`""'))
    }

    It 'does not reintroduce the broken backtick-only quoting for --define' {
        # Broken form: --define "process.env.X=`"$var`"" (no backslash before
        # the escaped inner quote). Regex: a --define arg whose value quote is
        # NOT preceded by a backslash.
        $broken = [regex]::Match($source, '--define\s+"process\.env\.[A-Z_]+=(?<!\\)`"')
        $broken.Success | Should Be $false
    }
}
