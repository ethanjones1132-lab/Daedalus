# Detached: after the three-model chain (after_keep24.ps1) finishes, run the user-requested
# fourth target, gpt-oss-20b keep24: rebuild the slice, speed lab, sampling sweep.
$log = 'C:\qwen3-forge-stage\logs\pipeline-2026-10-04.log'
$py  = 'C:\qwen3-forge-stage\venv\Scripts\python.exe'
$s   = 'C:\qwen3-forge-stage\scripts'
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }
while (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'after_keep24\.ps1|speedlab\.py|sampling_sweep\.py' -and $_.ProcessId -ne $PID }) {
    Start-Sleep -Seconds 60
}
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Log 'after_chain1: rebuilding the keep24 slice'
& $py "$s\make_keep24.py" *> 'C:\qwen3-forge-stage\logs\keep24-remake-stdout-2026-10-04.log'
Log 'after_chain1: speed lab for gptoss20b-keep24'
& $py "$s\speedlab.py" gptoss20b-keep24 *> 'C:\qwen3-forge-stage\logs\speedlab-keep24-stdout-2026-10-04.log'
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Log 'after_chain1: sampling sweep for gptoss20b-keep24'
& $py "$s\sampling_sweep.py" gptoss20b-keep24 *> 'C:\qwen3-forge-stage\logs\sampling-keep24-stdout-2026-10-04.log'
Log 'after_chain1: all runs finished (including keep24)'
