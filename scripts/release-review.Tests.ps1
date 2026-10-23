$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

Describe 'PFX password propagation' {
    It 'passes the supplied password to certificate inspection before import' {
        $pfx = Join-Path $TestDrive 'dummy.pfx'
        'not a real certificate' | Set-Content -LiteralPath $pfx
        Mock Get-JarvisPfxThumbprint {
            param($PfxPath, $Password)
            if ($Password -ne 'dummy-pass') { throw 'password_was_lost' }
            return 'ABC123'
        }
        $config = Resolve-JarvisSigningConfiguration -PfxPath $pfx -PfxPassword 'dummy-pass' -TimestampUrl 'http://ts'
        $config.thumbprint | Should Be 'ABC123'
    }

    It 'represents an empty PFX password without ConvertTo-SecureString rejecting it' {
        $password = ConvertTo-JarvisPfxPassword -Password ''
        $password.GetType().FullName | Should Be 'System.Security.SecureString'
        $password.Length | Should Be 0
    }

    It 'imports the PFX without making its private key exportable' {
        $pfx = Join-Path $TestDrive 'fabricated-import.pfx'
        'fabricated pfx fixture' | Set-Content -LiteralPath $pfx
        Mock Get-JarvisPfxThumbprint { 'ABC123' }
        Mock Get-ChildItem { @() } -ParameterFilter { $LiteralPath -eq 'Cert:\CurrentUser\My' }
        Mock Import-PfxCertificate {
            [pscustomobject]@{ Thumbprint = 'ABC123'; PSPath = 'Cert:\CurrentUser\My\ABC123' }
        }

        $imported = Import-JarvisSigningCertificate -PfxPath $pfx -Password 'fixture-password'

        $imported.JarvisImportedByRun | Should Be $true
        Assert-MockCalled Import-PfxCertificate -Scope It -Times 1 -Exactly -ParameterFilter {
            $FilePath -eq $pfx -and $CertStoreLocation -eq 'Cert:\CurrentUser\My' -and -not $Exportable
        }
    }

    It 'does not claim an operator-installed certificate as owned by the run' {
        $pfx = Join-Path $TestDrive 'already-installed.pfx'
        'fabricated pfx fixture' | Set-Content -LiteralPath $pfx
        $script:existingSigningCertificate = [pscustomobject]@{
            Thumbprint = 'ABC123'; PSPath = 'Cert:\CurrentUser\My\ABC123'
        }
        Mock Get-JarvisPfxThumbprint { 'ABC123' }
        Mock Get-ChildItem { @($script:existingSigningCertificate) } -ParameterFilter { $LiteralPath -eq 'Cert:\CurrentUser\My' }
        Mock Import-PfxCertificate { $script:existingSigningCertificate }

        $imported = Import-JarvisSigningCertificate -PfxPath $pfx -Password 'fixture-password'
        $imported.JarvisImportedByRun | Should Be $false
    }

    It 'removes only the exact requested thumbprint from the current user store' {
        $script:signingCertificates = @(
            [pscustomobject]@{ Thumbprint = 'ABC123'; PSPath = 'Cert:\CurrentUser\My\ABC123' },
            [pscustomobject]@{ Thumbprint = 'DEF456'; PSPath = 'Cert:\CurrentUser\My\DEF456' }
        )
        Mock Get-ChildItem { $script:signingCertificates } -ParameterFilter { $LiteralPath -eq 'Cert:\CurrentUser\My' }
        Mock Remove-Item { }

        (Remove-JarvisSigningCertificate -Thumbprint 'ab c123') | Should Be $true
        Assert-MockCalled Remove-Item -Scope It -Times 1 -Exactly -ParameterFilter {
            $LiteralPath -eq 'Cert:\CurrentUser\My\ABC123'
        }
        Assert-MockCalled Remove-Item -Scope It -Times 0 -Exactly -ParameterFilter {
            $LiteralPath -eq 'Cert:\CurrentUser\My\DEF456'
        }
    }
}

