# Detached, not elevated: stop every benchmark run if C:'s NVMe passes the temperature limit.
# Reads the log that ssd_watch.ps1 (elevated) writes every 15 s. All runs are restart-safe,
# so stopping loses at most the probe or sample in flight. Exits when STOP_SSD_WATCH exists.
param([int]$LimitC = 70)
$t = 'C:\qwen3-forge-stage\logs\nvme-temp-2026-10-04.log'
$log = 'C:\qwen3-forge-stage\logs\pipeline-2026-10-04.log'
$stop = 'C:\qwen3-forge-stage\STOP_SSD_WATCH'
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -FilePath $log -Append -Encoding utf8 }
Log "ssd_guard: watching C: NVMe temperature, limit $LimitC C"
$peak = 0
while (-not (Test-Path -LiteralPath $stop)) {
    $last = Get-Content -LiteralPath $t -Tail 1 -ErrorAction SilentlyContinue
    if ($last -match '^\S+ (\d+)$') {
        $c = [int]$Matches[1]
        if ($c -gt $peak) { $peak = $c; if ($peak -ge 55) { Log "ssd_guard: new peak $peak C" } }
        if ($c -ge $LimitC) {
            Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'run_rest\.ps1|speedlab\.py|sampling_sweep\.py|tier2b_llama\.py' } |
                ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
            Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
            Log "ssd_guard: SSD at $c C (limit $LimitC) - STOPPED all runs; restart run_rest.ps1 once it cools"
            break
        }
    }
    Start-Sleep -Seconds 15
}
