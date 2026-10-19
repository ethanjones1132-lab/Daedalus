$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

Describe 'source tree digest' {
    It 'produces a 64 character uppercase hex digest' {
        $digest = Get-JarvisSourceTreeSha256 -RepoRoot $repoRoot
        $digest | Should Match '^[0-9A-F]{64}$'
    }

    It 'is stable across calls' {
        $first = Get-JarvisSourceTreeSha256 -RepoRoot $repoRoot
        $second = Get-JarvisSourceTreeSha256 -RepoRoot $repoRoot
        $first | Should Be $second
    }

    It 'reproduces the digest algorithm the deploy manifest already uses' {
        # The deploy manifest written by build-and-deploy.ps1 and checked by
        # verify-deploy.ps1 is the record the running server is compared
        # against. If this algorithm drifts, every manifest ever written
        # silently stops verifying, so it is pinned to the original
        # implementation rather than to itself.
        $sourceRoots = @(
            (Join-Path $repoRoot 'server-jarvis\src'),
            (Join-Path $repoRoot 'src-tauri\src'),
            (Join-Path $repoRoot 'src-ui\src'),
            (Join-Path $repoRoot 'scripts')
        )
        $sourceFiles = Get-ChildItem -LiteralPath $sourceRoots -Recurse -File | Sort-Object FullName
        $sourceTreeText = foreach ($file in $sourceFiles) {
            $relative = $file.FullName.Substring($repoRoot.Length).TrimStart('\')
            "${relative}:$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
        }
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes(($sourceTreeText -join "`n"))
            $expected = ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '')
        } finally {
            $sha256.Dispose()
        }
        (Get-JarvisSourceTreeSha256 -RepoRoot $repoRoot) | Should Be $expected
    }
}

Describe 'version consistency' {
    # Builds a throwaway repo whose version sources can be set one at a time.
    function New-FakeRepo([string]$Name, [hashtable]$Versions) {
        $fake = Join-Path $TestDrive $Name
        foreach ($dir in @('src-tauri', 'server-jarvis', 'src-ui')) {
            New-Item -ItemType Directory -Force -Path (Join-Path $fake $dir) | Out-Null
        }
        $cargo = "[package]`nname = `"fake`"`nversion = `"$($Versions['cargo'])`""
        $cargo | Out-File (Join-Path $fake 'src-tauri\Cargo.toml') -Encoding utf8
        "{`"version`":`"$($Versions['tauri'])`"}" | Out-File (Join-Path $fake 'src-tauri\tauri.conf.json') -Encoding utf8
        "{`"version`":`"$($Versions['server'])`"}" | Out-File (Join-Path $fake 'server-jarvis\package.json') -Encoding utf8
        "{`"version`":`"$($Versions['ui'])`"}" | Out-File (Join-Path $fake 'src-ui\package.json') -Encoding utf8
        "{`"version`":`"$($Versions['root'])`"}" | Out-File (Join-Path $fake 'package.json') -Encoding utf8
        return $fake
    }

    It 'reports the version every shipped surface agrees on' {
        $version = Get-JarvisReleaseVersion -RepoRoot $repoRoot
        $version | Should Match '^\d+\.\d+\.\d+$'
    }

    It 'refuses to release when a surface disagrees' {
        $fake = New-FakeRepo -Name 'mismatched-repo' -Versions @{
            cargo = '1.0.0'; tauri = '2.0.0'; server = '1.0.0'; ui = '1.0.0'; root = '1.0.0'
        }
        { Get-JarvisReleaseVersion -RepoRoot $fake } | Should Throw 'version_mismatch'
    }

    It 'names every disagreeing source in the error' {
        # The fix has to be obvious from the message alone.
        $fake = New-FakeRepo -Name 'mismatched-repo-2' -Versions @{
            cargo = '1.0.0'; tauri = '2.0.0'; server = '3.0.0'; ui = '1.0.0'; root = '1.0.0'
        }
        $message = ''
        try { Get-JarvisReleaseVersion -RepoRoot $fake | Out-Null } catch { $message = $_.Exception.Message }
        $message | Should Match 'src-tauri/tauri.conf.json=2.0.0'
        $message | Should Match 'server-jarvis/package.json=3.0.0'
    }

    It 'refuses to release when a surface has no version at all' {
        $fake = Join-Path $TestDrive 'missing-version-repo'
        foreach ($dir in @('src-tauri', 'server-jarvis', 'src-ui')) {
            New-Item -ItemType Directory -Force -Path (Join-Path $fake $dir) | Out-Null
        }
        "[package]`nname = `"fake`"`nversion = `"1.0.0`"" | Out-File (Join-Path $fake 'src-tauri\Cargo.toml') -Encoding utf8
        '{"version":"1.0.0"}' | Out-File (Join-Path $fake 'src-tauri\tauri.conf.json') -Encoding utf8
        '{"version":"1.0.0"}' | Out-File (Join-Path $fake 'server-jarvis\package.json') -Encoding utf8
        '{"version":"1.0.0"}' | Out-File (Join-Path $fake 'src-ui\package.json') -Encoding utf8
        '{}' | Out-File (Join-Path $fake 'package.json') -Encoding utf8

        { Get-JarvisReleaseVersion -RepoRoot $fake } | Should Throw 'version_source_missing'
    }
}