Describe 'release install teardown' {
    It 'throws with the scratch root when the uninstaller is still running after its timeout' {
        $root = Join-Path $TestDrive 'hung-uninstall'
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        'fixture' | Set-Content -LiteralPath (Join-Path $root 'uninstall.exe')
        Mock Start-Process { [pscustomobject]@{ HasExited = $false; ExitCode = $null } }
        Mock Wait-Process { }

        $message = ''
        try { Remove-JarvisReleaseInstall -InstallRoot $root -TimeoutSeconds 1 | Out-Null }
        catch { $message = $_.Exception.Message }
        $message | Should Match 'uninstall_timeout'
        $message | Should Match ([regex]::Escape($root))
    }

    It 'distinguishes a nonzero uninstaller exit code' {
        $root = Join-Path $TestDrive 'failed-uninstall'
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        'fixture' | Set-Content -LiteralPath (Join-Path $root 'uninstall.exe')
        Mock Start-Process { [pscustomobject]@{ HasExited = $true; ExitCode = 17 } }
        Mock Wait-Process { }

        { Remove-JarvisReleaseInstall -InstallRoot $root -TimeoutSeconds 1 } | Should Throw 'uninstall_failed:exit_17'
    }

    It 'returns true after a clean zero-exit uninstall' {
        $root = Join-Path $TestDrive 'clean-uninstall'
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        'fixture' | Set-Content -LiteralPath (Join-Path $root 'uninstall.exe')
        Mock Start-Process { [pscustomobject]@{ HasExited = $true; ExitCode = 0 } }
        Mock Wait-Process { }

        (Remove-JarvisReleaseInstall -InstallRoot $root -TimeoutSeconds 1) | Should Be $true
    }

    It 'keeps the missing-uninstaller false path' {
        $root = Join-Path $TestDrive 'missing-uninstaller'
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        (Remove-JarvisReleaseInstall -InstallRoot $root -TimeoutSeconds 1) | Should Be $false
    }

    It 'warns and still force-removes a scratch directory when uninstall throws' {
        $root = Join-Path $TestDrive 'throwing-uninstall'
        New-Item -ItemType Directory -Force -Path $root | Out-Null
        'owned scratch data' | Set-Content -LiteralPath (Join-Path $root 'sentinel.txt')
        Mock Remove-JarvisReleaseInstall { throw "uninstall_timeout:$InstallRoot" }

        Remove-JarvisReleaseScratchInstall -InstallRoot $root -WarningVariable warnings

        ($warnings -join "`n") | Should Match 'scratch uninstall failed'
        (Test-Path -LiteralPath $root) | Should Be $false
    }
}

