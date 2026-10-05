# Run elevated, approved by the user 2026-10-04: after SeaTools Fix All + a passing short DST,
# confirm (read-only) that SMART shows no pending sectors, then rebuild D:'s NTFS with chkdsk.
$smart = 'C:\qwen3-forge-stage\tools\openSeaChest\openSeaChest-v26.03.2-win-x64\openSeaChest_SMART.exe'
$log = 'C:\qwen3-forge-stage\d-rescue\chkdsk-after-fixall-2026-10-04.txt'
& {
    "started $(Get-Date -Format s)"
    $t = & $smart -d PD1 --smartAttributes hybrid 2>&1 | Out-String
    $t -split "`n" | Where-Object { $_ -match '^\S?\s+(5|187|197|198|199) ' }
    $m = [regex]::Match($t, '197 Pending-Sparing Count\s+\S+\s+\d+\s+\d+\s+\S+\s+(\d+)')
    $pending = if ($m.Success) { [int]$m.Groups[1].Value } else { -1 }
    "pending sectors: $pending"
    if ($pending -eq 0) { "`n== chkdsk $(Get-Date -Format HH:mm:ss)"; chkdsk D: /f /x 2>&1; "chkdsk exit code: $LASTEXITCODE" }
    else { "SKIPPED chkdsk: pending=$pending" }
    "`ndone $(Get-Date -Format s)"
} *>&1 | Out-File -FilePath $log -Encoding utf8
Write-Host "Saved to $log. This window closes in 15 seconds."
Start-Sleep -Seconds 15
