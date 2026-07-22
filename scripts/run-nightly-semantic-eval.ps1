[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$previousLocation = Get-Location
try {
  Set-Location -LiteralPath $RepoRoot
  $env:JARVIS_EVAL_LIVE = "1"
  & bun run src/eval/nightly-semantic-eval.ts
  exit $LASTEXITCODE
} finally {
  Set-Location -LiteralPath $previousLocation
}