Describe 'artifact hash verification' {
    BeforeEach {
        $script:artifact = Join-Path $TestDrive 'artifact.bin'
        'the real installer bytes' | Out-File $script:artifact -Encoding utf8
        $script:artifactHash = (Get-FileHash -LiteralPath $script:artifact -Algorithm SHA256).Hash
    }

    It 'accepts a file whose hash matches the record' {
        $result = Test-JarvisArtifactHash -Path $script:artifact -ExpectedSha256 $script:artifactHash
        $result.ok | Should Be $true
        $result.reason | Should BeNullOrEmpty
    }

    It 'rejects a tampered file' {
        # The tamper case: the installer is changed after the release record
        # was written. The check has to notice.
        'a different installer' | Out-File $script:artifact -Encoding utf8
        $result = Test-JarvisArtifactHash -Path $script:artifact -ExpectedSha256 $script:artifactHash
        $result.ok | Should Be $false
        $result.reason | Should Match 'hash_mismatch'
    }

    It 'rejects a missing file' {
        $result = Test-JarvisArtifactHash -Path (Join-Path $TestDrive 'nope.bin') -ExpectedSha256 $script:artifactHash
        $result.ok | Should Be $false
        $result.reason | Should Match 'artifact_missing'
    }

    It 'rejects an empty expectation rather than passing everything' {
        $result = Test-JarvisArtifactHash -Path $script:artifact -ExpectedSha256 ''
        $result.ok | Should Be $false
        $result.reason | Should Match 'no_expected_hash'
    }
}

Describe 'health provenance - the stale binary check' {
    BeforeEach {
        $script:manifest = [pscustomobject]@{
            git_sha            = '0123456789ABCDEF0123456789ABCDEF01234567'
            source_tree_sha256 = 'AABBCCDDEEFF00112233445566778899AABBCCDD'
        }
    }

    It 'accepts the build the record claims' {
        $health = [pscustomobject]@{
            git_sha            = '0123456789ABCDEF0123456789ABCDEF01234567'
            source_tree_sha256 = 'AABBCCDDEEFF00112233445566778899AABBCCDD'
        }
        $result = Test-JarvisHealthProvenance -Health $health -Manifest $script:manifest
        $result.ok | Should Be $true
    }

    It 'rejects a different build serving requests' {
        $health = [pscustomobject]@{
            git_sha            = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'
            source_tree_sha256 = 'AABBCCDDEEFF00112233445566778899AABBCCDD'
        }
        $result = Test-JarvisHealthProvenance -Health $health -Manifest $script:manifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'git_sha_mismatch'
    }

    It 'rejects a server running from source' {
        # A source-run server reports "dev" and describes no build at all.
        $health = [pscustomobject]@{ git_sha = 'dev'; source_tree_sha256 = $null }
        $result = Test-JarvisHealthProvenance -Health $health -Manifest $script:manifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'health_reports_dev_build'
    }

    It 'rejects a health response with no git sha' {
        # This exact shape is the 2026-07 incident: a reachable server that
        # predates the provenance change.
        $health = [pscustomobject]@{ source_tree_sha256 = $null }
        $result = Test-JarvisHealthProvenance -Health $health -Manifest $script:manifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'health_reports_no_git_sha'
    }

    It 'rejects a different source tree' {
        $health = [pscustomobject]@{
            git_sha            = '0123456789ABCDEF0123456789ABCDEF01234567'
            source_tree_sha256 = '1111111111111111111111111111111111111111'
        }
        $result = Test-JarvisHealthProvenance -Health $health -Manifest $script:manifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'source_tree_mismatch'
    }
}

