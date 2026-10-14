# Laya partner GPU phases (plan docs/superpowers/plans/2026-10-05-laya-partner.md, Tasks 10 and 12).
# Runs detached so it survives a Claude restart, and every step resumes where it stopped. Launch only on the
# owner's go (he gates when the Versutus gate may be paused):
#   Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-File',
#     'C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42\scripts\moe-bench\laya-partner-runs\run_phase.ps1','calib'
# calib: pause the gate, smoke + RAM check (1 trial, recipe rule), calibration nested runs, Laya labels, both fits,
#        restore the gate. Then Claude writes and commits the pre-registration (Task 11) before phase judge.
# judge: refuses to start unless the rule, calibration and pre-registration are committed; pauses the gate,
#        judge nested runs, configurations 3-5 on the judge set and on tier2b, Laya labels, restores the gate.
# selftest: checks the logging below (no GPU, no gate): one step that prints non-ASCII text to stdout and
#        stderr and exits 3 must land in a UTF-8 .out file with its exit code logged.
# Logging lessons from the 2026-10-05 overnight run, both silent:
#   - "*>>" under -NoProfile writes UTF-16 and wraps every stderr line in a PowerShell error record, so the step
#     logs could not be grepped. Steps now go through cmd /c native redirection, with Python forced to UTF-8.
#   - Add-Content fails, non-terminating, while another process holds the log open (an orphaned tail -F did).
#     Say retries, then falls back to a second file, so a status line is never lost.
param([Parameter(Mandatory = $true)][ValidateSet('calib', 'judge', 'selftest')][string]$Phase)
$ErrorActionPreference = 'Continue'
$repo = 'C:\Projects\home-base-recovered\.claude\worktrees\micro-agent-swarm-design-929d42'
$mb = "$repo\scripts\moe-bench"
$lp = "$repo\docs\benchmarks\laya-partner"
$py = 'C:\qwen3-forge-stage\venv\Scripts\python.exe'
$lpy = 'C:\qwen3-forge-stage\venv-laya\Scripts\python.exe'
$L = 'C:\qwen3-forge-stage\logs'
$log = "$L\laya-chain-$Phase.log"
$utf8 = New-Object System.Text.UTF8Encoding $false
function Say($m) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m`r`n"
    foreach ($target in @($log, "$log.alt")) {  # the .alt file only if the main log stays locked
        for ($i = 0; $i -lt 10; $i++) {
            try { [IO.File]::AppendAllText($target, $line, $utf8); return } catch { Start-Sleep -Milliseconds 500 }
        }
    }
}
function Gate($verb) {
    Push-Location 'C:\Projects\Versutus'
    $r = cmd /c "node gate\cli.mjs service $verb 2>&1"
    Pop-Location
    Say "Versutus gate $verb`: $r"
}
function Step($name, $taskdir, [string[]]$cmd) {
    # one resumable step: TIER2B_DIR selects the task set; stdout and stderr append, as UTF-8, to its own .out file
    $env:TIER2B_DIR = $taskdir
    $env:USE_TF = '0'
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    Say "start $name"
    $out = "$L\laya-$name.out"
    foreach ($a in $cmd + $out) { if ($a -match '[\s"&|<>^]') { Say "REFUSED $name`: cmd /c cannot pass '$a' safely"; return } }
    cmd /c "$($cmd -join ' ') >> $out 2>&1"
    Say "end $name (exit $LASTEXITCODE)"
}
$calib = "$repo\docs\benchmarks\laya-calib"
$judge = "$repo\docs\benchmarks\laya-judge"
$tier2b = "$repo\scripts\benchmark-tier2b"
Say "phase $Phase start"
if ($Phase -eq 'selftest') {
    $out = "$L\laya-selftest.out"
    Remove-Item $out -ErrorAction SilentlyContinue
    # no spaces in the code: Step refuses arguments cmd /c cannot pass through unchanged
    Step 'selftest' $repo @($py, '-c', "print(chr(233)+chr(8212)+chr(0x4e2d));s=__import__('sys');s.stderr.write(chr(10003)+chr(10));s.exit(3)")
    $bytes = [IO.File]::ReadAllBytes($out)
    $text = $utf8.GetString($bytes)
    $utf16 = $bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes -contains 0 -and $bytes.Length -gt 4))
    $ok = (-not $utf16) -and $text.Contains([string][char]233 + [char]8212 + [char]0x4e2d) -and $text.Contains([string][char]10003) -and
          (Get-Content $log -Encoding UTF8 | Select-Object -Last 1) -match 'end selftest \(exit 3\)'
    Say "selftest $(if ($ok) { 'PASS' } else { 'FAIL' }): utf16=$utf16 bytes=$($bytes.Length)"
    exit $(if ($ok) { 0 } else { 1 })
}
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