Describe 'signing command arguments and timestamp validation' {
    It 'splits quoted command arguments and appends the installer path without evaluating text' {
        $fixtureDir = New-Item -ItemType Directory -Force -Path (Join-Path $TestDrive 'quoted signing command')
        $captureScript = Join-Path $fixtureDir.FullName 'capture arguments.ps1'
        $capturePath = Join-Path $fixtureDir.FullName 'captured.json'
        $installerPath = Join-Path $fixtureDir.FullName 'installer with spaces.exe'
        @'
param([string]$ServiceProfile, [string]$Marker, [string]$CapturePath, [string]$ArtifactPath)
[pscustomobject]@{ profile = $ServiceProfile; marker = $Marker; artifact = $ArtifactPath } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $CapturePath
exit 0
'@ | Set-Content -LiteralPath $captureScript
        'fabricated installer bytes' | Set-Content -LiteralPath $installerPath
        $powershellPath = (Get-Command powershell.exe).Source
        $command = '"{0}" -NoProfile -ExecutionPolicy Bypass -File "{1}" "provider profile with spaces" "$env:TEMP remains literal" "{2}"' -f `
            $powershellPath, $captureScript, $capturePath
        $configuration = [pscustomobject]@{ mode = 'command'; command = $command }
        Mock Get-JarvisAuthenticodeStatus {
            [pscustomobject]@{ status = 'Valid'; subject = 'fixture signer'; issuer = 'fixture issuer'; thumbprint = 'ABC123'; timestamp = 'fixture timestamp' }
        }

        $status = Invoke-JarvisInstallerSigning -InstallerPath $installerPath -Configuration $configuration

        $status.status | Should Be 'Valid'
        $received = Get-Content -Raw -LiteralPath $capturePath | ConvertFrom-Json
        $received.profile | Should Be 'provider profile with spaces'
        $received.marker | Should Be '$env:TEMP remains literal'
        $received.artifact | Should Be $installerPath
    }

    It 'rejects a signature without a timestamp after the signing command succeeds' {
        $fixtureDir = New-Item -ItemType Directory -Force -Path (Join-Path $TestDrive 'timestamp check')
        $exitScript = Join-Path $fixtureDir.FullName 'exit cleanly.ps1'
        $installerPath = Join-Path $fixtureDir.FullName 'unsigned fixture.exe'
        'exit 0' | Set-Content -LiteralPath $exitScript
        'fabricated installer bytes' | Set-Content -LiteralPath $installerPath
        $powershellPath = (Get-Command powershell.exe).Source
        $configuration = [pscustomobject]@{
            mode = 'command'
            command = '"{0}" -NoProfile -File "{1}"' -f $powershellPath, $exitScript
        }
        Mock Get-JarvisAuthenticodeStatus {
            [pscustomobject]@{ status = 'Valid'; subject = 'fixture signer'; issuer = 'fixture issuer'; thumbprint = 'ABC123'; timestamp = '' }
        }

        { Invoke-JarvisInstallerSigning -InstallerPath $installerPath -Configuration $configuration } |
            Should Throw 'signature_no_timestamp'
    }

    It 'checks a timestamp in VerifyOnly and removes temporary certificates in both CLI finally blocks' {
        $verifyScript = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'sign-installer.ps1')
        $verifyStart = $verifyScript.IndexOf('if ($VerifyOnly)')
        $verifyEnd = $verifyScript.IndexOf("`n`$importedCertificate = `$null", $verifyStart)
        $verifyBlock = $verifyScript.Substring($verifyStart, $verifyEnd - $verifyStart)
        $verifyBlock | Should Match ([regex]::Escape('Assert-JarvisSignatureTimestamp -Status $status'))

        foreach ($scriptName in @('release-build.ps1', 'sign-installer.ps1')) {
            $tokens = $null
            $parseErrors = $null
            $path = Join-Path $PSScriptRoot $scriptName
            $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$parseErrors)
            $parseErrors | Should BeNullOrEmpty
            $finallyBlocks = @($ast.FindAll({
                param($node)
                ($node -is [System.Management.Automation.Language.TryStatementAst]) -and ($null -ne $node.Finally)
            }, $true) | Where-Object {
                $_.Finally.Extent.Text.Contains('Remove-JarvisSigningCertificate') -and
                $_.Finally.Extent.Text.Contains('JarvisImportedByRun')
            })
            $finallyBlocks.Count | Should BeGreaterThan 0
        }
    }
}

Describe 'scratch install ownership' {
    BeforeEach {
        Mock Start-Process { throw 'installer_must_not_run_for_unsafe_root' }
    }

    It 'preserves an existing nonempty directory when refusing an install' {
        $root = Join-Path $TestDrive 'existing install'
        New-Item -ItemType Directory -Path $root | Out-Null
        $sentinel = Join-Path $root 'keep.txt'
        'user data' | Set-Content -LiteralPath $sentinel
        { Install-JarvisRelease -InstallerPath 'fake.exe' -InstallRoot $root } | Should Throw 'install_root_exists'
        (Get-Content -Raw -LiteralPath $sentinel).Trim() | Should Be 'user data'
    }

    It 'refuses a relative install root before creating or launching anything' {
        Mock New-Item { throw 'unexpected_directory_creation' }
        { Install-JarvisRelease -InstallerPath 'fake.exe' -InstallRoot 'relative-review-scratch' } | Should Throw 'install_root_not_absolute'
        Assert-MockCalled Start-Process -Scope It -Times 0 -Exactly
    }

    It 'refuses a directory outside the temporary scratch tree' {
        Mock New-Item { throw 'unexpected_directory_creation' }
        { Install-JarvisRelease -InstallerPath 'fake.exe' -InstallRoot 'C:\jarvis-review-must-not-create' } | Should Throw 'install_root_not_scratch'
        Assert-MockCalled Start-Process -Scope It -Times 0 -Exactly
    }
}

