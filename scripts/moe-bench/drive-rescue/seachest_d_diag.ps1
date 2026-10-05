# Run elevated, read-only: health diagnosis of the Seagate USB drive (D:) with Seagate's
# openSeaChest v26.03.2 (approved by the user 2026-10-04). Nothing here writes to the drive;
# the short DST is the drive's own non-destructive self-test.
$bin = 'C:\qwen3-forge-stage\tools\openSeaChest\openSeaChest-v26.03.2-win-x64'
$out = 'C:\qwen3-forge-stage\logs\seachest-D-2026-10-04.txt'
$smart = "$bin\openSeaChest_SMART.exe"

function Step($title, [string[]]$argv) {
    "`n==================== $title ($(Get-Date -Format HH:mm:ss))"
    & $smart @argv 2>&1
}

& {
    Step 'scan' @('--scan')
    # The Seagate is disk 1 (PhysicalDrive1 = handle PD1); confirm in the scan above.
    $dev = 'PD1'
    Step 'device info' @('-d', $dev, '-i')
    Step 'SMART check' @('-d', $dev, '--smartCheck')
    Step 'SMART attributes' @('-d', $dev, '--smartAttributes', 'hybrid')
    Step 'SMART error log' @('-d', $dev, '--showSMARTErrorLog', 'summary')
    Step 'DST log (before)' @('-d', $dev, '--showDSTLog')
    Step 'short DST' @('-d', $dev, '--shortDST', '--poll')
    Step 'DST log (after)' @('-d', $dev, '--showDSTLog')
    Step 'FARM reliability log' @('-d', $dev, '--showFARM')
    "`n==================== done $(Get-Date -Format s)"
} *>&1 | Out-File -FilePath $out -Encoding utf8
Write-Host "Saved to $out. This window closes in 10 seconds."
Start-Sleep -Seconds 10
