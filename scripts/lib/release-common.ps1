<#
.SYNOPSIS
    Shared helpers for the Jarvis release pipeline (build, provenance, signing, smoke).

.DESCRIPTION
    Dot-source this file. It has no top-level side effects:

        . (Join-Path $PSScriptRoot 'lib\release-common.ps1')

    The release pipeline is spread over three scripts (release-build.ps1,
    sign-installer.ps1, release-smoke.ps1) plus the older
    build-and-deploy.ps1 / verify-deploy.ps1 pair. Before this file existed
    each of them carried its own copy of the provenance rules, which is how
    the 2026-07 "the running server is a different build than the one on
    disk" incident got in: the producer and the verifier could disagree
    without anybody noticing. Everything below is the single implementation;
    the scripts call it.

    The bundle build itself is not here -- it lives in
    server-jarvis/src/build-frontend.ts, because Tauri's beforeBuildCommand
    needs it as a cross-platform script.

    Two properties are load-bearing and are covered by
    scripts/release-pipeline.Tests.ps1:

      * Get-JarvisSourceTreeSha256 reproduces the digest algorithm that
        build-and-deploy.ps1 and verify-deploy.ps1 already used, byte for
        byte. Changing it would silently invalidate every deploy manifest
        ever written, so it is asserted against a frozen vector.

      * The build identity has to actually reach the bundle. The bake
        folds it in with `bun build --define`, and Test-JarvisBundleProvenance
        then checks the built FILE for the commit and the source-tree
        digest, and for the absence of the runtime environment lookup. The
        check exists because bun build exits 0 even when a define folds to
        a bare JS identifier -- a bundle that throws a ReferenceError at
        module load, so the deployed server cannot boot.
#>

# ── Provenance primitives ─────────────────────────────────────────────────────

function Get-JarvisFileSha256 {
    <#
    .SYNOPSIS
        SHA-256 of a single file, uppercase hex.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "file_not_found:$Path"
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-JarvisSourceTreeSha256 {
    <#
    .SYNOPSIS
        Digest over the source tree that a build is claimed to come from.

    .DESCRIPTION
        SHA-256 over every file under server-jarvis/src, src-tauri/src,
        src-ui/src and scripts, as `<relative-path>:<file-hash>` joined by
        "\n". This is the value the server bakes in via
        `process.env.JARVIS_SOURCE_TREE_SHA256` and reports from /health,
        and the value verify-deploy.ps1 recomputes to decide whether the
        running build matches the tree on disk.

        The algorithm is frozen: changing the roots, the ordering, the
        per-file format or the join separator changes the digest of every
        existing manifest. Extend it only deliberately.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )
    $sourceRoots = @(
        (Join-Path $RepoRoot 'server-jarvis\src'),
        (Join-Path $RepoRoot 'src-tauri\src'),
        (Join-Path $RepoRoot 'src-ui\src'),
        (Join-Path $RepoRoot 'scripts')
    )
    $sourceFiles = Get-ChildItem -LiteralPath $sourceRoots -Recurse -File | Sort-Object FullName
    $sourceTreeText = foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($RepoRoot.Length).TrimStart('\')
        "${relative}:$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
    }
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $sourceTreeBytes = [Text.Encoding]::UTF8.GetBytes(($sourceTreeText -join "`n"))
        return ([BitConverter]::ToString($sha256.ComputeHash($sourceTreeBytes))).Replace('-', '')
    } finally {
        $sha256.Dispose()
    }
}

function Get-JarvisBuildIdentity {
    <#
    .SYNOPSIS
        The identity of the tree a build is taken from.

    .DESCRIPTION
        Captured ONCE, before the build starts, and then reused for the
        bundle defines, the Rust build and the release manifest. That is
        deliberate: build-and-deploy.ps1 re-used its pre-build
        `git rev-parse HEAD` for the manifest for exactly this reason --
        re-reading HEAD later would let the manifest disagree with the SHA
        actually baked into the binary if HEAD moved mid-run.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $sha = (& git -C $RepoRoot rev-parse HEAD 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $sha -notmatch '^[0-9a-f]{40}$') {
        throw "git_head_unavailable:$RepoRoot (got '$sha')"
    }
    $porcelain = (& git -C $RepoRoot status --porcelain 2>$null | Out-String)
    $dirty = -not [string]::IsNullOrWhiteSpace($porcelain)

    return [pscustomobject]@{
        git_sha             = $sha
        git_dirty           = $dirty
        built_at            = (Get-Date -Format 'o')
        source_tree_sha256  = (Get-JarvisSourceTreeSha256 -RepoRoot $RepoRoot)
    }
}

# ── Version consistency ──────────────────────────────────────────────────────

function Get-CargoPackageVersion {
    <#
    .SYNOPSIS
        The `version` key of the [package] table in a Cargo.toml.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$CargoTomlPath
    )
    if (-not (Test-Path -LiteralPath $CargoTomlPath -PathType Leaf)) {
        throw "file_not_found:$CargoTomlPath"
    }
    $inPackage = $false
    foreach ($line in ([IO.File]::ReadAllText($CargoTomlPath) -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\[') {
            $inPackage = ($trimmed -eq '[package]')
            continue
        }
        if (-not $inPackage) { continue }
        if ($trimmed -match '^version\s*=\s*"([^"]+)"') { return $Matches[1] }
    }
    return $null
}