Describe 'cold-start listener ownership' {
    It 'refuses a busy port in the actual probe before creating an install' {
        $root = Join-Path $TestDrive 'probe-must-not-create'
        $runner = Join-Path $TestDrive 'probe-runner.ps1'
        @"
function global:Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 555 } }
function global:Start-Process { throw 'unexpected_probe_launch' }
& '$PSScriptRoot\probe-cold-start.ps1' -InstallerPath fake.exe -InstallRoot '$root'
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $runner
        $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
        $output | Should Match 'port_already_in_use'
        (Test-Path -LiteralPath $root) | Should Be $false
    }
    It 'rejects an existing listener before any probe side effects' {
        Mock Get-NetTCPConnection { [pscustomobject]@{ OwningProcess = 555; LocalPort = 19877; State = 'Listen' } }
        { Assert-JarvisPortAvailable -Port 19877 } | Should Throw 'port_already_in_use'
    }

    It 'does not stop an unrelated port listener during process cleanup' {
        $parent = [pscustomobject]@{ Id = 100; HasExited = $false; StartTime = [datetime]'2000-01-01T10:00:00Z' }
        Mock Get-CimInstance {
            @(
                [pscustomobject]@{ ProcessId = 101; ParentProcessId = 100; CreationDate = [datetime]'2000-01-01T10:00:01Z' },
                [pscustomobject]@{ ProcessId = 555; ParentProcessId = 9; CreationDate = [datetime]'2000-01-01T09:00:00Z' }
            )
        }
        Mock Stop-Process { }
        Stop-JarvisOwnedProcesses -Process $parent
        Assert-MockCalled Stop-Process -Scope It -Times 0 -Exactly -ParameterFilter { $Id -eq 555 }
        Assert-MockCalled Stop-Process -Scope It -Times 1 -Exactly -ParameterFilter { $Id -eq 101 }
        Assert-MockCalled Stop-Process -Scope It -Times 1 -Exactly -ParameterFilter { $Id -eq 100 }
    }

    It 'cleans proven descendants of an exited parent without touching a reused PID family' {
        $parent = [pscustomobject]@{
            Id = 100; HasExited = $true
            JarvisOwnedStartTime = [datetime]'2000-01-01T10:00:00Z'
            ExitTime = [datetime]'2000-01-01T10:00:10Z'
        }
        Mock Get-CimInstance {
            @(
                [pscustomobject]@{ ProcessId = 101; ParentProcessId = 100; CreationDate = [datetime]'2000-01-01T10:00:01Z' },
                [pscustomobject]@{ ProcessId = 102; ParentProcessId = 101; CreationDate = [datetime]'2000-01-01T10:00:02Z' },
                [pscustomobject]@{ ProcessId = 555; ParentProcessId = 100; CreationDate = [datetime]'2000-01-01T10:00:11Z' }
            )
        }
        Mock Stop-Process { }
        Stop-JarvisOwnedProcesses -Process $parent
        Assert-MockCalled Stop-Process -Scope It -Times 1 -Exactly -ParameterFilter { $Id -eq 101 }
        Assert-MockCalled Stop-Process -Scope It -Times 1 -Exactly -ParameterFilter { $Id -eq 102 }
        Assert-MockCalled Stop-Process -Scope It -Times 0 -Exactly -ParameterFilter { $Id -eq 555 -or $Id -eq 100 }
    }
}

