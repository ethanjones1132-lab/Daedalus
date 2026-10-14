# Run elevated (approved by the user 2026-10-04, "resume with safeguards"):
#  1. read-only SMART check of D: (Seagate, PD1) after SeaTools Fix All Long
#  2. log C:'s NVMe temperature every 15 s (Get-StorageReliabilityCounter needs admin) until
#     C:\qwen3-forge-stage\STOP_SSD_WATCH exists or 6 hours pass. ssd_guard.ps1 reads the log.
$smart = 'C:\qwen3-forge-stage\tools\openSeaChest\openSeaChest-v26.03.2-win-x64\openSeaChest_SMART.exe'
$d = 'C:\qwen3-forge-stage\d-rescue\smart-after-fixall-long-2026-10-04.txt'
$t = 'C:\qwen3-forge-stage\logs\nvme-temp-2026-10-04.log'
$stop = 'C:\qwen3-forge-stage\STOP_SSD_WATCH'
& {
    "checked $(Get-Date -Format s)"
    $a = & $smart -d PD1 --smartAttributes hybrid 2>&1 | Out-String
    $a -split "`n" | Where-Object { $_ -match '^\S?\s+(5|187|197|198|199) ' }
    & $smart -d PD1 --showDSTLog 2>&1 | Select-Object -Last 6
} *>&1 | Out-File -FilePath $d -Encoding utf8
Remove-Item -LiteralPath $stop -ErrorAction SilentlyContinue
$end = (Get-Date).AddHours(6)
while ((Get-Date) -lt $end -and -not (Test-Path -LiteralPath $stop)) {
    try {
        $c = Get-PhysicalDisk | Where-Object DeviceId -eq '0' | Get-StorageReliabilityCounter
        "$(Get-Date -Format HH:mm:ss) $($c.Temperature)" | Out-File -FilePath $t -Append -Encoding ascii
    } catch { "$(Get-Date -Format HH:mm:ss) error $($_.Exception.Message)" | Out-File -FilePath $t -Append -Encoding ascii }
    Start-Sleep -Seconds 15
}
