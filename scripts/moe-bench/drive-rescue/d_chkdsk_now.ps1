# Run elevated: chkdsk D: /f /x, chosen by the user 2026-10-04 18:45 ("chkdsk now") with
# 32 sectors still pending after SeaTools Fix All Long. D: mounts but every folder is
# "access denied" because the rewritten MFT records included $Secure.
$smart = 'C:\qwen3-forge-stage\tools\openSeaChest\openSeaChest-v26.03.2-win-x64\openSeaChest_SMART.exe'
$log = 'C:\qwen3-forge-stage\d-rescue\chkdsk-final-2026-10-04.txt'
& {
    "started $(Get-Date -Format s)"
    (& $smart -d PD1 --smartAttributes hybrid 2>&1 | Out-String) -split "`n" | Where-Object { $_ -match '^\S?\s+(5|197) ' }
    "`n== chkdsk $(Get-Date -Format HH:mm:ss)"
    chkdsk D: /f /x 2>&1
    "chkdsk exit code: $LASTEXITCODE"
    (& $smart -d PD1 --smartAttributes hybrid 2>&1 | Out-String) -split "`n" | Where-Object { $_ -match '^\S?\s+(5|197) ' }
    "`ndone $(Get-Date -Format s)"
} *>&1 | Out-File -FilePath $log -Encoding utf8
Write-Host "Saved to $log. This window closes in 15 seconds."
Start-Sleep -Seconds 15