function Get-JarvisMainBinaryName {
    <#
    .SYNOPSIS
        The name of the app binary the installer lays down.

    .DESCRIPTION
        The NSIS installer installs the binary under the CRATE name
        (home-base.exe), not the product name (Jarvis.exe), because that is
        what Cargo produces and what Tauri's bundler picks up. The product
        name is used for display, shortcuts and the install directory.

        Read from Cargo.toml: the [[bin]] name when one is declared, and
        the package name otherwise (Cargo's default).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )
    $cargoToml = Join-Path $RepoRoot 'src-tauri\Cargo.toml'
    if (-not (Test-Path -LiteralPath $cargoToml -PathType Leaf)) {
        throw "file_not_found:$cargoToml"
    }
    $text = [IO.File]::ReadAllText($cargoToml)
    if ($text -match '(?ms)^\[\[bin\]\]\s*\r?\n(?:.*\r?\n)*?^\s*name\s*=\s*"([^"]+)"') {
        return $Matches[1]
    }
    if ($text -match '(?m)^\s*name\s*=\s*"([^"]+)"') { return $Matches[1] }
    throw 'cargo_binary_name_unreadable'
}

function Get-JarvisReleaseVersion {
    <#
    .SYNOPSIS
        The single version every shipped surface must agree on.

    .DESCRIPTION
        Reads the version from all five places it is declared and returns it
        only if they agree. The north star is a "v1.0" release; a release
        whose frontend, backend, sidecar and installer disagree on the
        version is mislabelled, and the release record would then attest to
        a version that no shipped artifact actually carries. The DD-003
        work made these agree once; this keeps them agreeing.

        Throws with every disagreeing source named, so the fix is obvious.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $sources = @(
        @{ name = 'src-tauri/Cargo.toml';       value = (Get-CargoPackageVersion -CargoTomlPath (Join-Path $RepoRoot 'src-tauri\Cargo.toml')) }
        @{ name = 'src-tauri/tauri.conf.json';  value = ((Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src-tauri\tauri.conf.json') | ConvertFrom-Json).version) }
        @{ name = 'server-jarvis/package.json';  value = ((Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'server-jarvis\package.json') | ConvertFrom-Json).version) }
        @{ name = 'src-ui/package.json';         value = ((Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'src-ui\package.json') | ConvertFrom-Json).version) }
        @{ name = 'package.json';                value = ((Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json).version) }
    )

    $missing = $sources | Where-Object { [string]::IsNullOrWhiteSpace($_.value) }
    if ($missing) {
        throw ("version_source_missing:" + (($missing | ForEach-Object { $_.name }) -join ','))
    }

    $distinct = @($sources | ForEach-Object { $_.value } | Sort-Object -Unique)
    if ($distinct.Count -ne 1) {
        $detail = ($sources | ForEach-Object { "$($_.name)=$($_.value)" }) -join ' '
        throw "version_mismatch:$detail"
    }
    return $distinct[0]
}

# ── Server bundle ────────────────────────────────────────────────────────────
# The bundle build itself is NOT here. It lives in
# server-jarvis/src/build-frontend.ts, because Tauri's beforeBuildCommand
# needs it as a cross-platform script and because running it from bun
# removes the PowerShell native-argument quoting trap entirely (the inner
# quotes of a `bun build --define` value must survive PowerShell 5.1's
# rebuild of the command line, or bun folds the value as a BARE JS
# identifier -- `var SHA = abc123 ?? "dev"` -> ReferenceError at module load
# -> the deployed server cannot boot, with bun build still exiting 0).
# This file owns the identity that gets folded in and the check that it
# actually folded.

function Test-JarvisBundleProvenance {
    <#
    .SYNOPSIS
        Assert that a built bundle really carries the build identity.

    .DESCRIPTION
        Two failure modes are checked, and both are silent otherwise:

          * the defines did not fold, so the bundle still reads the
            environment at runtime and the deployed server reports "dev"
            instead of a commit -- this is the 2026-07 incident shape;

          * the defines folded but with a bare JS identifier, so the bundle
            throws a ReferenceError at module load and the server cannot
            boot at all. bun build still exits 0 here, so an exit-code gate
            cannot see it.

        A bare substring is not proof of the fold: the identity can appear
        in a comment or inside a longer token without any define having
        replaced the runtime lookup. Each value must therefore occur as a
        complete double-quoted JS string literal (`"<value>"`).

        Returns an object with `ok` and, on failure, `reason`.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$BundlePath,
        [Parameter(Mandatory = $true)]
        $Identity
    )

    if (-not (Test-Path -LiteralPath $BundlePath -PathType Leaf)) {
        return [pscustomobject]@{ ok = $false; reason = "bundle_missing:$BundlePath" }
    }
    $text = [IO.File]::ReadAllText($BundlePath)

    if ($text -match 'process\.env\.JARVIS_GIT_SHA') {
        return [pscustomobject]@{
            ok     = $false
            reason = 'define_not_folded:JARVIS_GIT_SHA is still a runtime env lookup in the bundle'
        }
    }
    if ($text -notmatch ('"' + [regex]::Escape([string]$Identity.git_sha) + '"')) {
        return [pscustomobject]@{
            ok     = $false
            reason = "sha_not_folded:expected double-quoted literal `"$($Identity.git_sha)`" in the bundle"
        }
    }
    if ($text -notmatch ('"' + [regex]::Escape([string]$Identity.source_tree_sha256) + '"')) {
        return [pscustomobject]@{
            ok     = $false
            reason = "source_tree_not_folded:expected double-quoted literal `"$($Identity.source_tree_sha256)`" in the bundle"
        }
    }
    return [pscustomobject]@{ ok = $true; reason = $null }
}

# ── Release manifest ─────────────────────────────────────────────────────────

function Get-JarvisReleaseSchema {
    return 'jarvis.release/1'
}

function New-JarvisReleaseManifest {
    <#
    .SYNOPSIS
        Build the single inspectable release record.

    .DESCRIPTION
        One record covering the frontend (UI bundle), the backend (server
        bundle), the sidecars (Claude proxy, MCP stdio server, OpenCode Go
        model list) and the installer, each with its SHA-256. This is the
        "make frontend, backend, sidecar and installer provenance one
        inspectable release record" item from the release gap report: before
        this, the installer, the runtime and the deploy manifest each
        carried a partial, separately-maintained view of the same facts.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Version,
        [Parameter(Mandatory = $true)]
        $Identity,
        [Parameter(Mandatory = $true)]
        [object[]]$Artifacts,
        # The release directory. Artifacts inside it are recorded with a
        # path relative to it, so the record stays portable and does not
        # leak the build machine's directory layout into a published
        # release.
        [string]$Root = '',
        # Extra top-level fields (prompts tree id, signature status, ...).
        [hashtable]$Extra = @{}
    )

    $rootPrefix = ''
    if (-not [string]::IsNullOrWhiteSpace($Root)) {
        $rootPrefix = ([IO.Path]::GetFullPath($Root)).TrimEnd('\') + '\'
    }

    $files = @()
    foreach ($artifact in $Artifacts) {
        if (-not $artifact.path) { continue }
        if (-not (Test-Path -LiteralPath $artifact.path -PathType Leaf)) {
            throw "release_artifact_missing:$($artifact.path)"
        }
        $item = Get-Item -LiteralPath $artifact.path
        $full = [IO.Path]::GetFullPath($artifact.path)
        $recorded = $full
        if ($rootPrefix -and $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $recorded = $full.Substring($rootPrefix.Length)
        }
        $files += [pscustomobject]@{
            role        = $artifact.role
            name        = $item.Name
            path        = $recorded
            sha256      = (Get-JarvisFileSha256 -Path $artifact.path)
            size_bytes  = [int64]$item.Length
            # Whether this artifact is offered to the public as a release
            # asset. The record lists every artifact either way; only the
            # published ones go into SHA256SUMS.txt, because that file is
            # what a downloader can actually check.
            published   = [bool]$artifact.published
        }
    }

    $manifest = [pscustomobject]@{
        schema             = (Get-JarvisReleaseSchema)
        product            = 'Jarvis'
        version            = $Version
        git_sha            = $Identity.git_sha
        git_dirty          = [bool]$Identity.git_dirty
        built_at           = $Identity.built_at
        source_tree_sha256 = $Identity.source_tree_sha256
        files              = $files
    }
    foreach ($key in $Extra.Keys) {
        $manifest | Add-Member -NotePropertyName $key -NotePropertyValue $Extra[$key]
    }
    return $manifest
}

function Write-JarvisReleaseManifest {
    <#
    .SYNOPSIS
        Write the release manifest and a SHA256SUMS.txt beside it.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Manifest,
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }

    $Manifest | ConvertTo-Json -Depth 6 | Out-File -LiteralPath $Path -Encoding utf8

    # SHA256SUMS.txt covers the PUBLISHED artifacts only: the ones a
    # downloader can fetch and check. The record lists the rest.
    $sumsPath = Join-Path $dir 'SHA256SUMS.txt'
    $lines = foreach ($file in $Manifest.files) {
        if ($file.published) { "$($file.sha256.ToLowerInvariant())  $($file.name)" }
    }
    $lines | Out-File -LiteralPath $sumsPath -Encoding ascii

    return [pscustomobject]@{
        manifest = $Path
        sums     = $sumsPath
    }
}

