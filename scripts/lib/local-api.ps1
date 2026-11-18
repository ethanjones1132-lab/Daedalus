# Credentials are scoped to the owned launch. Never place one in a URL,
# argument, log, or on disk.
function Get-JarvisLocalHeaders {
    param([uri]$Uri, [string]$Token = $env:JARVIS_SERVER_TOKEN)
    if ($Uri.Scheme -ne 'http' -or $Uri.Host -notin @('127.0.0.1', 'localhost', '[::1]') -or $Uri.UserInfo) {
        throw 'Jarvis credentials may only be sent to loopback HTTP'
    }
    if ([string]::IsNullOrWhiteSpace($Token)) { throw 'JARVIS_SERVER_TOKEN is required for this Bun server probe' }
    return @{ Authorization = "Bearer $Token" }
}

function New-JarvisLocalHttpClient {
    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.UseProxy = $false
    $handler.AllowAutoRedirect = $false
    return [System.Net.Http.HttpClient]::new($handler)
}

function Start-JarvisPrivateLaunch {
    param(
        [string]$AppPath,
        [string]$WorkingDirectory,
        [string]$StdoutPath,
        [string]$StderrPath,
        [ref]$Token
    )
    $id = [guid]::NewGuid().ToString('N')
    $pipe = [IO.Pipes.NamedPipeServerStream]::new("jarvis-bootstrap-$id",
        [IO.Pipes.PipeDirection]::In, 1, [IO.Pipes.PipeTransmissionMode]::Byte,
        [IO.Pipes.PipeOptions]::Asynchronous)
    $previous = $env:JARVIS_BOOTSTRAP_PIPE
    $process = $null
    $reader = $null
    try {
        $pending = $pipe.BeginWaitForConnection($null, $null)
        try {
            $env:JARVIS_BOOTSTRAP_PIPE = $id
            $process = Start-Process -FilePath $AppPath -WorkingDirectory $WorkingDirectory -PassThru `
                -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath
        } finally {
            $env:JARVIS_BOOTSTRAP_PIPE = $previous
        }
        if (-not $pending.AsyncWaitHandle.WaitOne(10000)) { throw 'Jarvis did not open the launch pipe' }
        $pipe.EndWaitForConnection($pending)
        $reader = [IO.StreamReader]::new($pipe)
        $line = $reader.ReadLineAsync()
        if (-not $line.Wait(5000) -or $line.Result -notmatch '^[0-9a-f]{32}$') {
            throw 'Jarvis did not supply a valid launch credential'
        }
        $Token.Value = $line.Result
        return $process
    } catch {
        if ($process -and -not $process.HasExited) { $process.Kill() }
        throw
    } finally {
        if ($reader) { $reader.Dispose() }
        $pipe.Dispose()
    }
}
