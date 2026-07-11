<#
.SYNOPSIS
    Runs a machine-readable smoke against the deployed Jarvis runtime.

.DESCRIPTION
    Verifies that the Desktop manifest, /health response, and process serving
    port 19877 agree before sending one direct /chat/stream request. The
    script emits one JSON object on stdout and fails closed on provenance or
    terminal-outcome mismatches.
#>
[CmdletBinding()]
param(
    [string]$DeployDir = "$env:USERPROFILE\OneDrive\Desktop",
    [string]$HealthUrl = "http://127.0.0.1:19877/health",
    [string]$StreamUrl = "http://127.0.0.1:19877/chat/stream",
    [string]$Prompt = "Reply with exactly: smoke ok.",
    [string]$SessionId = ([guid]::NewGuid().ToString()),
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

function Get-JsonFile([string]$Path) {
    if (-not (Test-Path $Path -PathType Leaf)) { throw "missing_file:$Path" }
    return (Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json)
}

function Get-ServingProcess([int]$Port) {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $connection) { throw "no_listener:$Port" }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
    if (-not $process) { throw "missing_process:$($connection.OwningProcess)" }
    return [ordered]@{
        pid = [int]$process.ProcessId
        name = [string]$process.Name
        command_line = [string]$process.CommandLine
    }
}

function Read-SseStream([string]$Url, [hashtable]$Body, [int]$Timeout) {
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($Timeout)
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Post,
            $Url
        )
        $json = $Body | ConvertTo-Json -Depth 8 -Compress
        $request.Content = [System.Net.Http.StringContent]::new(
            $json,
            [System.Text.Encoding]::UTF8,
            'application/json'
        )
        $response = $client.SendAsync(
            $request,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "stream_http_status:$([int]$response.StatusCode)"
        }

        $reader = [System.IO.StreamReader]::new(
            $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        )
        $events = [System.Collections.Generic.List[object]]::new()
        try {
            while (($line = $reader.ReadLine()) -ne $null) {
                if (-not $line.StartsWith('data: ')) { continue }
                $payload = $line.Substring(6).Trim()
                if (-not $payload -or $payload -eq '[DONE]') { continue }
                try { $events.Add(($payload | ConvertFrom-Json)) }
                catch { throw "malformed_sse_json:$payload" }
            }
        } finally {
            $reader.Dispose()
        }
        return $events.ToArray()
    } finally {
        $client.Dispose()
    }
}

$manifestPath = Join-Path $DeployDir '.jarvis-deploy-manifest.json'
$manifest = Get-JsonFile $manifestPath
$health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
$listener = Get-ServingProcess 19877

$expectedIndex = [IO.Path]::GetFullPath((Join-Path $DeployDir 'index.js'))
$commandLine = $listener.command_line
if ([string]::IsNullOrWhiteSpace($commandLine) -or
    $commandLine.IndexOf($expectedIndex, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    throw "listener_provenance_mismatch:expected=$expectedIndex actual=$commandLine"
}
if ([string]$manifest.git_sha -ne [string]$health.git_sha) {
    throw "health_manifest_sha_mismatch:manifest=$($manifest.git_sha) health=$($health.git_sha)"
}

# Release fixtures that do not require an inference provider. These guard the
# authority and observability contracts even when a live model key is expired.
$authorityCheck = [ordered]@{ status = 'unknown'; code = $null }
try {
    Invoke-WebRequest -Uri ($StreamUrl -replace '/chat/stream$', '/sessions') -Method Post `
        -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -UseBasicParsing | Out-Null
    $authorityCheck.status = 'unexpected_success'
} catch {
    $authorityCheck.code = [int]$_.Exception.Response.StatusCode
    $authorityCheck.status = if ($authorityCheck.code -eq 410) { 'pass' } else { 'fail' }
}
if ($authorityCheck.status -ne 'pass') { throw "session_authority_fixture_failed:$($authorityCheck.code)" }

$conductorHealth = Invoke-RestMethod -Uri ($HealthUrl -replace '/health$', '/health/conductor-directives') -TimeoutSec 5
$conductorCheck = [ordered]@{
    status = if ($null -ne $conductorHealth.records -and $null -ne $conductorHealth.by_type) { 'pass' } else { 'fail' }
    window_size = $conductorHealth.window_size
}
if ($conductorCheck.status -ne 'pass') { throw 'conductor_health_fixture_failed' }

$started = Get-Date
$events = Read-SseStream $StreamUrl @{
    message = $Prompt
    session_id = $SessionId
} $TimeoutSeconds
$elapsed = ((Get-Date) - $started).TotalMilliseconds

$terminal = @($events | Where-Object {
    $_.type -in @('result', 'error', 'cancelled')
})
if ($terminal.Count -ne 1) {
    throw "terminal_outcome_count:$($terminal.Count)"
}

$terminalEvent = $terminal[0]
$toolNames = @($events |
    Where-Object { $_.type -in @('tool_use', 'tool_result') -or ([string]$_.detail).StartsWith('tool:') } |
    ForEach-Object {
        if ($_.name) { [string]$_.name }
        elseif (([string]$_.detail).StartsWith('tool:')) { ([string]$_.detail).Substring(5) }
    } |
    Select-Object -Unique)
$fallbackNotices = @($events | Where-Object { $_.type -eq 'fallback_notice' } |
    ForEach-Object {
        [ordered]@{
            stage = [string]$_.stage
            reason = [string]$_.reason
            model = [string]$_.model
            source = [string]$_.source
        }
    })
$record = [ordered]@{
    manifest_sha = [string]$manifest.git_sha
    health_sha = [string]$health.git_sha
    listener_pid = $listener.pid
    listener_command = $listener.command_line
    session_id = $SessionId
    elapsed_ms = [math]::Round($elapsed)
    terminal_type = [string]$terminalEvent.type
    result_text = if ($null -ne $terminalEvent.result) { [string]$terminalEvent.result } else { [string]$terminalEvent.error }
    event_count = $events.Count
    tool_names = $toolNames
    fallback_notices = $fallbackNotices
    release_fixtures = [ordered]@{
        session_authority = $authorityCheck
        conductor_health = $conductorCheck
    }
}
$record | ConvertTo-Json -Depth 8 -Compress
