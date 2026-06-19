... 79 lines not shown ...
    80|}
L-Ok "Frontend dist/ verified"

# ─── Phase 2: Tauri build ───────────────────────────────────────────────────────
if (-not $SkipTauri) {
    $tauriConf = Join-Path $TAURI "tauri.conf.json"
    $origConf = [System.IO.File]::ReadAllText($tauriConf)
    $tempConf = $origConf `
        -replace '"beforeBuildCommand"\s*:\s*"[^"]*"\s*,?\s*','' `
        -replace '"beforeDevCommand"\s*:\s*"[^"]*"\s*,?\s*',''
    90|    [System.IO.File]::WriteAllText($tauriConf, $tempConf)

    L-Info "Building Tauri application (x86_64-pc-windows-msvc)..."
    $tauriSw = [System.Diagnostics.Stopwatch]::StartNew()

    $buildExit = Run-Command "cargo.exe" "tauri build --target x86_64-pc-windows-msvc" $TAURI

    [System.IO.File]::WriteAllText($tauriConf, $origConf)
    $tauriSw.Stop()

   100|    if ($buildExit -ne 0) {
        L-Fail "cargo tauri build failed (exit $buildExit)"
    }
    L-Ok "Tauri build completed ($($tauriSw.Elapsed.ToString('mm\:ss')))"

    $targetDir = Join-Path $ROOT "target\x86_64-pc-windows-msvc\release"
    $exe       = Join-Path $targetDir "home-base.exe"
    $nsisDir   = Join-Path $targetDir "bundle\nsis"

    if (-not (Test-Path $exe)) {
   110|        L-Fail "Tauri binary not found at $exe"
    }
    L-Ok "Tauri binary: $exe"

    $installer = Get-ChildItem -Path $nsisDir -Filter "*.exe" -Recurse `
                 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($installer) {
        L-Ok "NSIS installer: $($installer.FullName)"
    } else {
        L-Warn "No NSIS installer found"
   120|    }

    if (-not $SkipDesktop) {
        $desktop = [Environment]::GetFolderPath("Desktop")
        if (Test-Path $desktop) {
            $dstExe = Join-Path $desktop "Jarvis.exe"
            $dstInst = Join-Path $desktop "Jarvis-installer.exe"
            if (Test-Path $dstExe) { Remove-Item $dstExe -Force -ErrorAction SilentlyContinue }
            if (Test-Path $dstInst) { Remove-Item $dstInst -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Milliseconds 500
   130|            Copy-Item $exe $dstExe -Force
            L-Ok "Copied Jarvis.exe to Desktop"
            if ($installer) {
                Copy-Item $installer.FullName $dstInst -Force
                L-Ok "Copied Jarvis-installer.exe to Desktop"
            }
        }
    }

    $totalSw.Stop()
   140|    L-Ok "FULL BUILD SUCCESS ($($totalSw.Elapsed.ToString('mm\:ss')))"
    L-Info "Artifacts: $targetDir"
} else {
    $totalSw.Stop()
    L-Ok "BUILD SUCCESS (WSL only, Tauri skipped) ($($totalSw.Elapsed.ToString('mm\:ss')))"
}
