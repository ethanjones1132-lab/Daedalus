# Build script for Windows — run this in PowerShell
$project = "Y:\"
$desktop = [Environment]::GetFolderPath("Desktop")

Write-Host "[Home Base] Building Tauri app for Windows (with bundle)..." -ForegroundColor Cyan
Set-Location $project
$env:CARGO_TARGET_DIR = Join-Path $env:USERPROFILE ".cargo-target\home-base"

# Build the Tauri app with bundler (produces exe + MSI/NSIS installer)
cargo tauri build 2>&1

if ($LASTEXITCODE -eq 0) {
    $targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { "$project\src-tauri\target" }
    $exeDir    = "$targetDir\release"
    $binary    = "$exeDir\home-base.exe"

    # Find installer: prefer NSIS .exe, fall back to MSI
    $nsis = Get-ChildItem -Path "$targetDir\release\bundle\nsis"  -Filter "*.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    $msi  = Get-ChildItem -Path "$targetDir\release\bundle\msi"   -Filter "*.msi" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    $installer = if ($nsis) { $nsis } elseif ($msi) { $msi } else { $null }

    $now = Get-Date
    $destinations = @($desktop)
    $localDesktop = "C:\Users\ethan\Desktop"
    if ((Test-Path $localDesktop) -and ($localDesktop -ne $desktop)) {
        $destinations += $localDesktop
    }

    if (Test-Path $binary) {
        foreach ($d in $destinations) {
            $jDest = Join-Path $d "Jarvis.exe"
            Copy-Item $binary $jDest -Force
            (Get-Item $jDest).LastWriteTime = $now
        }
        Write-Host "[Home Base] SUCCESS: Jarvis.exe placed on Desktop(s)" -ForegroundColor Green
    } else {
        Write-Host "[Home Base] WARNING: binary not found at $binary" -ForegroundColor Yellow
    }

    if ($installer) {
        $ext = [IO.Path]::GetExtension($installer.Name)
        foreach ($d in $destinations) {
            $instDest = Join-Path $d "Jarvis-installer$ext"
            Copy-Item $installer.FullName $instDest -Force
            (Get-Item $instDest).LastWriteTime = $now
        }
        Write-Host "[Home Base] SUCCESS: Jarvis-installer$ext placed on Desktop(s)" -ForegroundColor Green
    } else {
        Write-Host "[Home Base] WARNING: no installer bundle found" -ForegroundColor Yellow
    }
} else {
    Write-Host "[Home Base] FAILED: Build failed" -ForegroundColor Red
    exit 1
}