Describe 'chat terminal outcome' {
    It 'accepts a result frame' {
        $events = @(
            [pscustomobject]@{ type = 'token'; text = 'smoke' }
            [pscustomobject]@{ type = 'result'; result = 'smoke ok.' }
        )
        $outcome = Get-JarvisSseOutcome -Events $events
        $outcome.ok | Should Be $true
        $outcome.type | Should Be 'result'
        $outcome.text | Should Be 'smoke ok.'
    }

    It 'rejects a stream that never reached a terminal frame' {
        $events = @([pscustomobject]@{ type = 'token'; text = 'smoke' })
        $outcome = Get-JarvisSseOutcome -Events $events
        $outcome.ok | Should Be $false
        $outcome.reason | Should Match 'no_terminal_event'
    }

    It 'rejects an error frame' {
        $events = @([pscustomobject]@{ type = 'error'; error = 'provider unavailable' })
        $outcome = Get-JarvisSseOutcome -Events $events
        $outcome.ok | Should Be $false
        $outcome.reason | Should Match 'terminal_error'
    }
}

Describe 'bundle provenance' {
    BeforeEach {
        $script:identity = [pscustomobject]@{
            git_sha            = '0123456789ABCDEF0123456789ABCDEF01234567'
            source_tree_sha256 = 'AABBCCDDEEFF00112233445566778899AABBCCDD'
        }
    }

    It 'accepts a bundle that carries the build identity' {
        $bundle = Join-Path $TestDrive 'folded.js'
        "var SHA = `"$($script:identity.git_sha)`" ?? `"dev`"; var TREE = `"$($script:identity.source_tree_sha256)`";" |
            Out-File $bundle -Encoding utf8
        $result = Test-JarvisBundleProvenance -BundlePath $bundle -Identity $script:identity
        $result.ok | Should Be $true
    }

    It 'rejects a bundle that still reads the environment at runtime' {
        # The define did not fold: the installed app would report "dev" and
        # /health could not tell which build is answering.
        $bundle = Join-Path $TestDrive 'unfolded.js'
        'var SHA = process.env.JARVIS_GIT_SHA ?? "dev";' | Out-File $bundle -Encoding utf8
        $result = Test-JarvisBundleProvenance -BundlePath $bundle -Identity $script:identity
        $result.ok | Should Be $false
        $result.reason | Should Match 'define_not_folded'
    }

    It 'rejects a bundle missing the source tree digest' {
        $bundle = Join-Path $TestDrive 'partial.js'
        "var SHA = `"$($script:identity.git_sha)`";" | Out-File $bundle -Encoding utf8
        $result = Test-JarvisBundleProvenance -BundlePath $bundle -Identity $script:identity
        $result.ok | Should Be $false
        $result.reason | Should Match 'source_tree_not_folded'
    }
}

Describe 'signing configuration' {
    It 'refuses to configure signing without a certificate' {
        { Resolve-JarvisSigningConfiguration -Thumbprint '' -PfxPath '' -TimestampUrl 'http://ts' } |
            Should Throw 'no_signing_certificate'
    }

    It 'refuses to configure signing without a timestamp' {
        { Resolve-JarvisSigningConfiguration -Thumbprint 'ABC123' -PfxPath '' -TimestampUrl '' } |
            Should Throw 'no_timestamp_url'
    }

    It 'normalizes a thumbprint' {
        $config = Resolve-JarvisSigningConfiguration -Thumbprint 'ab cd ef' -PfxPath '' -TimestampUrl 'http://ts'
        $config.thumbprint | Should Be 'ABCDEF'
        $config.mode | Should Be 'certificate'
    }

    It 'names the environment variables to set when there is no certificate' {
        # The failure happens on a CI runner with nobody watching, so the
        # message has to say what to do.
        $message = ''
        try {
            Resolve-JarvisSigningConfiguration -Thumbprint '' -PfxPath '' -TimestampUrl 'http://ts' | Out-Null
        } catch {
            $message = $_.Exception.Message
        }
        $message | Should Match 'JARVIS_SIGNING_THUMBPRINT'
        $message | Should Match 'JARVIS_SIGNING_PFX_PATH'
        $message | Should Match 'JARVIS_SIGNING_COMMAND'
    }

    It 'accepts a signing-service command instead of a certificate' {
        # Azure Artifact Signing and SignPath never hand over a private key;
        # the provider signs the artifact itself. The pipeline has to work
        # with the provider's command, not only with a PFX.
        $config = Resolve-JarvisSigningConfiguration -Thumbprint '' -PfxPath '' `
            -TimestampUrl 'http://ts' -Command 'C:\tools\azure-sign.cmd'
        $config.mode | Should Be 'command'
        $config.command | Should Be 'C:\tools\azure-sign.cmd'
    }

    It 'prefers the command when both a command and a certificate are given' {
        # The command is the more specific instruction.
        $config = Resolve-JarvisSigningConfiguration -Thumbprint 'ABC123' -PfxPath '' `
            -TimestampUrl 'http://ts' -Command 'C:\tools\azure-sign.cmd'
        $config.mode | Should Be 'command'
    }
}

Describe 'release record' {
    BeforeEach {
        $script:artifact = Join-Path $TestDrive 'installer.exe'
        'installer bytes' | Out-File $script:artifact -Encoding utf8
        $script:identity = [pscustomobject]@{
            git_sha            = '0123456789ABCDEF0123456789ABCDEF01234567'
            git_dirty          = $false
            built_at           = '2026-10-19T12:00:00Z'
            source_tree_sha256 = 'AABBCCDDEEFF00112233445566778899AABBCCDD'
        }
    }

    It 'records every artifact with its hash' {
        $manifest = New-JarvisReleaseManifest -Version '1.0.0' -Identity $script:identity -Artifacts @(
            @{ role = 'installer'; path = $script:artifact }
        )
        $manifest.schema | Should Be 'jarvis.release/1'
        $manifest.version | Should Be '1.0.0'
        $manifest.git_sha | Should Be $script:identity.git_sha
        $manifest.files.Count | Should Be 1
        $manifest.files[0].role | Should Be 'installer'
        $manifest.files[0].sha256 | Should Be (Get-FileHash -LiteralPath $script:artifact -Algorithm SHA256).Hash
    }

    It 'refuses a record whose artifact is missing' {
        { New-JarvisReleaseManifest -Version '1.0.0' -Identity $script:identity -Artifacts @(
            @{ role = 'installer'; path = (Join-Path $TestDrive 'absent.exe') }
        ) } | Should Throw 'release_artifact_missing'
    }

    It 'round-trips through disk and writes checksums' {
        $manifest = New-JarvisReleaseManifest -Version '1.0.0' -Identity $script:identity -Artifacts @(
            @{ role = 'installer'; path = $script:artifact; published = $true }
        )
        $path = Join-Path $TestDrive 'jarvis-release.json'
        $written = Write-JarvisReleaseManifest -Manifest $manifest -Path $path
        $written.manifest | Should Exist
        $written.sums | Should Exist

        $readBack = Read-JarvisReleaseManifest -Path $path
        $readBack.git_sha | Should Be $script:identity.git_sha
        $readBack.files[0].sha256 | Should Be $manifest.files[0].sha256

        $sums = Get-Content -Raw -LiteralPath $written.sums
        $sums | Should Match ([regex]::Escape($manifest.files[0].sha256.ToLowerInvariant()))
    }

    It 'lists every artifact in the record but only the published ones in the checksums' {
        # SHA256SUMS.txt is what a downloader can actually check, so it must
        # not name files that were not published.
        $other = Join-Path $TestDrive 'server-bundle.js'
        'bundle' | Out-File $other -Encoding utf8
        $manifest = New-JarvisReleaseManifest -Version '1.0.0' -Identity $script:identity -Artifacts @(
            @{ role = 'installer'; path = $script:artifact; published = $true }
            @{ role = 'server_bundle'; path = $other }
        )
        $written = Write-JarvisReleaseManifest -Manifest $manifest -Path (Join-Path $TestDrive 'jarvis-release.json')

        $manifest.files.Count | Should Be 2
        $manifest.files[0].published | Should Be $true
        $manifest.files[1].published | Should Be $false

        # @() because Get-Content returns a bare string for a single line,
        # and $sums[0] on a string is its first CHARACTER, not its first line.
        $sums = @(Get-Content -LiteralPath $written.sums)
        $sums.Count | Should Be 1
        $sums[0] | Should Match ([regex]::Escape($manifest.files[0].sha256.ToLowerInvariant()))
        $sums[0] | Should Not Match 'server-bundle'
    }
}

Describe 'installed binary matching' {
    BeforeEach {
        $script:installRoot = Join-Path $TestDrive 'install'
        New-Item -ItemType Directory -Force -Path $script:installRoot | Out-Null
        $script:appBinary = Join-Path $script:installRoot 'home-base.exe'
        'the app binary' | Out-File $script:appBinary -Encoding utf8
        $script:uninstaller = Join-Path $script:installRoot 'uninstall.exe'
        'the uninstaller' | Out-File $script:uninstaller -Encoding utf8
        $script:appHash = (Get-FileHash -LiteralPath $script:appBinary -Algorithm SHA256).Hash
    }

    It 'finds the installed binary by hash, whatever it is called' {
        # The installer lays the binary down under the crate name
        # (home-base.exe) while the release directory stages it as
        # Jarvis.exe. Matching by name would miss a good install.
        $found = Find-JarvisInstalledBinary -InstallRoot $script:installRoot -ExpectedSha256 $script:appHash
        $found | Should Be $script:appBinary
    }

    It 'does not settle for the uninstaller' {
        $found = Find-JarvisInstalledBinary -InstallRoot $script:installRoot `
            -ExpectedSha256 (Get-FileHash -LiteralPath $script:uninstaller -Algorithm SHA256).Hash
        $found | Should BeNullOrEmpty
    }

    It 'returns nothing when the install does not carry the recorded binary' {
        $found = Find-JarvisInstalledBinary -InstallRoot $script:installRoot -ExpectedSha256 ('A' * 64)
        $found | Should BeNullOrEmpty
    }
}