Describe 'failed smoke teardown and body deadlines' {
    It 'removes its own scratch install when the installed binary check fails' {
        $root = Join-Path $TestDrive 'smoke-owned-install'
        $installer = Join-Path $TestDrive 'fake-installer.exe'
        'dummy installer bytes' | Set-Content -LiteralPath $installer
        $manifestPath = Join-Path $TestDrive 'smoke-record.json'
        @{
            schema = 'jarvis.release/1'; version = '1.0.0'; git_sha = ('a' * 40)
            files = @(
                @{ role = 'installer'; path = $installer; sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash },
                @{ role = 'app_binary'; path = 'app.exe'; sha256 = ('b' * 64) },
                @{ role = 'server_bundle'; path = 'index.js'; sha256 = ('c' * 64) }
            )
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath
        $runner = Join-Path $TestDrive 'smoke-runner.ps1'
        @"
function global:Get-NetTCPConnection { }
function global:Start-Process { [pscustomobject]@{ HasExited = `$true; ExitCode = 0 } }
function global:Wait-Process { }
& '$PSScriptRoot\release-smoke.ps1' -ManifestPath '$manifestPath' -InstallRoot '$root'
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $runner
        $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
        $LASTEXITCODE | Should Be 1
        $output | Should Match 'the install does not contain the binary'
        (Test-Path -LiteralPath $root) | Should Be $false
    }

    It 'times out an SSE body read even when headers have already arrived' {
        if (-not ('JarvisBlockedReader' -as [type])) {
            Add-Type @'
using System.IO;
using System.Threading.Tasks;
public class JarvisBlockedReader : StringReader {
    public JarvisBlockedReader() : base("") { }
    public override Task<string> ReadLineAsync() { return new TaskCompletionSource<string>().Task; }
}
'@
        }
        $reader = New-Object JarvisBlockedReader
        $started = [datetime]::UtcNow
        { Read-JarvisLineWithDeadline -Reader $reader -Deadline ([datetime]::UtcNow.AddMilliseconds(50)) } | Should Throw 'stream_body_timeout'
        ([datetime]::UtcNow - $started).TotalSeconds | Should BeLessThan 3
    }
}

Describe 'installer source provenance' {
    It 'rejects SkipTauriBuild before a stale installer can be relabelled' {
        $output = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'release-build.ps1') -SkipTauriBuild -RepoRoot (Join-Path $TestDrive 'nonexistent-repo') 2>&1 | Out-String
        $LASTEXITCODE | Should Be 1
        $output | Should Match 'skip_tauri_build_unsupported'
    }

    BeforeEach {
        $script:installRoot = Join-Path $TestDrive 'installed'
        New-Item -ItemType Directory -Force -Path (Join-Path $script:installRoot 'resources') | Out-Null
        $script:resourceNames = @{
            server_bundle = 'index.js'
            mcp_stdio = 'mcp-stdio-server.js'
            claude_proxy = 'resources\claude_cli_proxy.py'
            go_models = 'resources\opencode_go_openai_models.json'
        }
        $files = foreach ($role in $script:resourceNames.Keys) {
            $path = Join-Path $script:installRoot $script:resourceNames[$role]
            "$role expected bytes" | Set-Content -LiteralPath $path
            [pscustomobject]@{ role = $role; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
        }
        $script:manifest = [pscustomobject]@{ files = @($files) }
    }

    It 'accepts installed resources that match every recorded sidecar' {
        (Test-JarvisInstalledResources -InstallRoot $script:installRoot -Manifest $script:manifest).ok | Should Be $true
    }

    It 'rejects an installer that carries an old server beside a fresh staging bundle' {
        'old server bytes' | Set-Content -LiteralPath (Join-Path $script:installRoot 'index.js')
        $result = Test-JarvisInstalledResources -InstallRoot $script:installRoot -Manifest $script:manifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'installed_resource_mismatch:server_bundle'
    }

    It 'rejects an installer missing the MCP sidecar' {
        Remove-Item -LiteralPath (Join-Path $script:installRoot 'mcp-stdio-server.js')
        $result = Test-JarvisInstalledResources -InstallRoot $script:installRoot -Manifest $script:manifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'installed_resource_mismatch:mcp_stdio'
    }
}

Describe 'release publication source selection' {
    It 'targets the built SHA when a manual release tag does not exist yet' {
        $publication = Resolve-JarvisReleasePublication -Version '1.0.0' -BuildSha ('a' * 40)
        $publication.tag | Should Be 'v1.0.0'
        $publication.target | Should Be ('a' * 40)
    }

    It 'rejects an existing tag for another source commit' {
        { Resolve-JarvisReleasePublication -Version '1.0.0' -BuildSha ('a' * 40) -ExistingTagSha ('b' * 40) } | Should Throw 'release_tag_sha_mismatch'
    }

    It 'rejects a pushed tag whose version disagrees with the artifact version' {
        { Resolve-JarvisReleasePublication -Version '1.0.0' -BuildSha ('a' * 40) -RequestedTag 'v2.0.0' } | Should Throw 'release_tag_version_mismatch'
    }
}

Describe 'cold-start scratch cleanup when uninstall throws' {
    It 'removes the scratch install and keeps the probe exit code when uninstall throws' {
        $root = Join-Path $TestDrive 'probe-throwing-uninstall'
        $runner = Join-Path $TestDrive 'probe-throwing-uninstall-runner.ps1'
        @"
function global:Get-NetTCPConnection { }
function global:Start-Process {
    param(`$FilePath, `$ArgumentList, [switch]`$PassThru, `$WindowStyle, `$RedirectStandardOutput, `$RedirectStandardError, `$WorkingDirectory)
    `$installRoot = `$null
    if (`$ArgumentList) {
        foreach (`$a in @(`$ArgumentList)) {
            if (`$a -is [string] -and `$a -like '/D=*') { `$installRoot = `$a.Substring(3) }
        }
    }
    if (`$installRoot) {
        if (-not (Test-Path -LiteralPath `$installRoot)) { New-Item -ItemType Directory -Force -Path `$installRoot | Out-Null }
        'x' | Set-Content -LiteralPath (Join-Path `$installRoot 'uninstall.exe')
    }
    if (`$FilePath -like '*uninstall.exe') {
        return [pscustomobject]@{ HasExited = `$false; ExitCode = `$null; Id = 999; StartTime = [datetime]::Now }
    }
    return [pscustomobject]@{ HasExited = `$true; ExitCode = 0; Id = 123; StartTime = [datetime]::Now }
}
function global:Wait-Process { param(`$Timeout, [switch]`$ErrorAction) }
& '$PSScriptRoot\probe-cold-start.ps1' -InstallerPath 'fake.exe' -InstallRoot '$root'
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $runner
        $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
        $LASTEXITCODE | Should Be 1
        $output | Should Match 'installed app not found'
        $output | Should Match 'scratch uninstall failed'
        (Test-Path -LiteralPath $root) | Should Be $false
    }
}

Describe 'smoke scratch cleanup when uninstall throws' {
    It 'removes the scratch install and keeps the smoke exit code when uninstall throws' {
        $root = Join-Path $TestDrive 'smoke-throwing-uninstall'
        $installer = Join-Path $TestDrive 'throwing-uninstall-installer.exe'
        'dummy installer bytes' | Set-Content -LiteralPath $installer
        $manifestPath = Join-Path $TestDrive 'throwing-uninstall-record.json'
        @{
            schema = 'jarvis.release/1'; version = '1.0.0'; git_sha = ('a' * 40)
            files = @(
                @{ role = 'installer'; path = $installer; sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash },
                @{ role = 'app_binary'; path = 'app.exe'; sha256 = ('b' * 64) },
                @{ role = 'server_bundle'; path = 'index.js'; sha256 = ('c' * 64) }
            )
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath
        $runner = Join-Path $TestDrive 'smoke-throwing-uninstall-runner.ps1'
        @"
function global:Get-NetTCPConnection { }
function global:Start-Process {
    param(`$FilePath, `$ArgumentList, [switch]`$PassThru, `$WindowStyle, `$RedirectStandardOutput, `$RedirectStandardError, `$WorkingDirectory)
    `$installRoot = `$null
    if (`$ArgumentList) {
        foreach (`$a in @(`$ArgumentList)) {
            if (`$a -is [string] -and `$a -like '/D=*') { `$installRoot = `$a.Substring(3) }
        }
    }
    if (`$installRoot) {
        if (-not (Test-Path -LiteralPath `$installRoot)) { New-Item -ItemType Directory -Force -Path `$installRoot | Out-Null }
        'x' | Set-Content -LiteralPath (Join-Path `$installRoot 'uninstall.exe')
    }
    if (`$FilePath -like '*uninstall.exe') {
        return [pscustomobject]@{ HasExited = `$false; ExitCode = `$null; Id = 999; StartTime = [datetime]::Now }
    }
    return [pscustomobject]@{ HasExited = `$true; ExitCode = 0; Id = 123; StartTime = [datetime]::Now }
}
function global:Wait-Process { param(`$Timeout, [switch]`$ErrorAction) }
& '$PSScriptRoot\release-smoke.ps1' -ManifestPath '$manifestPath' -InstallRoot '$root' -SkipLaunch -SkipChat
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $runner
        $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $runner 2>&1 | Out-String
        $LASTEXITCODE | Should Be 1
        $output | Should Match 'does not contain the binary'
        $output | Should Match 'scratch uninstall failed'
        (Test-Path -LiteralPath $root) | Should Be $false
    }
}