function Read-JarvisReleaseManifest {
    <#
    .SYNOPSIS
        Read a release manifest written by Write-JarvisReleaseManifest.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "release_manifest_missing:$Path"
    }
    return (Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json)
}

function Resolve-JarvisManifestPath {
    <#
    .SYNOPSIS
        The absolute path of an artifact named by a release record.

    .DESCRIPTION
        The record stores paths relative to the release directory so it stays
        portable; this resolves one back to an absolute path against the
        directory the record itself lives in.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$ArtifactPath
    )
    if ([IO.Path]::IsPathRooted($ArtifactPath)) { return $ArtifactPath }
    $root = Split-Path -Parent ([IO.Path]::GetFullPath($ManifestPath))
    return (Join-Path $root $ArtifactPath)
}

function Update-JarvisReleaseInstallerRecord {
    <#
    .SYNOPSIS
        Recalculate an existing release record's entry for an installer that
        was signed after the record was written.

    .DESCRIPTION
        release-build.ps1 signs before it writes the record, because signing
        changes the bytes. sign-installer.ps1 signs an installer that already
        has a record, so without this its "sha256: ..." line describes an
        artifact whose recorded hash and downloadable SHA256SUMS.txt entry
        still point at the unsigned bytes.

        Only the entry that resolves to exactly this installer is touched:
        its hash, size and name are recalculated, the checksums are rewritten
        through Write-JarvisReleaseManifest (so unrelated published artifacts
        keep their lines and unpublished ones stay out), and identity,
        version and every other artifact are carried over untouched. A
        standalone signature does not make this commit a different build, so
        git_sha / source_tree_sha256 are never rewritten here.

        It will not invent a record for a bare installer: with no adjacent
        record it returns refreshed = $false and writes nothing. A record that
        IS present but cannot be trusted -- unparsable, wrong schema, or
        naming a different installer -- throws, because leaving stale
        provenance in place is the failure this exists to prevent.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallerPath,
        # Defaults to jarvis-release.json beside the installer.
        [string]$ManifestPath,
        # Signature status from the signing step. Only folded into fields the
        # record already carries; nothing is added to a record that omits them.
        $Signature
    )

    # ConvertFrom-Json reports invalid JSON as a non-terminating error, which
    # would otherwise leave a null record here and read as "nothing to do".
    # A record that cannot be parsed must fail, not pass silently.
    $ErrorActionPreference = 'Stop'

    if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
        throw "installer_missing:$InstallerPath"
    }
    $installer = Get-Item -LiteralPath $InstallerPath
    $installerFull = [IO.Path]::GetFullPath($installer.FullName)

    if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
        $ManifestPath = Join-Path (Split-Path -Parent $installerFull) 'jarvis-release.json'
    }
    $ManifestPath = [IO.Path]::GetFullPath($ManifestPath)

    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
        return [pscustomobject]@{
            refreshed  = $false
            reason     = "release_manifest_missing:$ManifestPath"
            manifest   = $ManifestPath
            sums       = $null
            installer  = $installerFull
            sha256     = $null
            size_bytes = $null
            entries    = 0
        }
    }

    try {
        $manifest = Read-JarvisReleaseManifest -Path $ManifestPath
    } catch {
        throw "release_manifest_malformed:${ManifestPath}:$($_.Exception.Message)"
    }
    if (-not $manifest -or -not $manifest.PSObject.Properties['schema']) {
        throw "release_manifest_malformed:${ManifestPath}:schema"
    }
    if ([string]$manifest.schema -ne (Get-JarvisReleaseSchema)) {
        throw "release_manifest_malformed:${ManifestPath}:schema=$($manifest.schema)"
    }
    if (-not $manifest.PSObject.Properties['files']) {
        throw "release_manifest_malformed:${ManifestPath}:files"
    }
    $entries = @($manifest.files)
    if ($entries.Count -eq 0) {
        throw "release_manifest_malformed:${ManifestPath}:files"
    }

    $matched = @()
    foreach ($entry in $entries) {
        if (-not $entry -or [string]::IsNullOrWhiteSpace($entry.path)) { continue }
        try {
            $resolved = Resolve-JarvisManifestPath -ManifestPath $ManifestPath -ArtifactPath ([string]$entry.path)
            $resolvedFull = [IO.Path]::GetFullPath($resolved)
        } catch {
            throw "release_manifest_malformed:${ManifestPath}:path=$($entry.path)"
        }
        if ($resolvedFull -eq $installerFull) { $matched += $entry }
    }
    if ($matched.Count -eq 0) {
        throw "release_manifest_installer_mismatch:${ManifestPath}:$installerFull"
    }

    $sha256 = Get-JarvisFileSha256 -Path $installerFull
    $size = [int64]$installer.Length
    foreach ($entry in $matched) {
        $entry.sha256 = $sha256
        $entry.size_bytes = $size
        $entry.name = $installer.Name
    }

    if ($Signature) {
        $signatureFields = @([pscustomobject]@{ name = 'signed'; value = $true })
        if ($Signature.status) {
            $signatureFields += [pscustomobject]@{ name = 'signature_status'; value = $Signature.status }
        }
        if ($Signature.subject) {
            $signatureFields += [pscustomobject]@{ name = 'signature_subject'; value = $Signature.subject }
        }
        foreach ($field in $signatureFields) {
            $existing = $manifest.PSObject.Properties[$field.name]
            if ($existing) { $existing.Value = $field.value }
        }
    }

    # Keep the record's files a JSON array even when there is only one.
    $manifest.files = $entries

    $written = Write-JarvisReleaseManifest -Manifest $manifest -Path $ManifestPath
    return [pscustomobject]@{
        refreshed  = $true
        reason     = $null
        manifest   = $written.manifest
        sums       = $written.sums
        installer  = $installerFull
        sha256     = $sha256
        size_bytes = $size
        entries    = $matched.Count
    }
}