Describe 'release record paths' {
    It 'records artifact paths relative to the release directory' {
        # The record is published to a public release; absolute build
        # machine paths in it are noise at best.
        $root = Join-Path $TestDrive 'release'
        New-Item -ItemType Directory -Force -Path (Join-Path $root 'resources') | Out-Null
        $installer = Join-Path $root 'Jarvis_1.0.0_x64-setup.exe'
        'installer bytes' | Out-File $installer -Encoding utf8
        $proxy = Join-Path $root 'resources\claude_cli_proxy.py'
        'proxy bytes' | Out-File $proxy -Encoding utf8

        $identity = [pscustomobject]@{
            git_sha = '0123456789ABCDEF0123456789ABCDEF01234567'; git_dirty = $false
            built_at = '2026-10-19T12:00:00Z'; source_tree_sha256 = 'AABBCCDDEEFF00112233445566778899AABBCCDD'
        }
        $manifest = New-JarvisReleaseManifest -Version '1.0.0' -Identity $identity -Root $root -Artifacts @(
            @{ role = 'installer'; path = $installer }
            @{ role = 'claude_proxy'; path = $proxy }
        )
        $manifest.files[0].path | Should Be 'Jarvis_1.0.0_x64-setup.exe'
        $manifest.files[1].path | Should Be 'resources\claude_cli_proxy.py'
    }

    It 'resolves a recorded path back against the record' {
        $resolved = Resolve-JarvisManifestPath -ManifestPath 'C:\release\1.0.0\jarvis-release.json' -ArtifactPath 'index.js'
        $resolved | Should Be 'C:\release\1.0.0\index.js'
    }

    It 'leaves an absolute recorded path alone' {
        $resolved = Resolve-JarvisManifestPath -ManifestPath 'C:\release\1.0.0\jarvis-release.json' -ArtifactPath 'D:\other\index.js'
        $resolved | Should Be 'D:\other\index.js'
    }
}

