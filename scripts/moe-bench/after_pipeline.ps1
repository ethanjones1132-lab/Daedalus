# Detached: once the model pipeline exits,
#  1. retry K2-Horizon with its attention experts on the CPU (-ot attn_v_exps=CPU),
#  2. then run the Track A pruning pilot.
# Survives Claude session restarts; logs go to C:\qwen3-forge-stage\logs.
$log = 'C:\qwen3-forge-stage\logs\pipeline-2026-10-04.log'
$py  = 'C:\qwen3-forge-stage\venv\Scripts\python.exe'
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }
while (Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'model_pipeline\.py' }) {
    Start-Sleep -Seconds 60
}
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force   # no stray probe servers
Log 'after_pipeline: retrying K2-Horizon with attn_v_exps on the CPU'
& $py 'C:\qwen3-forge-stage\scripts\model_pipeline.py' k2h-iq3xxs *> 'C:\qwen3-forge-stage\logs\k2-retry-stdout-2026-10-04.log'
Log 'after_pipeline: starting the pruning pilot (prune_experiment.py)'
& $py 'C:\qwen3-forge-stage\scripts\prune_experiment.py' *> 'C:\qwen3-forge-stage\logs\prune-stdout-2026-10-04.log'
Log 'after_pipeline: pruning pilot exited'
