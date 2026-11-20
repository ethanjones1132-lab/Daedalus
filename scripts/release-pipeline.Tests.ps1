$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

function Format-JarvisChildArgument {
    # Start-Process joins -ArgumentList with single spaces and adds no quoting
    # of its own, so an argument that contains a space has to arrive quoted.
    param([string]$Value)
    if ($null -eq $Value) { return '""' }
    if ($Value -match '[\s"]') { return '"' + $Value.Replace('"', '\"') + '"' }
    return $Value
}

function Invoke-JarvisFixtureGit {
    <#
    .SYNOPSIS
        Run one git command for a fixture, with a hard timeout.

    .DESCRIPTION
        DD-126: `& git` waits for the child with no bound at all. A git that
        stops answering would hang the release gate instead of failing the
        fixture, so every fixture command goes through the bounded runner.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Repository,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Step,
        [switch]$MergeStandardError
    )
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw 'git_fixture_git_missing' }
    $quoted = @('-C', (Format-JarvisChildArgument $Repository))
    foreach ($argument in @($Arguments)) { $quoted += Format-JarvisChildArgument $argument }
    return Invoke-JarvisBoundedChild -FilePath $git.Source -ArgumentList $quoted `
        -Step $Step -TimeoutMs 60000 -MergeStandardError:$MergeStandardError
}

function New-JarvisGitFixture {
    param([Parameter(Mandatory = $true)][string]$Name, [switch]$WithPrompts)

    $root = Join-Path $TestDrive $Name
    foreach ($relative in @('server-jarvis\src', 'src-tauri\src', 'src-ui\src', 'scripts')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $root $relative) | Out-Null
    }
    'fixture source bytes' | Set-Content -LiteralPath (Join-Path $root 'server-jarvis\src\fixture.ts')
    if ($WithPrompts) {
        $prompts = Join-Path $root 'server-jarvis\src\prompts'
        New-Item -ItemType Directory -Force -Path $prompts | Out-Null
        'fixture prompt' | Set-Content -LiteralPath (Join-Path $prompts 'system.md')
    }
    $steps = @(
        @{ arguments = @('init', '--quiet'); failure = 'git_fixture_init_failed' }
        @{ arguments = @('config', 'user.name', '"Pester Fixture"'); failure = 'git_fixture_config_failed' }
        @{ arguments = @('config', 'user.email', 'pester-fixture@example.invalid'); failure = 'git_fixture_config_failed' }
        @{ arguments = @('add', '--all'); failure = 'git_fixture_add_failed' }
        @{ arguments = @('commit', '--quiet', '-m', 'fixture'); failure = 'git_fixture_commit_failed' }
    )
    foreach ($step in $steps) {
        $result = Invoke-JarvisFixtureGit -Repository $root -Arguments $step.arguments `
            -Step "git_$($step.arguments[0])"
        if ($result.exit_code -ne 0) { throw $step.failure }
    }
    return $root
}

Describe 'the bounded child runner' {
    # DD-142: Invoke-JarvisBoundedChild read ExitCode off the object that
    # Start-Process -PassThru returns, and that object never carries the code:
    # a clean child reported $null instead of 0, and a failing child's code was
    # never real. The child is now started through Process.Start, which keeps
    # the handle, and these cases pin the code as well as the bounded wait.

    It 'returns exit code 0 for a child that succeeds' {
        $git = Get-Command git -ErrorAction SilentlyContinue
        if (-not $git) { throw 'git_missing' }
        $result = Invoke-JarvisBoundedChild -FilePath $git.Source -ArgumentList @('--version') `
            -Step 'git_version' -TimeoutMs 30000
        # Pre-fix this is $null, so a clean step was reported failed by callers
        # that compare the code to zero.
        $result.exit_code | Should Be 0
    }

    It 'returns the real non-zero exit code instead of $null' {
        $git = Get-Command git -ErrorAction SilentlyContinue
        if (-not $git) { throw 'git_missing' }
        $missing = Join-Path $TestDrive ('missing-repository-' + [guid]::NewGuid().ToString('N'))
        $result = Invoke-JarvisBoundedChild -FilePath $git.Source `
            -ArgumentList @('-C', (Format-JarvisChildArgument $missing), 'status') `
            -Step 'git_status' -TimeoutMs 30000 -MergeStandardError
        # git cannot enter the directory, so it exits 128 before touching a
        # repository. Pre-fix this is $null, and a failed step could read as
        # anything the caller happened to compare it to.
        $result.exit_code | Should Be 128
        $result.exit_code | Should Not BeNullOrEmpty
    }

    It 'throws the bounded timeout and kills a child that never exits' {
        $shell = Get-Command powershell.exe -ErrorAction SilentlyContinue
        if (-not $shell) { throw 'powershell_missing' }
        $childPidFile = Join-Path $TestDrive ('timed-out-child-' + [guid]::NewGuid().ToString('N') + '.pid')
        # The child reports its own pid first, then outlives any short bound.
        $command = "Set-Content -LiteralPath '$childPidFile' -Value `$PID; Start-Sleep -Seconds 120"
        $started = Get-Date
        { Invoke-JarvisBoundedChild -FilePath $shell.Source `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', (Format-JarvisChildArgument $command)) `
            -Step 'never_exits' -TimeoutMs 5000 } | Should Throw 'never_exits_timeout'
        # The bound, not the child's 120 seconds, ended the wait.
        ((Get-Date) - $started).TotalSeconds | Should BeLessThan 60
        if (-not (Test-Path -LiteralPath $childPidFile)) { throw 'timed_out_child_did_not_start' }
        $childPid = [int](Get-Content -LiteralPath $childPidFile -Raw)
        # Bounded observation that the kill took effect; if the child survived
        # this wait, the assertion below fails instead of hanging.
        try { $null = Wait-Process -Id $childPid -Timeout 10 -ErrorAction Stop } catch { }
        @(Get-Process -Id $childPid -ErrorAction SilentlyContinue).Count | Should Be 0
    }
}

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

