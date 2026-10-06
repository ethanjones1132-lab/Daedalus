# Adapters phase 1, unattended (plan docs/superpowers/plans/2026-10-05-adapters-phase1.md, Task 9). Detached and
# restart-safe: every step is skipped when its output exists. The spec's rules decide (phase1_decide.py). The
# Versutus gate is paused for the GPU work and restored at the end, or once 08:10 passes, whichever comes first.
#   Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',
#     'C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42\scripts\moe-bench\adapters-runs\run_phase1.ps1'
$ErrorActionPreference = 'Continue'
$repo = 'C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42'
$mb = "$repo\scripts\moe-bench"
$ad = "$repo\docs\benchmarks\adapters"
$calib = "$repo\docs\benchmarks\laya-calib"
$judge = "$repo\docs\benchmarks\laya-judge"
$S = 'C:\qwen3-forge-stage'
$M = "$S\models\adapters"
$L = "$S\logs"
$py = "$S\venv\Scripts\python.exe"
$tools = "$S\tools\llama-master-836d57176"
$full = "$S\Qwen3.6-35B-A3B-UD-IQ2_M.gguf"
$k96 = "$S\models\prune-qwen36\Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf"
# llama.cpp splits --control-vector-scaled FNAME:SCALE on every ':', so a drive letter breaks it: use a rooted, drive-relative path
$cvrel = '\qwen3-forge-stage\models\adapters\steer'
$log = "$L\adapters-chain.log"
$utf8 = New-Object System.Text.UTF8Encoding $false
New-Item -ItemType Directory -Force $M, $ad, "$M\steer" | Out-Null
function Say($m) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m`r`n"
    foreach ($target in @($log, "$log.alt")) {
        for ($i = 0; $i -lt 10; $i++) { try { [IO.File]::AppendAllText($target, $line, $utf8); return } catch { Start-Sleep -Milliseconds 500 } }
    }
}
function Gate($verb) { Push-Location 'C:\Projects\Versutus'; $r = cmd /c "node gate\cli.mjs service $verb 2>&1"; Pop-Location; Say "Versutus gate $verb`: $r" }
function Late { (Get-Date) -gt (Get-Date -Hour 8 -Minute 10 -Second 0) -and (Get-Date).Hour -lt 12 }
function Step($name, $taskdir, [string[]]$cmd, $gguf = '', $extra = '') {
    if (Late) { Say "SKIP $name`: past 08:10"; return }
    $env:TIER2B_DIR = $taskdir; $env:USE_TF = '0'; $env:PYTHONUTF8 = '1'; $env:PYTHONIOENCODING = 'utf-8'
    $env:BON_GGUF = $gguf; $env:BON_EXTRA = $extra
    $out = "$L\adapters-$name.out"
    foreach ($a in $cmd + $out) { if ($a -match '[\s"&|<>^]') { Say "REFUSED $name`: '$a'"; return } }
    Say "start $name"
    cmd /c "$($cmd -join ' ') >> $out 2>&1"
    Say "end $name (exit $LASTEXITCODE)"
}
function Settle { Say 'settle 180 s'; Start-Sleep -Seconds 180 }
# spec section 6: no variant or KL reference is written with under 10% free on C: (the Kingston NV2 crashed under big
# write-then-read work when nearly full)
function FreeOk { $d = Get-PSDrive C; ($d.Free / ($d.Free + $d.Used)) -ge 0.10 }
function Decide($what) { Step "decide-$what" $calib @($py, "$mb\phase1_decide.py", $what, '--dir', $ad) }
function Dec { Get-Content "$ad\decisions.json" -Raw | ConvertFrom-Json }
function Bon($name, $dir, $gguf, $extra) {
    $o = "$L\adapters-$name.jsonl"
    if (-not (Test-Path $o) -or (Select-String -Path "$L\adapters-$name.out" -Pattern 'done in' -Quiet -ErrorAction SilentlyContinue) -eq $false) {
        Step $name $dir @($py, "$mb\bestofn_tier2b.py", 'run', '--model', 'qwen36keep96', '--n', '3', '--suites', '1', '--trials', '3',
            '--temp-alt', '0.7', '--out', $o) $gguf $extra
    }
}
function Probe($name, $gguf, $extra) {
    $o = "$L\adapters-$name.jsonl"
    if (-not (Test-Path $o) -or (Get-Content $o | Measure-Object -Line).Lines -lt 120) {
        Step $name $calib @($py, "$mb\probe_tier2b.py", 'run', '--model', 'qwen36keep96', '--trials', '2', '--out', $o) $gguf $extra
    }
}

