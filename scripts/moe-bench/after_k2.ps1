# Detached: once the K2-Horizon retry exits, run pruning pilot part 2.
$log = 'C:\qwen3-forge-stage\logs\pipeline-2026-10-04.log'
$py  = 'C:\qwen3-forge-stage\venv\Scripts\python.exe'
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }
Start-Sleep -Seconds 120   # the K2 retry starts about a minute after the pruning pilot exits
while (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'model_pipeline\.py|after_prune\.ps1' }) {
    Start-Sleep -Seconds 60
}
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Log 'after_k2: starting pruning pilot part 2 (prune_more.py)'
& $py 'C:\qwen3-forge-stage\scripts\prune_more.py' *> 'C:\qwen3-forge-stage\logs\prune2-stdout-2026-10-04.log'
Log 'after_k2: pruning pilot part 2 exited'