Describe 'the main binary name' {
    It 'reads the crate name the installer uses' {
        # The installer lays the binary down as home-base.exe, not
        # Jarvis.exe: the product name is for display and shortcuts, the
        # crate name is what Cargo produces and what ships.
        Get-JarvisMainBinaryName -RepoRoot $repoRoot | Should Be 'home-base'
    }
}

Describe 'the app binary is read from a real install' {
    It 'installs the installer to learn what the app binary really is' {
        # target/release/home-base.exe and the exe the installer carries are
        # NOT the same bytes: Tauri's bundler patches a copy of it with the
        # bundle type information. A record that hashed the build-tree copy
        # would describe a file no user ever runs.
        $releaseBuild = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts\release-build.ps1')
        $releaseBuild | Should Match 'Install-JarvisRelease'
        $releaseBuild | Should Match 'app_binary_name'
    }

    It 'does not stage the app binary from the build tree' {
        $releaseBuild = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts\release-build.ps1')
        $releaseBuild | Should Not Match "target\\release\\home-base\.exe'"
    }
}

Describe 'the release pipeline is wired' {
    It 'builds the frontend through the shared build script' {
        # The old beforeBuildCommand rebuilt the server bundle WITHOUT the
        # build identity, so a `cargo tauri build` silently undid the
        # provenance bake and the installed app reported git_sha "dev".
        $conf = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'src-tauri\tauri.conf.json') | ConvertFrom-Json
        $conf.build.beforeBuildCommand | Should Match 'build-frontend'
    }

    It 'has a release workflow' {
        $workflow = Join-Path $repoRoot '.github\workflows\release.yml'
        $workflow | Should Exist
    }

    It 'builds and smokes through the repository scripts' {
        $workflow = Get-Content -Raw -LiteralPath (Join-Path $repoRoot '.github\workflows\release.yml')
        $workflow | Should Match 'release-build\.ps1'
        $workflow | Should Match 'release-smoke\.ps1'
    }

    It 'signs before the release record is written' {
        # Signing changes the bytes, so a record written before signing
        # would describe an installer that no longer matches its own hash.
        $releaseBuild = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts\release-build.ps1')
        $signIndex = $releaseBuild.IndexOf('Invoke-JarvisInstallerSigning')
        $recordIndex = $releaseBuild.IndexOf('New-JarvisReleaseManifest')
        $signIndex | Should BeGreaterThan 0
        $recordIndex | Should BeGreaterThan 0
        $signIndex | Should BeLessThan $recordIndex
    }

    It 'signs the installer with a certificate the operator supplies' {
        $releaseBuild = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts\release-build.ps1')
        $releaseBuild | Should Match 'JARVIS_SIGNING_PFX_PATH'
        $releaseBuild | Should Match 'JARVIS_SIGNING_THUMBPRINT'
    }

    It 'refuses to publish an unsigned release' {
        $workflow = Get-Content -Raw -LiteralPath (Join-Path $repoRoot '.github\workflows\release.yml')
        $workflow | Should Match 'allow_unsigned'
        $workflow | Should Match 'Require a signature'
    }

    It 'declares the Windows signing configuration in the bundle' {
        $conf = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'src-tauri\tauri.conf.json') | ConvertFrom-Json
        $conf.bundle.windows.digestAlgorithm | Should Be 'sha256'
        $conf.bundle.windows.timestampUrl | Should Not BeNullOrEmpty
    }

    It 'has one implementation of the build bake' {
        # The deploy path and the release path must bake the identity the
        # same way, or a deploy and a release of the same commit report
        # different builds. build-and-deploy.ps1 used to carry its own copy
        # of the recipe, including the PowerShell quoting trap.
        $deploy = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts\build-and-deploy.ps1')
        $deploy | Should Match 'build-frontend'
        $deploy | Should Not Match 'bun build \./src/index\.ts'
    }

    It 'checks the bake folded the identity into the deploy bundle' {
        $deploy = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts\build-and-deploy.ps1')
        $deploy | Should Match 'Test-JarvisBundleProvenance'
    }
}
