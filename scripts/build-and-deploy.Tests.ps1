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