# ── Release smoke decisions ──────────────────────────────────────────────────
# The interesting rules of the release smoke, kept here so they can be
# tested without an installer, a certificate or an inference backend. The
# smoke script is the CLI over these.

function Test-JarvisArtifactHash {
    <#
    .SYNOPSIS
        Does a file's SHA-256 equal the expected value?
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ExpectedSha256
    )
    if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) {
        return [pscustomobject]@{ ok = $false; reason = 'no_expected_hash'; actual = $null; expected = $ExpectedSha256 }
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{ ok = $false; reason = "artifact_missing:$Path"; actual = $null; expected = $ExpectedSha256 }
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ne $ExpectedSha256.ToUpperInvariant()) {
        return [pscustomobject]@{
            ok       = $false
            reason   = "hash_mismatch:actual=$actual expected=$ExpectedSha256"
            actual   = $actual
            expected = $ExpectedSha256
        }
    }
    return [pscustomobject]@{ ok = $true; reason = $null; actual = $actual; expected = $ExpectedSha256 }
}

function Install-JarvisRelease {
    <#
    .SYNOPSIS
        Run the NSIS installer silently into a scratch directory.

    .DESCRIPTION
        NSIS takes /S for silent and /D=<dir> for the install directory.
        /D must be the LAST argument and must not be quoted.

        The install is deterministic: the same installer always lays down
        the same bytes. That is what makes it possible to record the hash
        of the INSTALLED binary in the release record and have the smoke
        reproduce it from a second install.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallerPath,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [int]$TimeoutSeconds = 120
    )
    # Never delete a caller-owned path. Only a new absolute child of TEMP
    # can become an install owned by this invocation.
    if ($InstallRoot -notmatch '^[A-Za-z]:[\\/]') { throw "install_root_not_absolute:$InstallRoot" }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    $scratchPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if (-not $InstallRoot.StartsWith($scratchPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "install_root_not_scratch:$InstallRoot"
    }
    if (Test-Path -LiteralPath $InstallRoot) { throw "install_root_exists:$InstallRoot" }
    $parent = Split-Path -Parent $InstallRoot
    while ($parent -and $parent.StartsWith($scratchPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        if ((Test-Path -LiteralPath $parent) -and
            ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "install_root_reparse_parent:$parent"
        }
        $parent = Split-Path -Parent $parent
    }
    New-Item -ItemType Directory -Path $InstallRoot | Out-Null
    $process = $null
    try {
        # /D must be last and unquoted, including when the directory has spaces.
        $process = Start-Process -FilePath $InstallerPath -ArgumentList @('/S', "/D=$InstallRoot") -PassThru -WindowStyle Hidden
        $process | Wait-Process -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue
        if (-not $process.HasExited) { throw "install_timeout:$InstallRoot" }
        if ($process.ExitCode -ne 0) { throw "install_failed:exit_$($process.ExitCode)" }
    } catch {
        if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        # This path was validated and created above; it did not exist on entry.
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
    return $InstallRoot
}

function Assert-JarvisPortAvailable {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$Port)
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
        throw "port_already_in_use:$Port (close the existing listener before probing)"
    }
}

