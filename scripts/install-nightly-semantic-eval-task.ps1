<#
.SYNOPSIS
  Opt-in installer for the Windows scheduled task that runs the nightly
  semantic eval once per night.

.DESCRIPTION
  Mirrors the sentinel task installer's shape: one named task, a description,
  a daily trigger, registration, and an uninstall path. The eval is opt-in
  because it calls real model providers, so this installer is too: running it
  without -Register (or -Uninstall) is a dry run that prints exactly what it
  would register and writes nothing. Pass -WhatIf together with -Register or
  -Uninstall to preview that specific action the same way.

  The registered task runs scripts/run-nightly-semantic-eval.ps1 -Live, which
  reports under %USERPROFILE%\.openclaw\jarvis\eval\semantic\ and uses a
  non-zero exit as the scheduler alert signal. Re-running with -Register
  overwrites the task with the same name (-Force), so the installer is
  idempotent.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  # Resolved after the param block; see the note above the resolution below.
  [string]$RepoRoot,
  [string]$TaskName = "Jarvis Nightly Semantic Eval",
  [string]$At = "03:00",
  [switch]$Register,
  [switch]$Uninstall
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

if ($Register -and $Uninstall) {
  throw "Choose one action: -Register or -Uninstall."
}

$wrapper = Join-Path $RepoRoot "scripts\run-nightly-semantic-eval.ps1"
$execute = "powershell.exe"
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$wrapper`" -Live"
$description =
  "Runs the opt-in nightly semantic eval for 10|Jarvis / home-base " +
  "(scripts/run-nightly-semantic-eval.ps1 -Live). Reports are written under " +
  "%USERPROFILE%\.openclaw\jarvis\eval\semantic\ and a non-zero exit is the " +
  "scheduler alert signal. Installed by " +
  "scripts/install-nightly-semantic-eval-task.ps1."

function Show-Plan {
  param([ValidateSet("register", "unregister")][string]$Mode)
  if ($Mode -eq "register") {
    Write-Output "[NightlySemanticEvalTask] would register task:"
    Write-Output "  name:         $TaskName"
    Write-Output "  description:  $description"
    Write-Output "  schedule:     daily at $At (local time)"
    Write-Output "  executable:   $execute"
    Write-Output "  arguments:    $argument"
    Write-Output "  working dir:  $RepoRoot"
  } else {
    Write-Output "[NightlySemanticEvalTask] would unregister task:"
    Write-Output "  name: $TaskName"
  }
}

# Default (and -WhatIf without an action): dry run only. This branch must not
# import ScheduledTasks or write anything, so it is safe on any machine.
if (-not $Register -and -not $Uninstall) {
  Write-Output "[NightlySemanticEvalTask] dry-run: nothing registered, nothing removed."
  Show-Plan -Mode register
  Write-Output "[NightlySemanticEvalTask] pass -Register to create the task, -Uninstall to remove it."
  exit 0
}

Import-Module ScheduledTasks

if ($Register) {
  if (-not (Test-Path -LiteralPath $wrapper)) {
    throw "nightly wrapper not found at $wrapper"
  }
  Show-Plan -Mode register
  $action = New-ScheduledTaskAction -Execute $execute -Argument $argument -WorkingDirectory $RepoRoot
  $trigger = New-ScheduledTaskTrigger -Daily -At $At
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  if ($PSCmdlet.ShouldProcess($TaskName, "Register scheduled task (daily at $At, runs $wrapper -Live)")) {
    Register-ScheduledTask -TaskName $TaskName -Description $description -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Output "[NightlySemanticEvalTask] registered '$TaskName'; it runs nightly at $At."
  }
  exit 0
}

if ($Uninstall) {
  Show-Plan -Mode unregister
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Output "[NightlySemanticEvalTask] '$TaskName' is not installed; nothing to remove."
    exit 0
  }
  if ($PSCmdlet.ShouldProcess($TaskName, "Unregister scheduled task")) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "[NightlySemanticEvalTask] removed '$TaskName'."
  }
  exit 0
}
