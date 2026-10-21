$libraryPath = Join-Path $PSScriptRoot 'lib\installer-selection.ps1'
if (Test-Path -LiteralPath $libraryPath) {
    . $libraryPath
}

function Get-TestInstallerFingerprint {
    param([string]$Path)

    $file = Get-Item -LiteralPath $Path
    [pscustomobject]@{
        FullName         = [IO.Path]::GetFullPath($file.FullName)
        Length           = $file.Length
        LastWriteTimeUtc = $file.LastWriteTimeUtc
        Sha256           = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
}

Describe 'Select-JarvisRunInstaller' {
    BeforeEach {
        $script:installerDirectory = Join-Path ([IO.Path]::GetTempPath()) ('jarvis-nsis-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:installerDirectory -Force | Out-Null
        $script:runStartedAtUtc = [DateTime]::UtcNow
    }

    AfterEach {
        Remove-Item -LiteralPath $script:installerDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }

    It 'selects neither the newer nor older exe that already existed before the run' {
        $olderPath = Join-Path $script:installerDirectory 'older.exe'
        $newerPath = Join-Path $script:installerDirectory 'newer.exe'
        [IO.File]::WriteAllText($olderPath, 'older pre-existing installer')
        [IO.File]::WriteAllText($newerPath, 'newer pre-existing installer')
        [IO.File]::SetLastWriteTimeUtc($olderPath, $script:runStartedAtUtc.AddMinutes(-20))
        [IO.File]::SetLastWriteTimeUtc($newerPath, $script:runStartedAtUtc.AddMinutes(-10))
        $preRunFingerprints = @(
            (Get-TestInstallerFingerprint $olderPath)
            (Get-TestInstallerFingerprint $newerPath)
        )

        $selected = Select-JarvisRunInstaller -Directory $script:installerDirectory `
            -RunStartedAtUtc $script:runStartedAtUtc -PreRunFingerprints $preRunFingerprints `
            -InstallerBuildRan $true

        ($null -eq $selected) | Should Be $true
    }

    It 'rejects a pre-run fingerprint even when its timestamp is touched during the run' {
        $path = Join-Path $script:installerDirectory 'existing.exe'
        [IO.File]::WriteAllText($path, 'pre-existing installer bytes')
        [IO.File]::SetLastWriteTimeUtc($path, $script:runStartedAtUtc.AddMinutes(-5))
        $preRunFingerprints = @(Get-TestInstallerFingerprint $path)
        [IO.File]::SetLastWriteTimeUtc($path, $script:runStartedAtUtc.AddMinutes(1))

        $selected = Select-JarvisRunInstaller -Directory $script:installerDirectory `
            -RunStartedAtUtc $script:runStartedAtUtc -PreRunFingerprints $preRunFingerprints `
            -InstallerBuildRan $true

        ($null -eq $selected) | Should Be $true
    }

    It 'rejects a changed exe whose timestamp predates the run' {
        $path = Join-Path $script:installerDirectory 'changed.exe'
        [IO.File]::WriteAllText($path, 'pre-run installer bytes')
        [IO.File]::SetLastWriteTimeUtc($path, $script:runStartedAtUtc.AddMinutes(-5))
        $preRunFingerprints = @(Get-TestInstallerFingerprint $path)
        [IO.File]::WriteAllText($path, 'different installer bytes')
        [IO.File]::SetLastWriteTimeUtc($path, $script:runStartedAtUtc.AddMinutes(-4))

        $selected = Select-JarvisRunInstaller -Directory $script:installerDirectory `
            -RunStartedAtUtc $script:runStartedAtUtc -PreRunFingerprints $preRunFingerprints `
            -InstallerBuildRan $true

        ($null -eq $selected) | Should Be $true
    }

    It 'returns nothing when this run did not build an installer' {
        $path = Join-Path $script:installerDirectory 'unrelated-new.exe'
        [IO.File]::WriteAllText($path, 'unrelated installer')
        [IO.File]::SetLastWriteTimeUtc($path, $script:runStartedAtUtc.AddMinutes(1))

        $selected = Select-JarvisRunInstaller -Directory $script:installerDirectory `
            -RunStartedAtUtc $script:runStartedAtUtc -PreRunFingerprints @() `
            -InstallerBuildRan $false

        ($null -eq $selected) | Should Be $true
    }

    It 'selects an installer with a new fingerprint and post-start timestamp after a successful build' {
        $path = Join-Path $script:installerDirectory 'built-this-run.exe'
        [IO.File]::WriteAllText($path, 'installer built by this run')
        [IO.File]::SetLastWriteTimeUtc($path, $script:runStartedAtUtc.AddMinutes(1))

        $selected = Select-JarvisRunInstaller -Directory $script:installerDirectory `
            -RunStartedAtUtc $script:runStartedAtUtc -PreRunFingerprints @() `
            -InstallerBuildRan $true

        $selected.FullName | Should Be ([IO.Path]::GetFullPath($path))
    }

    It 'returns nothing when no installer exists' {
        $selected = Select-JarvisRunInstaller -Directory $script:installerDirectory `
            -RunStartedAtUtc $script:runStartedAtUtc -PreRunFingerprints @() `
            -InstallerBuildRan $true

        ($null -eq $selected) | Should Be $true
    }
}