function Read-JarvisLineWithDeadline {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][IO.TextReader]$Reader,
        [Parameter(Mandatory = $true)][datetime]$Deadline
    )
    $remainingMs = [Math]::Ceiling(($Deadline - [datetime]::UtcNow).TotalMilliseconds)
    if ($remainingMs -le 0) { throw 'stream_body_timeout' }
    $lineTask = $Reader.ReadLineAsync()
    if (-not $lineTask.Wait([int][Math]::Min($remainingMs, [int]::MaxValue))) {
        throw 'stream_body_timeout'
    }
    return $lineTask.GetAwaiter().GetResult()
}

function Stop-JarvisOwnedProcesses {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Process)
    # The root start is cached immediately after spawn: StartTime can no
    # longer be queried once an already-exited process has been collected.
    $rootStart = if ($Process.PSObject.Properties['JarvisOwnedStartTime']) {
        $Process.JarvisOwnedStartTime
    } else { $Process.StartTime }
    $rootEnd = if ($Process.HasExited) { $Process.ExitTime } else { Get-Date }
    if (-not $rootStart -or -not $rootEnd) { throw 'owned_process_lifetime_unavailable: uncertain descendants preserved' }

    # A child's creation must fall inside its parent's known lifetime.
    # This also handles a dead root while excluding children of a reused
    # PID. Grandchildren require an unbroken chain through this snapshot;
    # unknown orphan ancestry is deliberately preserved, never guessed.
    $snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $parents = [System.Collections.Generic.List[object]]::new()
    $parents.Add([pscustomobject]@{ id = $Process.Id; start = $rootStart; end = $rootEnd })
    $owned = [System.Collections.Generic.List[object]]::new()
    $seen = @{}
    $seen[[string]$Process.Id] = $true
    for ($index = 0; $index -lt $parents.Count; $index++) {
        $parent = $parents[$index]
        foreach ($child in $snapshot) {
            if ($child.ParentProcessId -eq $parent.id -and $child.CreationDate -ge $parent.start -and
                $child.CreationDate -le $parent.end -and -not $seen.ContainsKey([string]$child.ProcessId)) {
                $seen[[string]$child.ProcessId] = $true
                $owned.Add($child)
                $parents.Add([pscustomobject]@{ id = $child.ProcessId; start = $child.CreationDate; end = (Get-Date) })
            }
        }
    }
    for ($index = $owned.Count - 1; $index -ge 0; $index--) {
        $child = $owned[$index]
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.ProcessId)" -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessId -eq $child.ProcessId -and $_.CreationDate -eq $child.CreationDate }
        if ($current) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
        else { Write-Warning "Owned child $($child.ProcessId) exited or changed identity; no termination attempted." }
    }
    if (-not $Process.HasExited) { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue }
}

