[CmdletBinding()]
param(
  # Resolved below instead of in the param default: a wrapper that drops
  # $PSScriptRoot (the gate runs the check from a host that does) left this
  # empty and the script died on Split-Path before doing anything.
  [string]$RepoRoot,
  # The live eval hits real model providers, so the wrapper is dry-run by
  # default: it prints what it would run and exits 0 without touching them.
  # Pass -Live (or let the scheduled task installed by
  # scripts/install-nightly-semantic-eval-task.ps1 pass it) to actually run.
  [switch]$Live
)

$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
  $scriptDir = if ($PSScriptRoot) {
    $PSScriptRoot
  } elseif ($PSCommandPath) {
    Split-Path -Parent $PSCommandPath
  } else {
    (Get-Location).Path
  }
  $RepoRoot = Split-Path -Parent $scriptDir
}

if (-not $Live) {
  Write-Output "[NightlySemanticEval] dry-run: nothing ran, nothing written."
  Write-Output "[NightlySemanticEval] from $RepoRoot it would set JARVIS_EVAL_LIVE=1 and run:"
  Write-Output "  bun run src/eval/nightly-semantic-eval.ts"
  Write-Output "[NightlySemanticEval] pass -Live to run the real eval (hits live model providers)."
  exit 0
}

$previousLocation = Get-Location
try {
  Set-Location -LiteralPath $RepoRoot
  $env:JARVIS_EVAL_LIVE = "1"
  & bun run src/eval/nightly-semantic-eval.ts
  exit $LASTEXITCODE
} finally {
  Set-Location -LiteralPath $previousLocation
}
