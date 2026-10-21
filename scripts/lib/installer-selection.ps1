function Select-JarvisRunInstaller {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory,

        [Parameter(Mandatory = $true)]
        [DateTime]$RunStartedAtUtc,

        [object[]]$PreRunFingerprints = @(),

        [bool]$InstallerBuildRan = $false
    )

    # A file appearing during this script is not enough: an independent build
    # may write to the same target directory. Only inspect outputs when this
    # run actually invoked a command that builds the NSIS installer.
    if (-not $InstallerBuildRan) { return $null }
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $null }

    $runStartUtc = $RunStartedAtUtc
    if ($runStartUtc.Kind -eq [DateTimeKind]::Local) {
        $runStartUtc = $runStartUtc.ToUniversalTime()
    } elseif ($runStartUtc.Kind -eq [DateTimeKind]::Unspecified) {
        $runStartUtc = [DateTime]::SpecifyKind($runStartUtc, [DateTimeKind]::Utc)
    }

    $eligible = @()
    $installers = Get-ChildItem -LiteralPath $Directory -Filter '*.exe' -Recurse -File -ErrorAction SilentlyContinue
    foreach ($installer in $installers) {
        if ($installer.LastWriteTimeUtc -le $runStartUtc) { continue }

        $fingerprint = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash
        $fullPath = [IO.Path]::GetFullPath($installer.FullName)
        $wasPresent = $false
        foreach ($before in $PreRunFingerprints) {
            if ($before.Sha256 -and $before.Sha256 -eq $fingerprint) {
                $wasPresent = $true
                break
            }

            if ($before.FullName -and
                [string]::Equals([IO.Path]::GetFullPath($before.FullName), $fullPath, [StringComparison]::OrdinalIgnoreCase) -and
                $before.LastWriteTimeUtc -and
                $installer.LastWriteTimeUtc -le ([DateTime]$before.LastWriteTimeUtc).ToUniversalTime()) {
                $wasPresent = $true
                break
            }
        }
        if (-not $wasPresent) { $eligible += $installer }
    }

    if ($eligible.Count -eq 0) { return $null }
    return $eligible | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
}