Say 'phase 1 start'
Gate 'stop'
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
# decided once, so the expert arm runs whole or not at all
$expertArm = FreeOk
if (-not $expertArm) { Say "expert arm deferred: C: has $([math]::Round((Get-PSDrive C).Free / 1GB)) GB free, under 10% (spec section 6); the steering arm runs on keep96" }

# 1. failure-targeted calibration text (the steering pairs use it too) and, for the expert arm, the full model's imatrix
if (-not (Test-Path "$M\calib.txt")) { Step 'calib' $calib @($py, "$mb\patch_calib.py", '--out-text', "$M\calib.txt", '--out-rows', "$ad\calib-answers.jsonl") }
if ($expertArm) {
    if (-not (Test-Path "$M\imatrix-failure.gguf")) {
        Step 'imatrix' $calib @("$tools\llama-imatrix.exe", '-m', $full, '-f', "$M\calib.txt", '-o', "$M\imatrix-failure.gguf",
            '--parse-special', '-c', '2048', '-b', '2048', '-ngl', '99', '--n-cpu-moe', '22')
    }

    # 2. the held-out file and the KL reference
    if (-not (Test-Path "$ad\heldout.txt")) { Step 'heldout' $calib @($py, "$mb\kl_eval.py", 'heldout', '--out', "$ad\heldout.txt") }
    $unscored = @('keep96', 'swap96', 'add108', 'swap108' | Where-Object { -not (Test-Path "$ad\kl-$_.json") })
    if ($unscored.Count -and -not (Test-Path "$M\kl-ref.bin")) {
        if (FreeOk) { Step 'klref' $calib @($py, "$mb\kl_eval.py", 'ref', '--model', $full, '--text', "$ad\heldout.txt", '--ref', "$M\kl-ref.bin") }
        else { Say 'REFUSED klref: under 10% free' }
    }

    # 3. keep lists, slices
    if (-not (Test-Path "$ad\keeplists\add108.json")) {
        Step 'keeplists' $calib @($py, "$mb\expert_patch.py", '--keep96', "$S\models\prune-qwen36\keep96.json", '--new', "$M\imatrix-failure.gguf",
            '--code', "$S\models\prune-qwen36\imatrix-qwen36-code.gguf", '--full', $full, '--out', "$ad\keeplists")
    }
    foreach ($v in 'swap96', 'add108', 'swap108') {
        if ((Test-Path "$M\keep96-$v.gguf") -or ((Test-Path "$ad\bench-$v.json") -and (Test-Path "$ad\kl-$v.json"))) { continue }
        if (-not (FreeOk)) { Say "REFUSED slice $v`: under 10% free"; continue }
        Step "slice-$v" $calib @($py, "$mb\slice_experts.py", $full, "$M\keep96-$v.gguf", '--keep-list', "$ad\keeplists\$v.json")
        Settle
    }
}
# size/speed (keep96 always, as the reference), closeness
foreach ($v in 'keep96', 'swap96', 'add108', 'swap108') {
    $g = if ($v -eq 'keep96') { $k96 } else { "$M\keep96-$v.gguf" }
    if (-not (Test-Path $g)) { continue }
    if (-not (Test-Path "$ad\bench-$v.json")) { Step "bench-$v" $calib @($py, "$mb\kl_eval.py", 'bench', '--model', $g, '--out', "$ad\bench-$v.json") }
    if (-not (Test-Path "$ad\kl-$v.json") -and (Test-Path "$M\kl-ref.bin")) { Step "kl-$v" $calib @($py, "$mb\kl_eval.py", 'score', '--model', $g, '--text', "$ad\heldout.txt", '--ref', "$M\kl-ref.bin", '--out', "$ad\kl-$v.json") }
}
Decide 'closest'
$d = Dec
if ($d -and $null -ne $d.closest) {
    foreach ($v in 'swap96', 'add108', 'swap108') {
        if (@($d.closest) -notcontains $v -and (Test-Path "$M\keep96-$v.gguf")) { Remove-Item "$M\keep96-$v.gguf" -Force; Say "deleted keep96-$v.gguf (not among the closest)" }
    }
    if (Test-Path "$M\kl-ref.bin") { Remove-Item "$M\kl-ref.bin" -Force; Say 'deleted kl-ref.bin (every variant scored)' }
}

