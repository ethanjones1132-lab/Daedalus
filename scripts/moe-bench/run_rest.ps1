# Detached, sequential (2026-10-04, replaces after_keep24.ps1 + after_chain1.ps1 after the
# speed lab gained its RAM-floor fallback and --no-mmap lever): three-model speed lab,
# their sampling sweeps, then the user-requested gpt-oss keep24 target (rebuild, lab, sweep).
$log = 'C:\qwen3-forge-stage\logs\pipeline-2026-10-04.log'
$py  = 'C:\qwen3-forge-stage\venv\Scripts\python.exe'
$s   = 'C:\qwen3-forge-stage\scripts'
$L   = 'C:\qwen3-forge-stage\logs'
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }
function Clear-Servers { Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force }

Clear-Servers
Log 'run_rest: speed lab (gptoss20b, gemma26b, qwen36keep96)'
& $py "$s\speedlab.py" gptoss20b gemma26b qwen36keep96 *> "$L\speedlab-stdout-2026-10-04.log"
Clear-Servers
Log 'run_rest: sampling sweep (gptoss20b, gemma26b, qwen36keep96)'
& $py "$s\sampling_sweep.py" gptoss20b gemma26b qwen36keep96 *> "$L\sampling-stdout-2026-10-04.log"
Clear-Servers
Log 'run_rest: rebuilding the keep24 slice'
& $py "$s\make_keep24.py" *> "$L\keep24-remake-stdout-2026-10-04.log"
Log 'run_rest: speed lab (gptoss20b-keep24)'
& $py "$s\speedlab.py" gptoss20b-keep24 *> "$L\speedlab-keep24-stdout-2026-10-04.log"
Clear-Servers
Log 'run_rest: sampling sweep (gptoss20b-keep24)'
& $py "$s\sampling_sweep.py" gptoss20b-keep24 *> "$L\sampling-keep24-stdout-2026-10-04.log"
Clear-Servers
Log 'run_rest: all runs finished'
