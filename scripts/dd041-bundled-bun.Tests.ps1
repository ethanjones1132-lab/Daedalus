# dd041-bundled-bun.Tests.ps1 - the installer carries the Bun runtime, without
# making every cargo build depend on a release-only file.
#
# The packaged app starts its server with a bun.exe beside the exe
# (find_bun_executable checks that directory first). The installer therefore
# has to carry one. But tauri-build resolves and copies every
# bundle.resources entry on every cargo build, release or not, so
# src-tauri/tauri.conf.json must not name a source that only the release
# build creates: a committed `target/release/bun.exe` entry breaks
# `cargo check`/`cargo test` on any fresh checkout.
#
# The release build therefore stages the build machine's Bun and merges the
# resource in for its own `cargo tauri build` only. These tests pin both
# halves: the committed config stays clean, and the release path stages,
# merges, records and verifies the runtime.
#
# Written for Pester 3.4 (Should Be / Should Throw / -EnableExit), the version
# scripts/run-release-tests.ps1 pins.

$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'lib\release-common.ps1')

$configurationPath = Join-Path $repoRoot 'src-tauri\tauri.conf.json'
$releaseBuildPath = Join-Path $PSScriptRoot 'release-build.ps1'

function Get-ReleaseBuildAst {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($releaseBuildPath, [ref]$tokens, [ref]$errors)
    if ($errors -and @($errors).Count -gt 0) {
        throw "release_build_parse_error:$(@($errors)[0].Message)"
    }
    return $ast
}

function Get-ReleaseBuildCommands {
    $ast = Get-ReleaseBuildAst
    return @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))
}

# The `cargo tauri build` invocation, found structurally rather than by text:
# the script also has a `Die "cargo tauri build failed..."` message, and a
# text search would count that as a second build.
function Get-TauriBuildCommand {
    return @(Get-ReleaseBuildCommands | Where-Object {
        $words = @($_.CommandElements | ForEach-Object {
            if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value }
        })
        ($words -contains 'tauri') -and ($words -contains 'build')
    })
}

# A bundle.resources source that only a release step produces: inside the cargo
# target tree, or an absolute path that is not part of the checkout at all.
# Such a source is absent on a fresh checkout, so tauri-build fails the very
# first `cargo check`.
function Get-ReleaseOnlyResourceSource {
    param($Resources)
    if ($null -eq $Resources) { return @() }
    $names = @($Resources.PSObject.Properties | ForEach-Object { $_.Name })
    return @($names | Where-Object {
        $_ -match '(^|[\\/])target([\\/]|$)' -or
        $_ -match '^[A-Za-z]:' -or
        $_ -match '^\\\\' -or
        $_ -match '^/'
    })
}

Describe 'the committed Tauri config never names a release-only resource' {
    It 'names no bundle.resources source that only a release step creates' {
        $config = Get-Content -Raw -LiteralPath $configurationPath | ConvertFrom-Json
        @($config.bundle.resources.PSObject.Properties.Name).Count | Should BeGreaterThan 0
        $offenders = Get-ReleaseOnlyResourceSource -Resources $config.bundle.resources
        ($offenders -join ', ') | Should Be ''
    }

    It 'would fail a config that names the staged target/release/bun.exe' {
        # The entry the released patch put in the committed config: prove the
        # check above actually catches it rather than passing vacuously.
        $synthetic = '{"bundle":{"resources":{"target/release/bun.exe":"bun.exe"}}}' | ConvertFrom-Json
        $offenders = @(Get-ReleaseOnlyResourceSource -Resources $synthetic.bundle.resources)
        $offenders.Count | Should Be 1
        $offenders[0] | Should Be 'target/release/bun.exe'
    }

    It 'would fail a config that names a source outside the checkout' {
        $synthetic = '{"bundle":{"resources":{"C:\\Users\\builder\\.bun\\bin\\bun.exe":"bun.exe"}}}' | ConvertFrom-Json
        @(Get-ReleaseOnlyResourceSource -Resources $synthetic.bundle.resources).Count | Should Be 1
    }
}

Describe 'the release build merges the bundled Bun into the bundler config' {
    It 'adds exactly one extra resource, installed beside the app binary' {
        $merge = Get-JarvisBundledBunConfigMerge
        $merge.bundle.resources['target/release/bun.exe'] | Should Be 'bun.exe'
        @($merge.bundle.resources.Keys).Count | Should Be 1
    }

    It 'serialises to a JSON merge the Tauri CLI can apply' {
        $json = Get-JarvisBundledBunConfigMerge | ConvertTo-Json -Depth 5
        $parsed = $json | ConvertFrom-Json
        $parsed.bundle.resources.'target/release/bun.exe' | Should Be 'bun.exe'
    }

    It 'hands the merge to cargo tauri build through --config' {
        # An externally set TAURI_CONFIG reaches tauri-build but NOT the
        # bundler (tauri-cli only merges the configs it is given), so the
        # extra resource has to go through --config to get into the installer.
        $source = Get-Content -Raw -LiteralPath $releaseBuildPath
        $source | Should Match 'Get-JarvisBundledBunConfigMerge'
        $source | Should Match 'jarvis-bundled-bun\.json'
        $tauriBuild = @(Get-TauriBuildCommand)
        $tauriBuild.Count | Should Be 1
        $tauriBuild[0].Extent.Text | Should Match '--config'
        $tauriBuild[0].Extent.Text | Should Match '\$bundledBunConfigPath'
    }

    It 'never rewrites the committed tauri.conf.json' {
        $commands = Get-ReleaseBuildCommands
        @($commands | Where-Object { $_.Extent.Text -match 'tauri\.conf\.json' }).Count | Should Be 0
    }
}

