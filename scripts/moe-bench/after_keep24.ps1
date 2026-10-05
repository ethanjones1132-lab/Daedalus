# Detached: once the keep24 pruning run exits, run the three-model speed lab, then the
# sampling sweep (the user's plan, 2026-10-04). The Versutus gate stays paused throughout.
$log = 'C:\qwen3-forge-stage\logs\pipeline-2026-10-04.log'
$py  = 'C:\qwen3-forge-stage\venv\Scripts\python.exe'
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }
while (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'prune_gptoss\.py' }) {
    Start-Sleep -Seconds 60
}
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Log 'after_keep24: starting speed lab (gptoss20b, gemma26b, qwen36keep96)'
& $py 'C:\qwen3-forge-stage\scripts\speedlab.py' *> 'C:\qwen3-forge-stage\logs\speedlab-stdout-2026-10-04.log'
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Log 'after_keep24: starting sampling sweep'
& $py 'C:\qwen3-forge-stage\scripts\sampling_sweep.py' *> 'C:\qwen3-forge-stage\logs\sampling-stdout-2026-10-04.log'
Log 'after_keep24: all runs finished'
