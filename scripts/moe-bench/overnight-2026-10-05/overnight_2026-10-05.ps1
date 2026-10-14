# Overnight chain, 2026-10-05: wait for the best-of-N run, then the thinking-budget sweep
# (Qwen3.6 keep96, then Gemma 26B), then restore the Versutus gate. Runs detached, so it
# survives a Claude restart. Create C:\qwen3-forge-stage\HOLD_VERSUTUS to keep the gate paused
# at the end (only when another GPU job will restore it).
$ErrorActionPreference = 'Continue'
$logs = 'C:\qwen3-forge-stage\logs'
$log = "$logs\overnight-2026-10-05.log"
function Say($m) { Add-Content -Path $log -Value "$(Get-Date -Format 'HH:mm:ss') $m" -Encoding UTF8 }
Say 'chain start'
while (-not (Select-String -Path "$logs\bestofn-keep96-2026-10-05.out" -Pattern 'bestofn exited' -Quiet)) { Start-Sleep -Seconds 20 }
Say 'best-of-N finished; starting the thinking sweep'
Start-Sleep -Seconds 30
cmd /c "C:\qwen3-forge-stage\venv\Scripts\python.exe C:\qwen3-forge-stage\scripts\thinking_sweep.py qwen36keep96 gemma26b >> $logs\thinking-sweep-2026-10-05.out 2>&1"
Say "thinking sweep exited $LASTEXITCODE"
if (Test-Path 'C:\qwen3-forge-stage\HOLD_VERSUTUS') {
    Say 'HOLD_VERSUTUS present: gate left paused for the next GPU job'
} else {
    Push-Location 'C:\Projects\Versutus'
    $r = cmd /c "node gate\cli.mjs service start 2>&1"
    Pop-Location
    Say "Versutus gate: $r"
}
Say 'chain done'
