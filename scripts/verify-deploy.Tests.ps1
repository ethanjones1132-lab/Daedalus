$scriptPath = Join-Path $PSScriptRoot 'verify-deploy.ps1'
$source = Get-Content -LiteralPath $scriptPath -Raw

$buildPath = Join-Path $PSScriptRoot 'build-and-deploy.ps1'
$buildSource = Get-Content -LiteralPath $buildPath -Raw

Describe 'verify-deploy installer provenance' {
    It 'verifies the NSIS installer hash against the manifest when present' {
        $source | Should Match ([regex]::Escape('$manifest.installer_sha256'))
        $source | Should Match ([regex]::Escape('Get-FileHash -LiteralPath $installerPath -Algorithm SHA256'))
    }

    It 'skips with a clear message when no installer is present' {
        $source | Should Match 'skipping installer provenance check'
        $source | Should Match ([regex]::Escape('-not $installerPath'))
    }
}

Describe 'build-and-deploy installer provenance emission' {
    It 'deploys the NSIS bundle as Jarvis-installer.exe' {
        $buildSource | Should Match ([regex]::Escape("Deploy-File `$installer.FullName 'Jarvis-installer.exe'"))
    }

    It 'records the installer name and SHA-256 in the deploy manifest' {
        $buildSource | Should Match ([regex]::Escape('installer_name = $installerName'))
        $buildSource | Should Match ([regex]::Escape('installer_sha256 = $installerSha256'))
    }
}
