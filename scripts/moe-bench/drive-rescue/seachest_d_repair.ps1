# Run elevated: repair D: (Seagate Game Drive, disk 1), approved by the user 2026-10-04
# ("SeaTools ... then Fix All if it's just a few bad sectors").
# Diagnosis: SMART passed; 96 pending logical sectors (= 12 physical 4K blocks), 0 reallocated,
# 0 CRC errors; short DST fails at LBA 6293520 (0x600810), the NTFS MFT's first records.
#  1. read-only safety copy of the disk head and the MFT region (d_copy.py), with a map of
#     unreadable blocks; stops here unless both copies succeed with at most 64 bad blocks
#  2. openSeaChest --dstAndClean: rewrite only LBAs the self-test cannot read (data already lost)
#  3. re-check SMART; only if nothing is left pending, chkdsk D: /f /x
# (The first two versions of step 1 used .NET FileStream on the raw device and failed before
# reading anything; the guard stopped them before any repair.)
$bin = 'C:\qwen3-forge-stage\tools\openSeaChest\openSeaChest-v26.03.2-win-x64'
$smart = "$bin\openSeaChest_SMART.exe"
$py = 'C:\qwen3-forge-stage\venv\Scripts\python.exe'
$copy = 'C:\qwen3-forge-stage\scripts\d_copy.py'
$dir = 'C:\qwen3-forge-stage\d-rescue'
$log = "$dir\repair-2026-10-04c.txt"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function Pending() {
    $t = & $smart -d PD1 --smartAttributes hybrid 2>&1 | Out-String
    $m = [regex]::Match($t, '197 Pending-Sparing Count\s+\S+\s+\d+\s+\d+\s+\S+\s+(\d+)')
    $r = [regex]::Match($t, '\s5 Retired Sectors Count\s+\S+\s+\d+\s+\d+\s+\S+\s+(\d+)')
    [pscustomobject]@{ pending = if ($m.Success) { [int]$m.Groups[1].Value } else { -1 };
                       retired = if ($r.Success) { [int]$r.Groups[1].Value } else { -1 } }
}

& {
    "started $(Get-Date -Format s)"
    "`n== 1. safety copy (read-only)"
    & $py $copy '\\.\PhysicalDrive1' "$dir\disk-head-8MB.bin" 0 16384 2>&1; $e1 = $LASTEXITCODE
    & $py $copy '\\.\PhysicalDrive1' "$dir\mft-region-320MB.bin" 0x600800 655360 2>&1; $e2 = $LASTEXITCODE
    if ($e1 -ne 0 -or $e2 -ne 0) {
        "STOPPED before any repair: safety copy exit codes $e1 / $e2"; "`ndone $(Get-Date -Format s)"; return
    }
    $p0 = Pending; "SMART before repair: pending=$($p0.pending) retired=$($p0.retired)"

    "`n== 2. dstAndClean $(Get-Date -Format HH:mm:ss)"
    & $smart -d PD1 --dstAndClean --errorLimit 160 2>&1
    $p1 = Pending; "SMART after repair: pending=$($p1.pending) retired=$($p1.retired)"
    "`n== short DST re-check"
    & $smart -d PD1 --shortDST --poll 2>&1
    & $smart -d PD1 --showDSTLog 2>&1

    "`n== 3. chkdsk $(Get-Date -Format HH:mm:ss)"
    if ($p1.pending -eq 0) { chkdsk D: /f /x 2>&1; "chkdsk exit code: $LASTEXITCODE" }
    else { "SKIPPED chkdsk: $($p1.pending) sectors still pending (or SMART unreadable)" }
    "`ndone $(Get-Date -Format s)"
} *>&1 | Out-File -FilePath $log -Encoding utf8
Write-Host "Saved to $log. This window closes in 15 seconds."
Start-Sleep -Seconds 15