function Test-JarvisInstalledResources {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)]$Manifest
    )
    $resources = [ordered]@{
        server_bundle = 'index.js'
        mcp_stdio = 'mcp-stdio-server.js'
        claude_proxy = 'resources\claude_cli_proxy.py'
        go_models = 'resources\opencode_go_openai_models.json'
    }
    foreach ($role in $resources.Keys) {
        $entry = @($Manifest.files | Where-Object { $_.role -eq $role })
        if ($entry.Count -ne 1) {
            return [pscustomobject]@{ ok = $false; reason = "installed_resource_record_missing:$role" }
        }
        $result = Test-JarvisArtifactHash -Path (Join-Path $InstallRoot $resources[$role]) -ExpectedSha256 $entry[0].sha256
        if (-not $result.ok) {
            return [pscustomobject]@{ ok = $false; reason = "installed_resource_mismatch:${role}:$($result.reason)" }
        }
    }
    return [pscustomobject]@{ ok = $true; reason = $null }
}

function Resolve-JarvisReleasePublication {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$BuildSha,
        [string]$RequestedTag = '',
        [string]$ExistingTagSha = ''
    )
    if ($BuildSha -notmatch '^[0-9a-fA-F]{40}$') { throw 'release_build_sha_invalid' }
    $tag = "v$Version"
    if ($RequestedTag -and $RequestedTag -cne $tag) { throw "release_tag_version_mismatch:$RequestedTag expected=$tag" }
    if ($ExistingTagSha -and $ExistingTagSha -ne $BuildSha) { throw "release_tag_sha_mismatch:$tag" }
    return [pscustomobject]@{ tag = $tag; target = $BuildSha }
}

function Remove-JarvisReleaseInstall {
    <#
    .SYNOPSIS
        Uninstall a scratch install and clean up after it.

    .DESCRIPTION
        A silent install leaves an uninstall registry entry pointing at the
        scratch directory. Left behind, it shows up in Apps and Features as
        a broken install. The uninstaller is part of the install, so it
        can remove itself.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [int]$TimeoutSeconds = 60
    )
    $uninstaller = Join-Path $InstallRoot 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { return $false }
    try {
        $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -PassThru
        $process | Wait-Process -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue
    } catch {
        return $false
    }
    return $true
}

function Find-JarvisInstalledBinary {
    <#
    .SYNOPSIS
        The installed binary whose hash matches the release record.

    .DESCRIPTION
        Matched by hash, not by name alone. The NSIS installer lays the
        binary down under the crate name (home-base.exe), while the
        release directory stages it as Jarvis.exe, so a name comparison
        would miss a perfectly good install. The hash is the thing the
        record actually asserts, so that is what is compared.

        Returns the path, or $null when nothing in the tree matches.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        # Narrow the candidates by file name when it is known.
        [string]$BinaryName = ''
    )
    if ([string]::IsNullOrWhiteSpace($ExpectedSha256)) { return $null }
    $candidates = Get-ChildItem -LiteralPath $InstallRoot -Filter '*.exe' -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne 'uninstall.exe' }
    if (-not [string]::IsNullOrWhiteSpace($BinaryName)) {
        $named = $candidates | Where-Object { $_.Name -ieq $BinaryName }
        if ($named) { $candidates = $named }
    }
    foreach ($candidate in $candidates) {
        $hash = (Get-FileHash -LiteralPath $candidate.FullName -Algorithm SHA256).Hash
        if ($hash -eq $ExpectedSha256.ToUpperInvariant()) { return $candidate.FullName }
    }
    return $null
}

