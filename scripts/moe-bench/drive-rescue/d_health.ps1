# Run elevated, read-only: what Windows can read of the Seagate's (disk 1) health over USB
# (approved by the user 2026-10-04 while planning D: recovery).
$out = 'C:\qwen3-forge-stage\logs\d-health-2026-10-04.txt'
& {
    "checked $(Get-Date -Format s)"
    $d = Get-PhysicalDisk | Where-Object BusType -eq 'USB'
    $d | Format-List FriendlyName, SerialNumber, FirmwareVersion, MediaType, HealthStatus, OperationalStatus, Size
    $d | Get-StorageReliabilityCounter | Format-List *
    "--- WMI SMART failure prediction (often blocked by USB bridges):"
    Get-CimInstance -Namespace root\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction SilentlyContinue |
        Format-List InstanceName, PredictFailure, Reason
} *>&1 | Out-File -FilePath $out -Encoding utf8
Write-Host "Saved to $out. This window closes in 10 seconds."
Start-Sleep -Seconds 10
