# Laya partner GPU phases (plan docs/superpowers/plans/2026-10-05-laya-partner.md, Tasks 10 and 12).
# Runs detached so it survives a Claude restart, and every step resumes where it stopped. Launch only on the
# owner's go (he gates when the Versutus gate may be paused):
#   Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-File',
#     'C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42\scripts\moe-bench\laya-partner-runs\run_phase.ps1','calib'
# calib: pause the gate, smoke + RAM check (1 trial, recipe rule), calibration nested runs, Laya labels, both fits,
#        restore the gate. Then Claude writes and commits the pre-registration (Task 11) before phase judge.
# judge: refuses to start unless the rule, calibration and pre-registration are committed; pauses the gate,
#        judge nested runs, configurations 3-5 on the judge set and on tier2b, Laya labels, restores the gate.
param([Parameter(Mandatory = $true)][ValidateSet('calib', 'judge')][string]$Phase)
$ErrorActionPreference = 'Continue'
$repo = 'C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42'
$mb = "$repo\scripts\moe-bench"
$lp = "$repo\docs\benchmarks\laya-partner"
$py = 'C:\qwen3-forge-stage\venv\Scripts\python.exe'
$lpy = 'C:\qwen3-forge-stage\venv-laya\Scripts\python.exe'
$L = 'C:\qwen3-forge-stage\logs'
$log = "$L\laya-chain-$Phase.log"
function Say($m) { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" -Encoding UTF8 }
function Gate($verb) {
    Push-Location 'C:\Projects\Versutus'
    $r = cmd /c "node gate\cli.mjs service $verb 2>&1"
    Pop-Location
    Say "Versutus gate $verb`: $r"
}
function Step($name, $taskdir, [string[]]$cmd) {
    # one resumable step: TIER2B_DIR selects the task set; output goes to its own .out file
    $env:TIER2B_DIR = $taskdir
    $env:USE_TF = '0'
    Say "start $name"
    $out = "$L\laya-$name.out"
    & $cmd[0] $cmd[1..($cmd.Length - 1)] *>> $out
    Say "end $name (exit $LASTEXITCODE)"
}
$calib = "$repo\docs\benchmarks\laya-calib"
$judge = "$repo\docs\benchmarks\laya-judge"
$tier2b = "$repo\scripts\benchmark-tier2b"
Say "phase $Phase start"
if ($Phase -eq 'judge') {
    Push-Location $repo
    $dirty = git status --porcelain -- docs/benchmarks/laya-partner/calib.json docs/benchmarks/laya-partner/rule.json docs/superpowers/specs/2026-10-05-laya-partner-prereg.md
    $have = (Test-Path "$lp\calib.json") -and (Test-Path "$lp\rule.json") -and (Test-Path "$repo\docs\superpowers\specs\2026-10-05-laya-partner-prereg.md")
    Pop-Location
    if (-not $have -or $dirty) { Say 'REFUSED: rule, calibration and pre-registration must be committed first'; exit 2 }
}
Gate 'stop'
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
if ($Phase -eq 'calib') {
    Step 'smoke' $calib @($py, "$mb\playbook_tier2b.py", 'live', '--out', "$L\laya-smoke.jsonl", '--rule', "$lp\smoke-rule.json",
        '--calib', "$lp\identity-calib.json", '--trials', '1')
    Step 'calib-nested' $calib @($py, "$mb\playbook_tier2b.py", 'nested', '--out', "$L\laya-calib-nested.jsonl")
    Gate 'start'  # the labels and fits run on the CPU
    Step 'calib-label' $calib @($lpy, "$mb\laya_partner.py", 'label', '--runs', "$L\laya-calib-nested.jsonl", '--out', "$L\laya-calib-labels.jsonl")
    Step 'calib-fit' $calib @($py, "$mb\laya_calibrate.py", 'fit', '--trials', "$L\laya-calib-nested.jsonl", '--labels', "$L\laya-calib-labels.jsonl",
        '--out', "$lp\calib.json")
    Step 'rule-fit' $calib @($py, "$mb\playbook.py", 'fit', '--trials', "$L\laya-calib-nested.jsonl", '--labels', "$L\laya-calib-labels.jsonl",
        '--calib', "$lp\calib.json", '--out', "$lp\rule.json")
} else {
    Step 'judge-nested' $judge @($py, "$mb\playbook_tier2b.py", 'nested', '--out', "$L\laya-judge-nested.jsonl")
    foreach ($set in @(@('judge', $judge), @('tier2b', $tier2b))) {
        $name, $dir = $set
        Step "$name-c3" $dir @($py, "$mb\playbook_tier2b.py", 'live', '--out', "$L\laya-$name-c3.jsonl", '--rule', "$lp\rule.json", '--calib', "$lp\calib.json", '--note', 'on', '--verify', 'off')
        Step "$name-c4" $dir @($py, "$mb\playbook_tier2b.py", 'live', '--out', "$L\laya-$name-c4.jsonl", '--rule', "$lp\rule.json", '--calib', "$lp\calib.json", '--note', 'on', '--verify', 'on')
        Step "$name-c5" $dir @($py, "$mb\playbook_tier2b.py", 'live', '--out', "$L\laya-$name-c5.jsonl", '--rule', "$lp\rule.json", '--calib', "$lp\calib.json", '--note', 'off', '--verify', 'on')
    }
    Gate 'start'
    Step 'judge-label' $judge @($lpy, "$mb\laya_partner.py", 'label', '--runs', "$L\laya-judge-nested.jsonl", '--out', "$L\laya-judge-labels.jsonl")
}
Say "phase $Phase done"