function Test-JarvisHealthProvenance {
    <#
    .SYNOPSIS
        Does /health describe the build the release record claims?

    .DESCRIPTION
        The stale-binary check. A running server whose git_sha differs from
        the record is a different build serving requests; a server that
        reports "dev" is running from source and describes no build at all.
        Both are failures, and neither is a warning.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Health,
        [Parameter(Mandatory = $true)]$Manifest
    )
    $runningSha = [string]$Health.git_sha
    if ([string]::IsNullOrWhiteSpace($runningSha)) {
        return [pscustomobject]@{ ok = $false; reason = 'health_reports_no_git_sha' }
    }
    if ($runningSha -eq 'dev') {
        return [pscustomobject]@{ ok = $false; reason = 'health_reports_dev_build' }
    }
    if ($runningSha -ne ([string]$Manifest.git_sha).ToUpperInvariant()) {
        return [pscustomobject]@{
            ok     = $false
            reason = "git_sha_mismatch:running=$runningSha expected=$($Manifest.git_sha)"
        }
    }
    $runningTree = [string]$Health.source_tree_sha256
    if (-not [string]::IsNullOrWhiteSpace($runningTree) -and
        $runningTree -ne ([string]$Manifest.source_tree_sha256).ToUpperInvariant()) {
        return [pscustomobject]@{
            ok     = $false
            reason = "source_tree_mismatch:running=$runningTree expected=$($Manifest.source_tree_sha256)"
        }
    }
    return [pscustomobject]@{ ok = $true; reason = $null }
}

function Get-JarvisSseOutcome {
    <#
    .SYNOPSIS
        The terminal frame of a /chat/stream response, if there is one.
    #>
    [CmdletBinding()]
    param(
        [object[]]$Events
    )
    $terminal = @($Events | Where-Object { $_.type -in @('result', 'error', 'cancelled') })
    if ($terminal.Count -eq 0) {
        return [pscustomobject]@{ ok = $false; reason = 'no_terminal_event'; type = $null; text = $null }
    }
    $last = $terminal[-1]
    $text = if ($null -ne $last.result) { [string]$last.result }
            elseif ($null -ne $last.error) { [string]$last.error }
            else { '' }
    $isResult = ([string]$last.type -eq 'result')
    return [pscustomobject]@{
        ok     = $isResult
        reason = $(if ($isResult) { $null } else { "terminal_$($last.type)" })
        type   = [string]$last.type
        text   = $text
    }
}

# ── Authenticode signing ─────────────────────────────────────────────────────
# The north star is a SIGNED installer and nothing in the tree signed, so
# the signing logic lives here rather than in the CLI wrapper: both
# scripts/sign-installer.ps1 and scripts/release-build.ps1 need it, and
# dot-sourcing a script with a mandatory param block would prompt.

function Find-JarvisSignTool {
    <#
    .SYNOPSIS
        Locate signtool.exe: on PATH, else under the Windows Kits bin tree.
    #>
    $onPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }

    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    if (Test-Path -LiteralPath $kitsRoot) {
        $found = Get-ChildItem -LiteralPath $kitsRoot -Filter 'signtool.exe' -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\' } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }
    return $null
}

function Get-JarvisPfxThumbprint {
    <#
    .SYNOPSIS
        The SHA-1 thumbprint of a .pfx, without importing it permanently.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PfxPath,
        [string]$Password
    )
    $secure = ConvertTo-JarvisPfxPassword -Password $Password
    $collection = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
    try {
        $collection.Import($PfxPath, $secure, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)
    } catch {
        throw "pfx_import_failed:$($_.Exception.Message)"
    }
    if ($collection.Count -eq 0) { throw 'pfx_import_empty' }
    return $collection[0].Thumbprint
}

