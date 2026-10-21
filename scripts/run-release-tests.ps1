# run-release-tests.ps1 — run the release machinery's Pester suite.
#
# One implementation for developers and CI. The release scripts are the only
# code path that produces the north star's artifact (signed installer ->
# release record -> published release), so their tests must run wherever that
# path is exercised: on every push and pull request (ci.yml) and again before
# the release workflow spends build time on a tag.
#
# The suite is written for Pester 3.4 (Should Be / Should Throw / -Script).
# Windows PowerShell 5.1 ships Pester 3.4 on some machines but newer images
# ship Pester 5, whose syntax is incompatible. Pin 3.4 rather than silently
# changing the assertion semantics under the tests.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-release-tests.ps1
#
# Exit code is 0 only when every test passes.

[CmdletBinding()]
param()

$ProgressPreference = 'SilentlyContinue'

$pesterVersion = '3.4.0'

if (-not (Get-Module -ListAvailable Pester | Where-Object { $_.Version -eq $pesterVersion })) {
    Write-Host "Pester $pesterVersion not found; installing it for the current user."
    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
    Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
    Install-Module Pester -RequiredVersion $pesterVersion -Force -Scope CurrentUser -SkipPublisherCheck -AllowClobber
}

# Deliberately NOT $ErrorActionPreference = 'Stop' at script scope. Several
# tests run the real scripts in a child `powershell` and capture stderr with
# `2>&1` to assert it; under 'Stop' that captured stderr becomes a terminating
# error inside the test and reports a false failure.
Import-Module Pester -RequiredVersion $pesterVersion -Force
Write-Host "Pester $((Get-Module Pester).Version)"

$repoRoot = Split-Path -Parent $PSScriptRoot

# The release machinery's whole test surface. Add a file here (and nowhere
# else) when a new release script gets its own tests.
$suites = @(
    (Join-Path $repoRoot 'scripts\release-pipeline.Tests.ps1'),
    (Join-Path $repoRoot 'scripts\release-review.Tests.ps1'),
    (Join-Path $repoRoot 'scripts\verify-deploy.Tests.ps1')
)

foreach ($suite in $suites) {
    if (-not (Test-Path -LiteralPath $suite -PathType Leaf)) {
        throw "release_test_suite_missing:$suite"
    }
}

# -EnableExit makes a failing suite exit nonzero, which is what both CI and a
# developer's shell need.
Invoke-Pester -Script $suites -EnableExit
