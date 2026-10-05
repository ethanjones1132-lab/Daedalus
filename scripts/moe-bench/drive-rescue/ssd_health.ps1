# Run elevated, read-only: health counters of the system NVMe (disk 0), approved by the user 2026-10-04
# after a bugcheck 0x124 that stornvme raised for this drive.
$out = 'C:\qwen3-forge-stage\logs\ssd-health-2026-10-04.txt'
$d = Get-PhysicalDisk | Where-Object DeviceId -eq '0'
& {
    "checked $(Get-Date -Format s)"
    $d | Format-List FriendlyName, SerialNumber, FirmwareVersion, MediaType, BusType, HealthStatus, OperationalStatus, Size
    $d | Get-StorageReliabilityCounter | Format-List *
} *>&1 | Out-File -FilePath $out -Encoding utf8
Write-Host "Saved to $out. This window closes in 10 seconds."
Start-Sleep -Seconds 10
