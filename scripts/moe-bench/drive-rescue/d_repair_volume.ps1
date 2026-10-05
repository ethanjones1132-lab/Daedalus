# Run elevated, 2026-10-04 (user chose "chkdsk now"): chkdsk D: /f /x reported "file system
# is RAW" right after its forced dismount although D: is mounted as NTFS ("Full Repair
# Needed"). Same repair through the storage API instead: online scan, then offline fix.
$log = 'C:\qwen3-forge-stage\d-rescue\repair-volume-2026-10-04.txt'
& {
    "started $(Get-Date -Format s)"
    "== volume before"; Get-Volume -DriveLetter D | Format-List FileSystem, OperationalStatus, HealthStatus
    "== Repair-Volume -Scan $(Get-Date -Format HH:mm:ss)"
    try { Repair-Volume -DriveLetter D -Scan -ErrorAction Stop } catch { "scan error: $($_.Exception.Message)" }
    "== Repair-Volume -OfflineScanAndFix $(Get-Date -Format HH:mm:ss)"
    try { Repair-Volume -DriveLetter D -OfflineScanAndFix -ErrorAction Stop } catch { "fix error: $($_.Exception.Message)" }
    "== volume after $(Get-Date -Format HH:mm:ss)"; Get-Volume -DriveLetter D | Format-List FileSystem, OperationalStatus, HealthStatus
    "== access test"
    foreach ($d in 'D:\(personal folder)', 'D:\qwen3-forge', 'D:\Data') {
        try { $n = @(Get-ChildItem -LiteralPath $d -Force -ErrorAction Stop).Count; "$d OK ($n entries)" } catch { "$d $($_.Exception.Message)" }
    }
    "done $(Get-Date -Format s)"
} *>&1 | Out-File -FilePath $log -Encoding utf8
Write-Host "Saved to $log. This window closes in 15 seconds."
Start-Sleep -Seconds 15