Describe 'build and prompts tree identity' {
    It 'fails build identity when git status cannot read the repository index' {
        $fake = New-JarvisGitFixture -Name 'broken-index-repo'
        [IO.File]::WriteAllText((Join-Path $fake '.git\index'), 'garbage index bytes')

        $null = & git -C $fake status --porcelain 2>&1
        $LASTEXITCODE | Should Not Be 0
        { Get-JarvisBuildIdentity -RepoRoot $fake } | Should Throw 'git_status_unavailable'
    }

    It 'returns the HEAD prompts tree only when the worktree prompts match it' {
        $fake = New-JarvisGitFixture -Name 'clean-prompts-repo' -WithPrompts
        $expected = (& git -C $fake rev-parse 'HEAD:server-jarvis/src/prompts' | Out-String).Trim()
        $tree = Get-JarvisPromptsTreeSha256 -RepoRoot $fake
        $tree | Should Be $expected

        'changed prompt bytes' | Set-Content -LiteralPath (Join-Path $fake 'server-jarvis\src\prompts\system.md')
        { Get-JarvisPromptsTreeSha256 -RepoRoot $fake } | Should Throw 'prompts_tree_dirty'
    }

    It 'rejects a prompts directory that is not present in HEAD' {
        $fake = New-JarvisGitFixture -Name 'missing-head-prompts-repo'
        New-Item -ItemType Directory -Force -Path (Join-Path $fake 'server-jarvis\src\prompts') | Out-Null
        'uncommitted prompt' | Set-Content -LiteralPath (Join-Path $fake 'server-jarvis\src\prompts\system.md')
        { Get-JarvisPromptsTreeSha256 -RepoRoot $fake } | Should Throw 'prompts_tree_unavailable'
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

    It 'rejects identity that only appears as bare substrings' {
        # A comment or a longer token can contain the hex strings without any
        # define having folded. Unanchored substring matching accepted this.
        $bundle = Join-Path $TestDrive 'substring.js'
        @(
            "// provenance comment: sha $($script:identity.git_sha) tree $($script:identity.source_tree_sha256)"
            "var SHA = 'x$($script:identity.git_sha)x';"
            "var TREE = 'x$($script:identity.source_tree_sha256)x';"
        ) | Out-File $bundle -Encoding utf8
        $result = Test-JarvisBundleProvenance -BundlePath $bundle -Identity $script:identity
        $result.ok | Should Be $false
        $result.reason | Should Match 'sha_not_folded'
    }

    It 'rejects a source tree digest that is only an unquoted substring' {
        $bundle = Join-Path $TestDrive 'tree-substring.js'
        @(
            "var SHA = `"$($script:identity.git_sha)`";"
            "// tree digest only as a longer token: x$($script:identity.source_tree_sha256)x"
        ) | Out-File $bundle -Encoding utf8
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
        $config.thumbprint_source | Should Be 'operator'
    }

    It 'keeps an operator thumbprint authoritative when a PFX is also configured' {
        $pfx = Join-Path $TestDrive 'operator-configured.pfx'
        'fabricated pfx bytes' | Set-Content -LiteralPath $pfx
        $config = Resolve-JarvisSigningConfiguration -Thumbprint 'operator-123' -PfxPath $pfx -TimestampUrl 'http://ts'
        $config.thumbprint | Should Be 'OPERATOR-123'
        $config.thumbprint_source | Should Be 'operator'
        $config.pfx_path | Should BeNullOrEmpty
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

    It 'marks the thumbprint as PFX sourced when no operator thumbprint is given' {
        $pfx = Join-Path $TestDrive 'pfx-configured.pfx'
        'fabricated pfx bytes' | Set-Content -LiteralPath $pfx
        Mock Get-JarvisPfxThumbprint { 'PFX-123' }
        $config = Resolve-JarvisSigningConfiguration -Thumbprint '' -PfxPath $pfx `
            -PfxPassword '' -TimestampUrl 'http://ts'
        $config.thumbprint_source | Should Be 'pfx'
        $config.thumbprint | Should Be 'PFX-123'
        $config.pfx_path | Should Be $pfx
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

Describe 'refreshing the release record after a standalone signature' {
    # sign-installer.ps1 signs an installer that release-build.ps1 already
    # recorded. Signing changes the bytes, so the record and the downloadable
    # SHA256SUMS.txt would otherwise keep pointing at the unsigned artifact.
    # Everything here is a temporary dummy installer and a fabricated record:
    # no signer, certificate, timestamp service or network is touched.
    BeforeEach {
        $script:signedReleaseDir = Join-Path $TestDrive 'signed-release'
        New-Item -ItemType Directory -Force -Path $script:signedReleaseDir | Out-Null
        $script:signedInstaller = Join-Path $script:signedReleaseDir 'Jarvis_1.0.0_x64-setup.exe'
        'unsigned installer bytes' | Out-File -LiteralPath $script:signedInstaller -Encoding utf8
        $script:signedBundle = Join-Path $script:signedReleaseDir 'index.js'
        'server bundle bytes' | Out-File -LiteralPath $script:signedBundle -Encoding utf8
        $script:signedSums = Join-Path $script:signedReleaseDir 'SHA256SUMS.txt'
        $script:signedManifest = Join-Path $script:signedReleaseDir 'jarvis-release.json'
        $script:signedIdentity = [pscustomobject]@{
            git_sha            = '0123456789ABCDEF0123456789ABCDEF01234567'
            git_dirty          = $false
            built_at           = '2026-10-19T12:00:00Z'
            source_tree_sha256 = 'AABBCCDDEEFF00112233445566778899AABBCCDD'
        }
        $manifest = New-JarvisReleaseManifest -Version '1.0.0' -Identity $script:signedIdentity `
            -Root $script:signedReleaseDir -Artifacts @(
                @{ role = 'installer'; path = $script:signedInstaller; published = $true }
                @{ role = 'server_bundle'; path = $script:signedBundle }
            ) -Extra @{
                signed           = $false
                signature_status = $null
            }
        Write-JarvisReleaseManifest -Manifest $manifest -Path $script:signedManifest | Out-Null
        $script:signedUnsignedSha = Get-JarvisFileSha256 -Path $script:signedInstaller
        $script:signedBundleSha = Get-JarvisFileSha256 -Path $script:signedBundle
    }

    It 'recalculates the signed installer hash, size and checksum' {
        # The byte change stands in for a signature, without any signer.
        'signed installer bytes, longer than the unsigned ones' |
            Out-File -LiteralPath $script:signedInstaller -Encoding utf8

        $refresh = Update-JarvisReleaseInstallerRecord -InstallerPath $script:signedInstaller `
            -Signature ([pscustomobject]@{ status = 'Valid'; subject = 'CN=Jarvis Release' })

        $refresh.refreshed | Should Be $true
        $refresh.entries | Should Be 1
        $refresh.sha256 | Should Be (Get-JarvisFileSha256 -Path $script:signedInstaller)

        $record = Read-JarvisReleaseManifest -Path $script:signedManifest
        $entry = @($record.files) | Where-Object { $_.role -eq 'installer' }
        $signedLength = (Get-Item -LiteralPath $script:signedInstaller).Length
        $entry.sha256 | Should Be (Get-JarvisFileSha256 -Path $script:signedInstaller)
        $entry.sha256 | Should Not Be $script:signedUnsignedSha
        $entry.size_bytes | Should Be $signedLength
        $entry.name | Should Be 'Jarvis_1.0.0_x64-setup.exe'
        $entry.published | Should Be $true

        $sums = @(Get-Content -LiteralPath $script:signedSums)
        $sums.Count | Should Be 1
        $sums[0] | Should Match ([regex]::Escape($entry.sha256.ToLowerInvariant()))
        $sums[0] | Should Not Match ([regex]::Escape($script:signedUnsignedSha.ToLowerInvariant()))
    }

    It 'keeps identity, version and every unrelated artifact' {
        'signed installer bytes, longer than the unsigned ones' |
            Out-File -LiteralPath $script:signedInstaller -Encoding utf8

        $refresh = Update-JarvisReleaseInstallerRecord -InstallerPath $script:signedInstaller `
            -Signature ([pscustomobject]@{ status = 'Valid'; subject = 'CN=Jarvis Release' })
        $refresh.refreshed | Should Be $true

        $record = Read-JarvisReleaseManifest -Path $script:signedManifest
        # A standalone signature is not a new build: the commit and source
        # tree are facts signing cannot know better than the record did.
        $record.version | Should Be '1.0.0'
        $record.git_sha | Should Be $script:signedIdentity.git_sha
        $record.git_dirty | Should Be $false
        $record.built_at | Should Be $script:signedIdentity.built_at
        $record.source_tree_sha256 | Should Be $script:signedIdentity.source_tree_sha256

        $bundle = @($record.files) | Where-Object { $_.role -eq 'server_bundle' }
        $bundleLength = (Get-Item -LiteralPath $script:signedBundle).Length
        $bundle.sha256 | Should Be $script:signedBundleSha
        $bundle.size_bytes | Should Be $bundleLength
        $bundle.path | Should Be 'index.js'
        $bundle.published | Should Be $false

        # The signature is now what the record says happened, because the
        # record already carried those fields.
        $record.signed | Should Be $true
        $record.signature_status | Should Be 'Valid'

        # The unpublished bundle still stays out of the download checksums.
        @(Get-Content -LiteralPath $script:signedSums).Count | Should Be 1
    }

    It 'reports a missing record instead of inventing one' {
        Remove-Item -LiteralPath $script:signedManifest -Force
        Remove-Item -LiteralPath $script:signedSums -Force

        $refresh = Update-JarvisReleaseInstallerRecord -InstallerPath $script:signedInstaller

        $refresh.refreshed | Should Be $false
        $refresh.reason | Should Match 'release_manifest_missing'
        $refresh.sha256 | Should BeNullOrEmpty
        $script:signedManifest | Should Not Exist
        $script:signedSums | Should Not Exist
    }

    It 'writes nothing for a bare installer with no record at all' {
        $bareDir = Join-Path $TestDrive 'bare'
        New-Item -ItemType Directory -Force -Path $bareDir | Out-Null
        $bare = Join-Path $bareDir 'Jarvis_1.0.0_x64-setup.exe'
        'bare installer bytes' | Out-File -LiteralPath $bare -Encoding utf8

        $refresh = Update-JarvisReleaseInstallerRecord -InstallerPath $bare

        $refresh.refreshed | Should Be $false
        $refresh.reason | Should Match 'release_manifest_missing'
        (Join-Path $bareDir 'jarvis-release.json') | Should Not Exist
        (Join-Path $bareDir 'SHA256SUMS.txt') | Should Not Exist
    }

    It 'refuses a malformed record' {
        'this is not a release record' | Out-File -LiteralPath $script:signedManifest -Encoding utf8

        { Update-JarvisReleaseInstallerRecord -InstallerPath $script:signedInstaller } |
            Should Throw 'release_manifest_malformed'
    }

    It 'refuses a record with an unexpected schema' {
        '{ "schema": "jarvis.release/99", "files": [] }' |
            Out-File -LiteralPath $script:signedManifest -Encoding utf8

        { Update-JarvisReleaseInstallerRecord -InstallerPath $script:signedInstaller } |
            Should Throw 'release_manifest_malformed'
    }

    It 'refuses a record that names a different installer' {
        $other = Join-Path $script:signedReleaseDir 'Jarvis_2.0.0_x64-setup.exe'
        'other installer bytes' | Out-File -LiteralPath $other -Encoding utf8
        $otherManifest = New-JarvisReleaseManifest -Version '2.0.0' -Identity $script:signedIdentity `
            -Root $script:signedReleaseDir -Artifacts @(
                @{ role = 'installer'; path = $other; published = $true }
            )
        Write-JarvisReleaseManifest -Manifest $otherManifest -Path $script:signedManifest | Out-Null
        $before = Get-Content -Raw -LiteralPath $script:signedManifest

        { Update-JarvisReleaseInstallerRecord -InstallerPath $script:signedInstaller } |
            Should Throw 'release_manifest_installer_mismatch'

        # The other installer's record was not rewritten either.
        (Get-Content -Raw -LiteralPath $script:signedManifest) | Should Be $before
    }

    It 'refreshes the record after signing, not before' {
        $source = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts\sign-installer.ps1')
        $signIndex = $source.IndexOf('Invoke-JarvisInstallerSigning')
        $refreshIndex = $source.IndexOf('Update-JarvisReleaseInstallerRecord')
        $signIndex | Should BeGreaterThan 0
        $refreshIndex | Should BeGreaterThan $signIndex
    }

    It 'leaves VerifyOnly read-only' {
        $source = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts\sign-installer.ps1')
        $verifyIndex = $source.IndexOf('if ($VerifyOnly) {')
        $verifyExit = $source.IndexOf('Signature verification passed.')
        $refreshIndex = $source.IndexOf('Update-JarvisReleaseInstallerRecord')
        $verifyIndex | Should BeGreaterThan 0
        $verifyExit | Should BeGreaterThan $verifyIndex
        $refreshIndex | Should BeGreaterThan $verifyExit
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

Describe 'locating the build machine Bun' {
    It 'finds bun on PATH before the profile copy' {
        # The release runner advertises Bun on PATH. The build used to look
        # only at %USERPROFILE%\.bun\bin\bun.exe, so it could not build the
        # installer on a machine where `bun --version` works.
        $pathDir = Join-Path $TestDrive 'bun-on-path'
        New-Item -ItemType Directory -Force -Path $pathDir | Out-Null
        $pathBun = Join-Path $pathDir 'bun.exe'
        'fixture bun bytes' | Set-Content -LiteralPath $pathBun

        # A profile copy exists too, with different bytes: PATH has to
        # WIN, not merely be accepted when the profile is empty. This case
        # fails if the resolver is reverted to the hardcoded profile path.
        $profileBun = Join-Path $TestDrive 'bun-in-profile\.bun\bin\bun.exe'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profileBun) | Out-Null
        'profile bun bytes' | Set-Content -LiteralPath $profileBun

        $savedPath = $env:PATH
        try {
            $env:PATH = "$pathDir;$savedPath"
            $resolved = Resolve-JarvisBundledBunSource -ProfilePath $profileBun
        } finally {
            $env:PATH = $savedPath
        }

        $resolved | Should Be $pathBun
        (Get-Content -Raw -LiteralPath $resolved) | Should Match 'fixture bun bytes'
    }

    It 'falls back to the profile copy when PATH has no bun' {
        $emptyDir = Join-Path $TestDrive 'path-without-bun'
        New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null
        $profileBun = Join-Path $TestDrive 'profile-only\.bun\bin\bun.exe'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $profileBun) | Out-Null
        'profile bun bytes' | Set-Content -LiteralPath $profileBun

        Resolve-JarvisBundledBunSource -SearchPath $emptyDir -ProfilePath $profileBun |
            Should Be $profileBun
    }

    It 'fails with bundled_bun_source_missing when neither location has Bun' {
        $emptyDir = Join-Path $TestDrive 'no-bun-on-path'
        New-Item -ItemType Directory -Force -Path $emptyDir | Out-Null
        $missingProfile = Join-Path $TestDrive 'no-bun-in-profile\.bun\bin\bun.exe'

        { Resolve-JarvisBundledBunSource -SearchPath $emptyDir -ProfilePath $missingProfile } |
            Should Throw 'bundled_bun_source_missing'
    }

    It 'does not stage some other executable as the bundled Bun' {
        # "Fall back" must never mean "grab whatever is next". A directory
        # holding node.exe is not a place Bun was found.
        $otherDir = Join-Path $TestDrive 'path-with-node'
        New-Item -ItemType Directory -Force -Path $otherDir | Out-Null
        'not bun' | Set-Content -LiteralPath (Join-Path $otherDir 'node.exe')
        $missingProfile = Join-Path $TestDrive 'still-no-bun-in-profile\.bun\bin\bun.exe'

        { Resolve-JarvisBundledBunSource -SearchPath $otherDir -ProfilePath $missingProfile } |
            Should Throw 'bundled_bun_source_missing'
    }

    It 'is what the release build uses to pick the Bun it stages' {
        $releaseBuild = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts\release-build.ps1')
        $releaseBuild | Should Match 'Resolve-JarvisBundledBunSource'
        $releaseBuild | Should Match 'Stage-JarvisBundledBun'
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

Describe 'the installed prompts tree is required' {
    # The server reads prompts/*.md from disk at runtime (they are NOT compiled
    # into index.js), so an install without its prompts cannot answer a
    # request. The record names coordinator.md, one file inside the tree, so a
    # tree that is missing or empty fails here instead of at the first chat.
    BeforeEach {
        $script:promptsInstallRoot = Join-Path $TestDrive 'installed-prompts'
        foreach ($dir in @('resources', 'prompts')) {
            New-Item -ItemType Directory -Force -Path (Join-Path $script:promptsInstallRoot $dir) | Out-Null
        }
        $script:promptsResourceNames = [ordered]@{
            server_bundle = 'index.js'
            mcp_stdio     = 'mcp-stdio-server.js'
            claude_proxy  = 'resources\claude_cli_proxy.py'
            go_models     = 'resources\opencode_go_openai_models.json'
            bundled_bun   = 'bun.exe'
            prompts       = 'prompts\coordinator.md'
        }
        $files = foreach ($role in $script:promptsResourceNames.Keys) {
            $path = Join-Path $script:promptsInstallRoot $script:promptsResourceNames[$role]
            "$role expected bytes" | Set-Content -LiteralPath $path
            [pscustomobject]@{ role = $role; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
        }
        $script:promptsManifest = [pscustomobject]@{
            files               = @($files)
            prompts_tree_sha256 = ('a' * 40)
        }
        $script:promptsDir = Join-Path $script:promptsInstallRoot 'prompts'
        $script:promptsCoordinator = Join-Path $script:promptsDir 'coordinator.md'
    }

    It 'accepts a complete staged install that carries the recorded prompts' {
        (Test-JarvisInstalledResources -InstallRoot $script:promptsInstallRoot -Manifest $script:promptsManifest).ok |
            Should Be $true
    }

    It 'rejects a staged install with no prompts tree' {
        Remove-Item -LiteralPath $script:promptsDir -Recurse -Force
        $result = Test-JarvisInstalledResources -InstallRoot $script:promptsInstallRoot -Manifest $script:promptsManifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'installed_resource_mismatch:prompts'
        $result.reason | Should Match 'artifact_missing'
    }

    It 'rejects a staged install whose prompts tree is empty' {
        # The directory is there but holds no coordinator.md: the shape an
        # installer with a broken prompts copy would leave behind.
        Remove-Item -LiteralPath $script:promptsCoordinator -Force
        $result = Test-JarvisInstalledResources -InstallRoot $script:promptsInstallRoot -Manifest $script:promptsManifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'installed_resource_mismatch:prompts'
    }

    It 'rejects the wrong coordinator.md' {
        'a different coordinator prompt' | Set-Content -LiteralPath $script:promptsCoordinator
        $result = Test-JarvisInstalledResources -InstallRoot $script:promptsInstallRoot -Manifest $script:promptsManifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'installed_resource_mismatch:prompts:hash_mismatch'
    }

    It 'rejects a current record that names the prompts tree but not the file it verifies' {
        # prompts_tree_sha256 says this record describes prompts, so a missing
        # coordinator.md entry is an incomplete record, not a legacy one.
        $script:promptsManifest.files = @($script:promptsManifest.files | Where-Object { $_.role -ne 'prompts' })
        $result = Test-JarvisInstalledResources -InstallRoot $script:promptsInstallRoot -Manifest $script:promptsManifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'installed_resource_record_missing:prompts'
    }

    It 'still accepts a record written before the prompts role existed' {
        # The documented suite stages installs from records that predate the
        # role; they name no prompts tree, so there is nothing to verify.
        $script:promptsManifest.files = @($script:promptsManifest.files | Where-Object { $_.role -ne 'prompts' })
        $script:promptsManifest.prompts_tree_sha256 = $null
        Remove-Item -LiteralPath $script:promptsDir -Recurse -Force
        (Test-JarvisInstalledResources -InstallRoot $script:promptsInstallRoot -Manifest $script:promptsManifest).ok |
            Should Be $true
    }
}

Describe 'the smoke launches the installed app' {
    BeforeEach {
        $script:launchRoot = Join-Path $TestDrive 'launch-install'
        New-Item -ItemType Directory -Force -Path $script:launchRoot | Out-Null
        $script:launchExe = Join-Path $script:launchRoot 'home-base.exe'
        'the installed app binary' | Set-Content -LiteralPath $script:launchExe
        $script:launchHash = (Get-FileHash -LiteralPath $script:launchExe -Algorithm SHA256).Hash
    }

    It 'targets the installed exe matched by the recorded hash' {
        # A green smoke must mean the app a user double-clicks booted. The
        # record names the staged executable (Jarvis.exe) while the installer
        # lays the binary down under the crate name, so the hash decides.
        $target = Resolve-JarvisAppLaunchTarget -InstallRoot $script:launchRoot `
            -ExpectedSha256 $script:launchHash -BinaryName 'Jarvis.exe'
        $target | Should Be $script:launchExe
    }

    It 'does not fall back to a Bun on PATH when no installed exe matches' {
        # Pointing the smoke at a PATH Bun is the regression this covers:
        # with no matching installed binary the launch must fail, not report
        # health from a runtime the installer never produced.
        $pathDir = Join-Path $TestDrive 'launch-path-bun'
        New-Item -ItemType Directory -Force -Path $pathDir | Out-Null
        'fixture bun bytes' | Set-Content -LiteralPath (Join-Path $pathDir 'bun.exe')
        $savedPath = $env:PATH
        try {
            $env:PATH = "$pathDir;$savedPath"
            { Resolve-JarvisAppLaunchTarget -InstallRoot $script:launchRoot -ExpectedSha256 ('A' * 64) } |
                Should Throw 'installed_app_binary_missing'
        } finally {
            $env:PATH = $savedPath
        }
    }

    It 'refuses the bundled Bun as the launch target' {
        $bundled = Join-Path $script:launchRoot 'bun.exe'
        'bundled bun bytes' | Set-Content -LiteralPath $bundled
        $bundledHash = (Get-FileHash -LiteralPath $bundled -Algorithm SHA256).Hash
        { Resolve-JarvisAppLaunchTarget -InstallRoot $script:launchRoot -ExpectedSha256 $bundledHash } |
            Should Throw 'launch_target_is_bundled_runtime'
    }

    It 'refuses a target outside the install root' {
        $outside = Join-Path $TestDrive 'elsewhere\Jarvis.exe'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outside) | Out-Null
        'not the installed app' | Set-Content -LiteralPath $outside
        { Assert-JarvisInstalledAppTarget -AppPath $outside -InstallRoot $script:launchRoot } |
            Should Throw 'launch_target_not_installed'
    }

    It 'starts the installed exe from the launch step, not a PATH Bun' {
        $smoke = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts\release-smoke.ps1')
        $stepIndex = $smoke.IndexOf("Write-Step 'Launching the installed app'")
        $stepIndex | Should BeGreaterThan 0
        $chatIndex = $smoke.IndexOf("Sending a chat request", $stepIndex)
        $chatIndex | Should BeGreaterThan $stepIndex
        $launchStep = $smoke.Substring($stepIndex, $chatIndex - $stepIndex)
        $launchStep | Should Match 'Resolve-JarvisAppLaunchTarget'
        $launchStep | Should Match 'Start-JarvisInstalledApp -AppPath \$installedExe -InstallRoot \$InstallRoot'
        # The summary says which process produced the health answer.
        $smoke | Should Match 'health_source = \$healthSource'
        $smoke | Should Not Match 'Get-Command bun'
        $smoke | Should Not Match '\.bun\\bin\\bun\.exe'
        $smoke | Should Not Match 'Start-JarvisServerBundle'
    }
}

Describe 'compiling the Rust crate in a fresh worktree' {
    # `cargo test --lib` cannot run in a freshly cloned worktree. Tauri's build
    # script and generate_context!() need two gitignored inputs - the server
    # bundle under server-jarvis/dist and src-ui/dist (frontendDist) - that only
    # a frontend build produces. scripts/verify-rust.ps1 is the one command that
    # produces them and runs the tests, so a reviewer has a gate check.
    #
    # Every test here drives it with batch stubs for bun and cargo: the stub
    # records its working directory and argv and exits with a chosen code, so
    # nothing here builds, compiles or touches a real toolchain.

    function New-VerifyRustFixture {
        param([switch]$WithBuildOutputs)

        $root = Join-Path ([IO.Path]::GetTempPath()) ('verify-rust-fixture-' + [guid]::NewGuid().ToString('N'))
        foreach ($relative in @('server-jarvis\dist', 'src-ui\dist', 'src-tauri')) {
            New-Item -ItemType Directory -Force -Path (Join-Path $root $relative) | Out-Null
        }
        "[package]`nname = `"fixture`"`nversion = `"1.0.0`"" |
            Set-Content -LiteralPath (Join-Path $root 'src-tauri\Cargo.toml')
        if ($WithBuildOutputs) {
            'server bundle' | Set-Content -LiteralPath (Join-Path $root 'server-jarvis\dist\index.js')
            'tokenizer' | Set-Content -LiteralPath (Join-Path $root 'server-jarvis\dist\tokenizer.cjs')
            'mcp stdio' | Set-Content -LiteralPath (Join-Path $root 'server-jarvis\dist\mcp-stdio-server.js')
            '<!doctype html>' | Set-Content -LiteralPath (Join-Path $root 'src-ui\dist\index.html')
        }
        return $root
    }

    function New-VerifyRustStub {
        param(
            [Parameter(Mandatory = $true)][string]$Path,
            [Parameter(Mandatory = $true)][string]$Name,
            [int]$ExitCode = 0
        )

        # A batch stub, not bun or cargo. `%CD%` and `%*` are what let the
        # tests assert the step ran in the right package with the right argv.
        @(
            '@echo off'
            ('echo {0} %CD% ^| %* >> "%VERIFY_RUST_STUB_LOG%"' -f $Name)
            ('exit /b {0}' -f $ExitCode)
        ) | Set-Content -LiteralPath $Path
        return $Path
    }

    function Invoke-VerifyRust {
        param(
            [Parameter(Mandatory = $true)][string]$VerifyScript,
            [Parameter(Mandatory = $true)][string]$RepoRoot,
            [Parameter(Mandatory = $true)][string]$Bun,
            [Parameter(Mandatory = $true)][string]$Cargo,
            [Parameter(Mandatory = $true)][string]$StubLog
        )

        # Exactly the command the help text and docs give a reviewer.
        $env:VERIFY_RUST_STUB_LOG = $StubLog
        try {
            return & powershell -NoProfile -ExecutionPolicy Bypass -File $VerifyScript `
                -RepoRoot $RepoRoot -BunCommand $Bun -CargoCommand $Cargo 2>&1 | Out-String
        } finally {
            Remove-Item Env:\VERIFY_RUST_STUB_LOG -ErrorAction SilentlyContinue
        }
    }

    It 'is one command the docs give a reviewer for a fresh gate worktree' {
        $verify = Join-Path $repoRoot 'scripts\verify-rust.ps1'
        $verify | Should Exist

        $source = Get-Content -Raw -LiteralPath $verify
        $source | Should Match 'NoProfile -ExecutionPolicy Bypass -File scripts\\verify-rust\.ps1'
        $source | Should Match 'VERIFY-RUST: FAIL'

        $docs = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'docs\release-pipeline.md')
        $docs | Should Match 'verify-rust\.ps1'
        $docs | Should Match 'NoProfile -ExecutionPolicy Bypass'
    }

    It 'builds both Tauri inputs and runs cargo test --lib in src-tauri' {
        $fixture = New-VerifyRustFixture -WithBuildOutputs
        try {
            $stubLog = Join-Path $fixture 'stub-calls.log'
            $bun = New-VerifyRustStub -Path (Join-Path $fixture 'stub-bun.cmd') -Name 'bun'
            $cargo = New-VerifyRustStub -Path (Join-Path $fixture 'stub-cargo.cmd') -Name 'cargo'

            $output = Invoke-VerifyRust -VerifyScript (Join-Path $repoRoot 'scripts\verify-rust.ps1') `
                -RepoRoot $fixture -Bun $bun -Cargo $cargo -StubLog $stubLog
            $exitCode = $LASTEXITCODE

            $exitCode | Should Be 0
            $output | Should Match 'VERIFY-RUST: PASS'

            # The batch stub echoes its argv with a trailing space, so trim before
            # matching against the anchored patterns below.
            $calls = @(Get-Content -LiteralPath $stubLog -ErrorAction SilentlyContinue |
                ForEach-Object { $_.Trim() })

            # Both dists come from the projects' own build scripts, not from a
            # hand-rolled bun build line in this script.
            @($calls | Where-Object { $_ -match '^bun .*server-jarvis \| run build$' }).Count | Should Be 1
            @($calls | Where-Object { $_ -match '^bun .*src-ui \| run build$' }).Count | Should Be 1

            # The cargo step exists, runs in src-tauri, and asks for the lib
            # tests only. If the step is removed this count is 0 and the test
            # fails.
            $cargoCalls = @($calls | Where-Object { $_ -match '^cargo ' })
            $cargoCalls.Count | Should Be 1
            $cargoCalls[0] | Should Match '^cargo .*src-tauri \| test --lib$'
        } finally {
            Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'exits non-zero when cargo test exits non-zero' {
        $fixture = New-VerifyRustFixture -WithBuildOutputs
        try {
            $stubLog = Join-Path $fixture 'stub-calls.log'
            $bun = New-VerifyRustStub -Path (Join-Path $fixture 'stub-bun.cmd') -Name 'bun'
            $cargo = New-VerifyRustStub -Path (Join-Path $fixture 'stub-cargo.cmd') -Name 'cargo' -ExitCode 7

            $output = Invoke-VerifyRust -VerifyScript (Join-Path $repoRoot 'scripts\verify-rust.ps1') `
                -RepoRoot $fixture -Bun $bun -Cargo $cargo -StubLog $stubLog
            $exitCode = $LASTEXITCODE

            $exitCode | Should Not Be 0
            $output | Should Match 'VERIFY-RUST: FAIL - cargo test --lib failed'
        } finally {
            Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'fails when the build produced no server bundle' {
        $fixture = New-VerifyRustFixture
        try {
            $stubLog = Join-Path $fixture 'stub-calls.log'
            $bun = New-VerifyRustStub -Path (Join-Path $fixture 'stub-bun.cmd') -Name 'bun'
            $cargo = New-VerifyRustStub -Path (Join-Path $fixture 'stub-cargo.cmd') -Name 'cargo'

            $output = Invoke-VerifyRust -VerifyScript (Join-Path $repoRoot 'scripts\verify-rust.ps1') `
                -RepoRoot $fixture -Bun $bun -Cargo $cargo -StubLog $stubLog
            $exitCode = $LASTEXITCODE

            $exitCode | Should Not Be 0
            $output | Should Match 'build_output_missing: server-jarvis\\dist\\index\.js'
            # The Rust step is not reached, so the failure names the input the
            # reviewer has to produce, not a cargo error they cannot act on.
            $cargoCalls = @(Get-Content -LiteralPath $stubLog -ErrorAction SilentlyContinue |
                Where-Object { $_ -match '^cargo ' })
            $cargoCalls.Count | Should Be 0
        } finally {
            Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It 'fails when the build produced no ui bundle' {
        $fixture = New-VerifyRustFixture -WithBuildOutputs
        try {
            Remove-Item -LiteralPath (Join-Path $fixture 'src-ui\dist\index.html') -Force
            $stubLog = Join-Path $fixture 'stub-calls.log'
            $bun = New-VerifyRustStub -Path (Join-Path $fixture 'stub-bun.cmd') -Name 'bun'
            $cargo = New-VerifyRustStub -Path (Join-Path $fixture 'stub-cargo.cmd') -Name 'cargo'

            $output = Invoke-VerifyRust -VerifyScript (Join-Path $repoRoot 'scripts\verify-rust.ps1') `
                -RepoRoot $fixture -Bun $bun -Cargo $cargo -StubLog $stubLog
            $exitCode = $LASTEXITCODE

            $exitCode | Should Not Be 0
            $output | Should Match 'build_output_missing: src-ui\\dist\\index\.html'
        } finally {
            Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