Describe 'the build machine Bun is staged before cargo tauri build' {
    It 'copies the staged Bun where the merged resource source resolves' {
        $source = Join-Path $TestDrive 'stage-source\bun.exe'
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $source) | Out-Null
        'fixture bun bytes' | Set-Content -LiteralPath $source
        $destination = Join-Path $TestDrive 'stage-target\release\bun.exe'

        Stage-JarvisBundledBun -SourcePath $source -DestinationPath $destination | Should Be $destination

        (Get-Content -Raw -LiteralPath $destination) | Should Match 'fixture bun bytes'
    }

    It 'fails the release build when the build machine has no Bun' {
        $missing = Join-Path $TestDrive 'no-bun-here\bin\bun.exe'
        $destination = Join-Path $TestDrive 'unstaged-target\release\bun.exe'
        { Stage-JarvisBundledBun -SourcePath $missing -DestinationPath $destination } |
            Should Throw 'bundled_bun_source_missing'
        (Test-Path -LiteralPath $destination) | Should Be $false
    }

    It 'stages from the build user profile before the tauri build runs' {
        $commands = Get-ReleaseBuildCommands
        $staging = @($commands | Where-Object { $_.Extent.Text -match 'Stage-JarvisBundledBun' })
        $staging.Count | Should Be 1
        $staging[0].Extent.Text | Should Match '\$env:USERPROFILE'
        $staging[0].Extent.Text | Should Match '\.bun\\bin\\bun\.exe'

        # The merge points at this path (src-tauri-relative target/release),
        # so the staged copy and the resource source cannot drift apart.
        $source = Get-Content -Raw -LiteralPath $releaseBuildPath
        $source | Should Match 'src-tauri\\target\\release\\bun\.exe'

        $tauriBuild = @(Get-TauriBuildCommand)[0]
        $staging[0].Extent.StartOffset | Should BeLessThan $tauriBuild.Extent.StartOffset
    }
}

Describe 'the release record and the install verification carry the Bun' {
    BeforeEach {
        $script:installRoot = Join-Path $TestDrive 'installed'
        New-Item -ItemType Directory -Force -Path (Join-Path $script:installRoot 'resources') | Out-Null
        $script:resourceNames = [ordered]@{
            server_bundle = 'index.js'
            mcp_stdio     = 'mcp-stdio-server.js'
            claude_proxy  = 'resources\claude_cli_proxy.py'
            go_models     = 'resources\opencode_go_openai_models.json'
            bundled_bun   = 'bun.exe'
        }
        $files = foreach ($role in $script:resourceNames.Keys) {
            $path = Join-Path $script:installRoot $script:resourceNames[$role]
            "$role expected bytes" | Set-Content -LiteralPath $path
            [pscustomobject]@{ role = $role; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
        }
        $script:manifest = [pscustomobject]@{ files = @($files) }
    }

    It 'stages the Bun into the release tree under the bundled_bun role' {
        $commands = Get-ReleaseBuildCommands
        $copies = @($commands | Where-Object {
            $_.Extent.Text -match '(?i)^\s*Copy-Item' -and $_.Extent.Text -match 'bun\.exe'
        })
        $copies.Count | Should Be 1
        $copies[0].Extent.Text | Should Match '\$versionDir'

        $source = Get-Content -Raw -LiteralPath $releaseBuildPath
        $source | Should Match "role\s*=\s*'bundled_bun'"
    }

    It 'accepts an install that carries the recorded Bun' {
        (Test-JarvisInstalledResources -InstallRoot $script:installRoot -Manifest $script:manifest).ok | Should Be $true
    }

    It 'rejects a record with no bundled_bun entry' {
        $script:manifest.files = @($script:manifest.files | Where-Object { $_.role -ne 'bundled_bun' })
        $result = Test-JarvisInstalledResources -InstallRoot $script:installRoot -Manifest $script:manifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'installed_resource_record_missing:bundled_bun'
    }

    It 'rejects an install whose Bun does not match the record' {
        'a different bun' | Set-Content -LiteralPath (Join-Path $script:installRoot 'bun.exe')
        $result = Test-JarvisInstalledResources -InstallRoot $script:installRoot -Manifest $script:manifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'installed_resource_mismatch:bundled_bun'
    }

    It 'rejects an install that has no Bun at all' {
        Remove-Item -LiteralPath (Join-Path $script:installRoot 'bun.exe')
        $result = Test-JarvisInstalledResources -InstallRoot $script:installRoot -Manifest $script:manifest
        $result.ok | Should Be $false
        $result.reason | Should Match 'installed_resource_mismatch:bundled_bun'
    }
}
