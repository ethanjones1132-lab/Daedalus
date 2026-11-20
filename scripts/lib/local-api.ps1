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

function Get-JarvisLaunchOutputTail {
    <#
    .SYNOPSIS
        The app's last output line, for a launch diagnostic.

    .DESCRIPTION
        The reader lives in lib/release-common.ps1, which release-smoke.ps1
        loads. The other scripts that load this file (build-and-deploy,
        verify-deploy, the runtime probes) do not, and a diagnostic path must
        not fail because of what it was going to say: they get a plain label
        instead of an error.
    #>
    param([string[]]$Path = @())
    if (Get-Command -Name 'Get-JarvisChildOutputTail' -CommandType Function -ErrorAction SilentlyContinue) {
        return Get-JarvisChildOutputTail -Path $Path
    }
    return '(no output captured)'
}

function Start-JarvisPrivateLaunch {
    <#
    .SYNOPSIS
        Start the installed app and read its launch credential from the pipe.

    .DESCRIPTION
        The launch holds two waits: the app opening its bootstrap pipe, and
        the credential line arriving on it. DD-126: both are bounded by a
        deadline. A named-pipe connect attempt that is never answered, or an
        app that opens the pipe and then says nothing, must fail the launch
        step with one line instead of holding the release gate open for as
        long as the app cares to live.

        The connect is retried in short slices rather than waited on once, so
        an app that exits without ever opening the pipe is reported as that,
        immediately, with its own last output line. The credential itself is
        never quoted in a diagnostic: it is the server's authorization token.
    #>
    param(
        [string]$AppPath,
        [string]$WorkingDirectory,
        [string]$StdoutPath,
        [string]$StderrPath,
        [ref]$Token,
        [int]$ConnectTimeoutMs = 10000,
        [int]$CredentialTimeoutMs = 5000
    )
    $id = [guid]::NewGuid().ToString('N')
    $outputPaths = @($StdoutPath, $StderrPath)
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

        # Bounded connect attempts: one deadline, checked in short slices so
        # an app that dies before connecting is not polled to the deadline.
        $connectDeadline = (Get-Date).AddMilliseconds([Math]::Max(0, $ConnectTimeoutMs))
        $connected = $false
        while (-not $connected) {
            $remainingMs = [int][Math]::Ceiling(($connectDeadline - (Get-Date)).TotalMilliseconds)
            if ($remainingMs -le 0) { break }
            $connected = $pending.AsyncWaitHandle.WaitOne([Math]::Min($remainingMs, 250))
            if (-not $connected -and $process.HasExited) {
                $tail = Get-JarvisLaunchOutputTail -Path $outputPaths
                throw "launch_failed:app_exited_before_pipe:$($process.ExitCode) (last output: ${tail})"
            }
        }
        if (-not $connected) {
            $tail = Get-JarvisLaunchOutputTail -Path $outputPaths
            throw "launch_timeout:pipe_connect after ${ConnectTimeoutMs}ms (last output: ${tail})"
        }
        $pipe.EndWaitForConnection($pending)
        $reader = [IO.StreamReader]::new($pipe)
        $line = $reader.ReadLineAsync()
        if (-not $line.Wait([Math]::Max(0, $CredentialTimeoutMs))) {
            $tail = Get-JarvisLaunchOutputTail -Path $outputPaths
            throw "launch_timeout:launch_credential after ${CredentialTimeoutMs}ms (last output: ${tail})"
        }
        $credential = $null
        try { $credential = $line.Result } catch { $credential = $null }
        if ($credential -notmatch '^[0-9a-f]{32}$') {
            # Never echo the value: it is the server's bearer token.
            throw 'Jarvis did not supply a valid launch credential'
        }
        $Token.Value = $credential
        return $process
    } catch {
        if ($process -and -not $process.HasExited) { $process.Kill() }
        throw
    } finally {
        if ($reader) { $reader.Dispose() }
        $pipe.Dispose()
    }
}