# 4. the pool: keep96 and the two closest variants; the winner
Bon 'pool-keep96' $calib '' ''
foreach ($v in (Dec).closest) { Bon "pool-$v" $calib "$M\keep96-$v.gguf" '' }
Decide 'winner'
$win = (Dec).winner
$base = if ($win) { "$M\keep96-$win.gguf" } else { $k96 }
Say "steering base: $base"

# 5. steering vector: pairs, both methods, a 4-configuration screen at 0.5, the scale sweep, the recipe check
if (-not (Test-Path "$M\steer\positive.txt")) {
    Step 'pairs' $calib @($py, "$mb\steer.py", 'pairs', '--rows', "$ad\calib-answers.jsonl",
        "$repo\docs\benchmarks\2026-10-05\validation-b\valb-probe-qwen36keep96.jsonl", "$repo\docs\benchmarks\2026-10-05\validation-b\valb-probe2-qwen36keep96.jsonl",
        '--out-dir', "$M\steer")
}
foreach ($m in 'mean', 'pca') { if (-not (Test-Path "$M\steer\cv-$m.gguf")) { Step "cv-$m" $calib @($py, "$mb\steer.py", 'build', '--model', $base, '--dir', "$M\steer", '--method', $m) } }
Probe 'steer-none' $base ''
$range = '"--control-vector-layer-range","10","29"'
foreach ($c in 'mean-all', 'mean-mid', 'pca-all', 'pca-mid') {
    $m, $layers = $c.Split('-')
    if (-not (Test-Path "$M\steer\cv-$m.gguf")) { continue }
    $x = "[`"--control-vector-scaled`",`"$cvrel\cv-$m.gguf:0.5`"" + $(if ($layers -eq 'mid') { ",$range" } else { '' }) + ']'
    Probe "steer-$c-0.5" $base ($x -replace '\\', '\\')
}
Decide 'config'
$cfg = (Dec).steer_config
if ($cfg) {
    $m, $layers = $cfg.Split('-')
    foreach ($s in '0.25', '1.0') {
        $x = "[`"--control-vector-scaled`",`"$cvrel\cv-$m.gguf:$s`"" + $(if ($layers -eq 'mid') { ",$range" } else { '' }) + ']'
        Probe "steer-$cfg-$s" $base ($x -replace '\\', '\\')
    }
    Decide 'scale'
    $sc = (Dec).steer_scale
    if ($sc) {
        $x = "[`"--control-vector-scaled`",`"$cvrel\cv-$m.gguf:$sc`"" + $(if ($layers -eq 'mid') { ",$range" } else { '' }) + ']'
        Bon 'pool-steer' $calib $base ($x -replace '\\', '\\')
        Decide 'keep'
    }
}

# 6. pre-register (commit + push), then judge runs, then the paired result
Decide 'prereg'
$pre = "$repo\docs\superpowers\specs\2026-10-05-adapters-prereg.md"
if (Test-Path $pre) {
    Push-Location $repo
    $r = cmd /c "git add docs/superpowers/specs/2026-10-05-adapters-prereg.md docs/benchmarks/adapters && git commit -q -m ""docs(adapters): phase 1 pre-registration (before any judge run)"" -m ""Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"" && git push -q origin claude/micro-agent-swarm-design-929d42 2>&1"
    Pop-Location
    Say "pre-registration committed: $r"
    $d = Dec
    $fin = $d.steer_final
    $x = ''
    if ($fin) {
        $c2, $s2 = $fin.Split('@'); $m2, $l2 = $c2.Split('-')
        $x = "[`"--control-vector-scaled`",`"$cvrel\cv-$m2.gguf:$s2`"" + $(if ($l2 -eq 'mid') { ",$range" } else { '' }) + ']'
        $x = $x -replace '\\', '\\'
    }
    Bon 'judge-keep96' $judge '' ''
    Bon 'judge-patch' $judge $base $x
    Step 'decide-judge' $judge @($py, "$mb\phase1_decide.py", 'judge', '--dir', $ad)
} else { Say 'no pre-registration (both arms null): no judge run' }

foreach ($v in 'swap96', 'add108', 'swap108') { if ($v -ne $win -and (Test-Path "$M\keep96-$v.gguf")) { Remove-Item "$M\keep96-$v.gguf" -Force; Say "deleted keep96-$v.gguf" } }
Gate 'start'
Say 'phase 1 done'
