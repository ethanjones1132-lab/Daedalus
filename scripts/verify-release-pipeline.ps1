# verify-release-pipeline.ps1 — run the release pipeline's Pester suite.
#
# DD-142: one command a gate can hand to `powershell -File` without quoting,
# scoped to the file that covers the release pipeline itself. It runs ONLY
# scripts/release-pipeline.Tests.ps1: other *.Tests.ps1 files under scripts\
# have their own runners and build-and-deploy.Tests.ps1 is not part of this
# check.
#
# Exit code is 0 only when every test in the suite passes (-EnableExit).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-release-pipeline.ps1

[CmdletBinding()]
param()

$ProgressPreference = 'SilentlyContinue'

# The suite is written for Pester 3.4 (-Script / Should Be), so pin it rather
# than silently changing assertion semantics under the tests.
$pesterVersion = '3.4.0'

if (-not (Get-Module -ListAvailable Pester | Where-Object { $_.Version -eq $pesterVersion })) {
    Write-Host "Pester $pesterVersion not found; installing it for the current user."
    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
    Set-PSRepository -Name PSGallery -InstallationPolicy Trusted -ErrorAction SilentlyContinue
    Install-Module Pester -RequiredVersion $pesterVersion -Force -Scope CurrentUser -SkipPublisherCheck -AllowClobber
}
# The install above runs under 'Stop'; the suite deliberately does not (a child
# script's captured stderr would otherwise become a terminating error).
$ErrorActionPreference = 'Continue'
Import-Module Pester -RequiredVersion $pesterVersion -Force

$repoRoot = Split-Path -Parent $PSScriptRoot
$suite = Join-Path $repoRoot 'scripts\release-pipeline.Tests.ps1'
if (-not (Test-Path -LiteralPath $suite -PathType Leaf)) {
    throw "release_pipeline_tests_missing:$suite"
}

Write-Host "Pester $((Get-Module Pester).Version)"
Invoke-Pester -Script $suite -EnableExit