function Resolve-JarvisSigningConfiguration {
    <#
    .SYNOPSIS
        Decide how (or whether) the installer can be signed.

    .DESCRIPTION
        Pure decision function, kept separate from the side effects so it
        can be unit tested without a certificate store.

        Two routes are supported, because two kinds of code-signing service
        exist and they do not hand you the same thing:

          * A CERTIFICATE (a PFX, or a certificate already in the Windows
            store). The signing is done by signtool against a thumbprint.
            This is the classic OV/EV certificate route.

          * A SIGNING SERVICE (Azure Artifact Signing, SignPath, and
            similar). The provider never gives you a private key: it signs
            the artifact itself, or gives you a short-lived signing
            command. The operator supplies that command and the pipeline
            runs it with the artifact path.

        A custom command wins when both are present, because it is the
        more specific instruction.

        Throws with an actionable message when the inputs cannot produce a
        signature -- the message names the environment variables to set,
        because the failure will otherwise happen on a CI runner with
        nobody watching.
    #>
    [CmdletBinding()]
    param(
        [string]$Thumbprint,
        [string]$PfxPath,
        [string]$PfxPassword,
        [string]$TimestampUrl,
        [string]$Command = ''
    )

    if (-not [string]::IsNullOrWhiteSpace($Command)) {
        return [pscustomobject]@{
            mode          = 'command'
            command       = $Command
            thumbprint    = $null
            pfx_path      = $null
            timestamp_url = $TimestampUrl
        }
    }

    $hasThumbprint = -not [string]::IsNullOrWhiteSpace($Thumbprint)
    $hasPfx = (-not [string]::IsNullOrWhiteSpace($PfxPath)) -and (Test-Path -LiteralPath $PfxPath -PathType Leaf)

    if (-not $hasThumbprint -and -not $hasPfx) {
        throw ("no_signing_certificate: set JARVIS_SIGNING_THUMBPRINT for a certificate already " +
               "in the Windows certificate store, or JARVIS_SIGNING_PFX_PATH (plus " +
               "JARVIS_SIGNING_PFX_PASSWORD) for a .pfx to import, or JARVIS_SIGNING_COMMAND for a " +
               "signing service (Azure Artifact Signing, SignPath) that signs the artifact itself. " +
               "Refusing to publish an unsigned installer.")
    }

    if (-not $hasThumbprint -and $hasPfx) {
        # A .pfx still has to yield a usable thumbprint. Read it from the file
        # rather than requiring the caller to know it.
        $Thumbprint = Get-JarvisPfxThumbprint -PfxPath $PfxPath -Password $PfxPassword
        $hasThumbprint = $true
    }

    if ([string]::IsNullOrWhiteSpace($TimestampUrl)) {
        throw 'no_timestamp_url: an Authenticode signature without a timestamp stops being valid when the certificate expires.'
    }

    return [pscustomobject]@{
        mode          = 'certificate'
        command       = $null
        thumbprint    = $Thumbprint.Replace(' ', '').ToUpperInvariant()
        pfx_path      = $(if ($hasPfx) { $PfxPath } else { $null })
        timestamp_url = $TimestampUrl
    }
}

function Get-JarvisAuthenticodeStatus {
    <#
    .SYNOPSIS
        The Authenticode signature status of a file.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    return [pscustomobject]@{
        status     = [string]$signature.Status
        subject    = [string]$signature.SignerCertificate.Subject
        issuer     = [string]$signature.SignerCertificate.Issuer
        thumbprint = [string]$signature.SignerCertificate.Thumbprint
        timestamp  = [string]$signature.TimeStamperCertificate.Subject
    }
}

function Import-JarvisSigningCertificate {
    <#
    .SYNOPSIS
        Import a .pfx into the current user's certificate store.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PfxPath,
        [string]$Password
    )
    $secure = ConvertTo-JarvisPfxPassword -Password $Password
    return Import-PfxCertificate -FilePath $PfxPath -CertStoreLocation 'Cert:\CurrentUser\My' -Password $secure -Exportable -ErrorAction Stop
}

function ConvertTo-JarvisPfxPassword {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$Password = '')
    if ([string]::IsNullOrEmpty($Password)) { return [Security.SecureString]::new() }
    return (ConvertTo-SecureString -String $Password -AsPlainText -Force)
}

function Invoke-JarvisInstallerSigning {
    <#
    .SYNOPSIS
        Sign the installer and verify the signature.

    .DESCRIPTION
        Two routes (see Resolve-JarvisSigningConfiguration):

          * 'certificate' - signtool against a thumbprint, then verify
            with signtool and with Get-AuthenticodeSignature.
          * 'command' - the operator's signing-service command, invoked
            with the artifact path, then verified the same way.

        A sign step that does not verify is a sign step that can silently
        do nothing, so both routes verify.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallerPath,
        [Parameter(Mandatory = $true)]
        $Configuration,
        [string]$SignToolPath
    )

    if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
        throw "installer_missing:$InstallerPath"
    }

    if ($Configuration.mode -eq 'command') {
        # The command receives the artifact path as its single argument,
        # which is the shape Tauri uses for bundle.windows.signCommand and
        # the shape the Azure Artifact Signing and SignPath CLIs expect.
        & $Configuration.command $InstallerPath
        if ($LASTEXITCODE -ne 0) {
            throw "sign_command_failed:exit_$LASTEXITCODE"
        }
    } else {
        if ([string]::IsNullOrWhiteSpace($SignToolPath)) {
            $SignToolPath = Find-JarvisSignTool
        }
        if (-not $SignToolPath) {
            throw 'signtool_not_found: install the Windows SDK, or put signtool.exe on PATH.'
        }

        & $SignToolPath sign /sha1 $Configuration.thumbprint /fd SHA256 /tr $Configuration.timestamp_url /td SHA256 $InstallerPath
        if ($LASTEXITCODE -ne 0) {
            throw "signtool_sign_failed:exit_$LASTEXITCODE"
        }

        & $SignToolPath verify /pa /v $InstallerPath
        if ($LASTEXITCODE -ne 0) {
            throw "signtool_verify_failed:exit_$LASTEXITCODE"
        }
    }

    $status = Get-JarvisAuthenticodeStatus -Path $InstallerPath
    if ($status.status -ne 'Valid') {
        throw "signature_not_valid:$($status.status)"
    }
    return $status
}
