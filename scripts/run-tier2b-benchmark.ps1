[CmdletBinding()]
param(
    [ValidateSet('baseline', 'architecture', 'both')]
    [string]$Arm = 'both',
    [ValidateRange(1, 3)]
    [int]$K = 3,
    [switch]$Live,
    [string]$StreamUrl = 'http://127.0.0.1:19877/chat/stream'
)

$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'benchmark-tier2b\runbench2b.py'
$arguments = @($runner, '--arm', $Arm, '--k', $K, '--stream-url', $StreamUrl)
if ($Live) { $arguments += '--live' }
python @arguments
