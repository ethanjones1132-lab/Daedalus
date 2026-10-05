# Night queue, 2026-10-05: runs the commands in night-queue.txt one at a time, in order, each
# through cmd /c with output appended to its own log. Finished lines are recorded in
# night-queue.done, so a restart resumes. Lines can be appended while it runs.
# First it waits for the overnight chain (best-of-N, then the thinking sweep) to finish.
# When the queue has been empty for 20 minutes, it restores the Versutus gate (unless
# HOLD_VERSUTUS exists) and exits.
$ErrorActionPreference = 'Continue'
$stage = 'C:\qwen3-forge-stage'
$q = "$stage\night-queue.txt"
$done = "$stage\night-queue.done"
$log = "$stage\logs\night-queue-2026-10-05.log"
function Say($m) { Add-Content -Path $log -Value "$(Get-Date -Format 'HH:mm:ss') $m" -Encoding UTF8 }
Say 'queue runner start; waiting for the overnight chain'
while (-not (Select-String -Path "$stage\logs\overnight-2026-10-05.log" -Pattern 'chain done' -Quiet)) { Start-Sleep -Seconds 30 }
Remove-Item "$stage\HOLD_VERSUTUS" -ErrorAction SilentlyContinue  # it only kept chain 1 from restoring the gate
Say 'overnight chain done; draining the queue'
$idle = 0
while ($true) {
    $lines = @(Get-Content $q -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -and -not $_.StartsWith('#') })
    $fin = @(Get-Content $done -ErrorAction SilentlyContinue)
    $next = $lines | Where-Object { $fin -notcontains $_ } | Select-Object -First 1
    if ($next) {
        $idle = 0
        Say "run: $next"
        cmd /c "$next >> $stage\logs\night-queue-jobs-2026-10-05.out 2>&1"
        Say "exit $LASTEXITCODE"
        Add-Content -Path $done -Value $next -Encoding UTF8
        Start-Sleep -Seconds 30  # breathing room for the SSD between model loads
    } else {
        if ($idle -ge 40) { break }
        $idle++
        Start-Sleep -Seconds 30
    }
}
if (Test-Path "$stage\HOLD_VERSUTUS") {
    Say 'queue empty; HOLD_VERSUTUS present, gate left paused'
} else {
    Push-Location 'C:\Projects\Versutus'
    $r = cmd /c "node gate\cli.mjs service start 2>&1"
    Pop-Location
    Say "queue empty; Versutus gate: $r"
}
Say 'queue runner done'
