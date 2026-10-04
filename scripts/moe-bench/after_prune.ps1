# Detached: once the pruning pilot exits, retry K2-Horizon (attn_v_exps on the CPU).
$log = 'C:\qwen3-forge-stage\logs\pipeline-2026-10-04.log'
$py  = 'C:\qwen3-forge-stage\venv\Scripts\python.exe'
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }
while (Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'prune_experiment\.py' }) {
    Start-Sleep -Seconds 60
}
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Log 'after_prune: retrying K2-Horizon with attn_v_exps on the CPU'
& $py 'C:\qwen3-forge-stage\scripts\model_pipeline.py' k2h-iq3xxs *> 'C:\qwen3-forge-stage\logs\k2-retry-stdout-2026-10-04.log'
Log 'after_prune: K2 retry exited'
