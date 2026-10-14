<#
.SYNOPSIS
  Serve Qwen3.6-35B-A3B on the 8 GB RTX 4060: the full IQ2_M file, or an
  expert-pruned slice made by slice_experts.py.

.DESCRIPTION
  Measured 2026-10-03/04 (llama.cpp master 836d571, CUDA 13.4, 16k context,
  thinking off, warm; tier2b = 39 tasks x 3 samples):

    Variant         File     CPU expert layers  Speculation        tok/s   tier2b
    full (256)      11.9 GB  22                 MTP 2               57.9   94/117
    keep96 slice     5.5 GB   0                 MTP 2              132.2   99/117
    keep96 slice     5.5 GB   0                 MTP 2 + n-gram     274.5   101/117 (1.7 min)
    keep64 slice     4.3 GB   0                 MTP 2              136.6   92/117
    swap108 slice    6.0 GB   0                 MTP 2 + n-gram     ~310    95/117 (recipe 101)
    add108 slice     6.0 GB   0                 MTP 2 + n-gram     -       99/117 (recipe 102)

  The 108-expert slices are adapters phase 1's expert patches (2026-10-06). swap108 beat
  keep96 on the sealed judge set (recipe 164 vs 153) but lost on tier2b (recipe 101 vs
  107, p 0.031), and add108 lost there too (102 vs 107), so keep96 stays the default.
  See docs/superpowers/specs/2026-10-06-model-settle.md. swap108's file was removed
  from C: and is rebuilt per docs/benchmarks/adapters/swap108-manifest.json.

  Default since the 2026-10-04 speed lab: MTP stacked with n-gram lookup
  (--spec-type draft-mtp,ngram-mod), which copies spans from the prompt; 2.1x on
  average, 2.6x on file edits. Use temperature 0.2 / top_p 0.95: the model-card
  settings (0.7 / 0.8 / top-k 20 / presence 1.5) scored 93, greedy 93.

  The slices keep the experts that carried the most activation energy on Python
  standard-library code (llama-imatrix), so they target coding work; pruning cost
  most on tier2b's hidden-package tasks (9/21 -> 6/21). The keep64 slice was deleted
  on 2026-10-04 to free C:; re-create it with slice_experts.py --keep 64.

  --cache-ram 0: the default 8 GiB host prompt cache starved this 16 GB machine.

.PARAMETER Variant
  full | keep96 | swap108 | add108 | keep64. Default keep96.

.PARAMETER NoThink
  Disable reasoning. By default the reasoning budget is 1536; send
  max_tokens >= 4096 alongside it.

.PARAMETER NoNgram
  Plain MTP speculation (the 2026-10-03 configuration).
#>
[CmdletBinding()]
param(
    [ValidateSet('full', 'keep96', 'swap108', 'add108', 'keep64')]
    [string]$Variant = 'keep96',
    [int]$Port = 8080,
    [switch]$NoThink,
    [switch]$NoNgram
)
$ErrorActionPreference = 'Stop'
$server = 'C:\qwen3-forge-stage\tools\llama-master-836d57176\llama-server.exe'
$models = @{
    full    = @{ path = 'C:\qwen3-forge-stage\Qwen3.6-35B-A3B-UD-IQ2_M.gguf'; ncmoe = 22 }
    keep96  = @{ path = 'C:\qwen3-forge-stage\models\prune-qwen36\Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf'; ncmoe = 0 }
    swap108 = @{ path = 'C:\qwen3-forge-stage\models\adapters\keep96-swap108.gguf'; ncmoe = 0 }
    add108  = @{ path = 'C:\qwen3-forge-stage\models\adapters\keep96-add108.gguf'; ncmoe = 0 }
    keep64  = @{ path = 'C:\qwen3-forge-stage\models\prune-qwen36\Qwen3.6-35B-A3B-UD-IQ2_M-keep64.gguf'; ncmoe = 0 }
}
$m = $models[$Variant]
foreach ($p in $server, $m.path) { if (-not (Test-Path $p)) { throw "not found: $p" } }
$budget = if ($NoThink) { '0' } else { '1536' }
$spec = if ($NoNgram) { 'draft-mtp' } else { 'draft-mtp,ngram-mod' }

$serverArgs = @(
    '-m', $m.path, '--host', '127.0.0.1', '--port', $Port,
    '-ngl', '99', '--n-cpu-moe', $m.ncmoe, '-c', '16384',
    '-ctk', 'q8_0', '-ctv', 'q8_0', '--flash-attn', 'on',
    '-b', '1024', '-ub', '1024', '-np', '1',   # -np > 1 is not supported with MTP
    '--jinja', '--reasoning-budget', $budget, '--no-webui',
    '--cache-ram', '0',
    '--spec-type', $spec, '--spec-draft-n-max', '2'
)
Write-Host "  variant   $Variant  ($($m.path))" -ForegroundColor Cyan
Write-Host "  placement --n-cpu-moe $($m.ncmoe), speculation $spec (MTP n-max 2), thinking $(if ($NoThink) { 'off' } else { 'budget 1536' })"
Write-Host "  endpoint  http://127.0.0.1:$Port/v1"
& $server @serverArgs
