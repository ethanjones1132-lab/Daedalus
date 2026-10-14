# Run elevated: repair D:'s NTFS metadata with chkdsk /f /x (approved by the user 2026-10-04).
# D: stopped mounting because the first sectors of its master file table (LBA 0x600800 and
# 0x600810) are unreadable; /f rebuilds those records from $MFTMirr and rewrites them, which
# makes the drive remap the bad sectors. No /r: a full surface scan would stress a failing drive.
$log = 'C:\qwen3-forge-stage\logs\chkdsk-D-2026-10-04.log'
"started $(Get-Date -Format s)" | Out-File -FilePath $log -Encoding utf8
chkdsk D: /f /x 2>&1 | ForEach-Object { $_; "$_" | Out-File -FilePath $log -Append -Encoding utf8 }
$code = $LASTEXITCODE
"chkdsk exit code: $code  finished $(Get-Date -Format s)" | Out-File -FilePath $log -Append -Encoding utf8
Write-Host "`nchkdsk exit code: $code. This window closes in 30 seconds."
Start-Sleep -Seconds 30
