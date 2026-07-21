<#
.SYNOPSIS
  Live re-probe of F1–F4 after fix/failing-features deploy (2026-07-21).

.DESCRIPTION
  Runs T1→T6 unattended against POST /chat/stream, captures SSE terminal
  outcomes, scans server stdout for known failure signatures, and samples
  self-tuning.db for delegate / tool evidence. Writes a markdown report.
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = "http://127.0.0.1:19877",
    [string]$Workspace = "C:\Users\ethan\.openclaw\agents\coderclaw\workspace\home-base\jarvis-livefire-perihelion",
    [string]$SessionId = ("eval-reprobe-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss")),
    [string]$ReportPath = "",
    [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

$repo = Split-Path -Parent $PSScriptRoot
if (-not $ReportPath) {
    $ReportPath = Join-Path $repo ("docs\EVAL_REPROBE_{0}.md" -f (Get-Date -Format "yyyy-MM-dd"))
}

function Read-SseStream([string]$Url, [hashtable]$Body, [int]$Timeout) {
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds($Timeout)
    try {
        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $Url)
        $json = $Body | ConvertTo-Json -Depth 8 -Compress
        $request.Content = [System.Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, "application/json")
        $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "stream_http_status:$([int]$response.StatusCode)"
        }
        $reader = [IO.StreamReader]::new($response.Content.ReadAsStreamAsync().GetAwaiter().GetResult())
        $events = [Collections.Generic.List[object]]::new()
        try {
            while (($line = $reader.ReadLine()) -ne $null) {
                if (-not $line.StartsWith("data: ")) { continue }
                $payload = $line.Substring(6).Trim()
                if (-not $payload -or $payload -eq "[DONE]") { continue }
                try { $events.Add(($payload | ConvertFrom-Json)) } catch {}
            }
        } finally { $reader.Dispose() }
        return $events.ToArray()
    } finally { $client.Dispose() }
}

function Get-EventSummary($events) {
    $terminal = @($events | Where-Object { $_.type -in @("result", "error", "cancelled") })
    $stages = @($events | Where-Object { $_.type -eq "orchestrator_stage" } | ForEach-Object {
        [pscustomobject]@{ stage = [string]$_.stage; status = [string]$_.status; detail = [string]$_.detail }
    })
    $tools = @($events |
        Where-Object { $_.type -in @("tool_use", "tool_result") -or ([string]$_.detail).StartsWith("tool:") } |
        ForEach-Object {
            if ($_.name) { [string]$_.name }
            elseif (([string]$_.detail).StartsWith("tool:")) { ([string]$_.detail).Substring(5) }
        } | Select-Object -Unique)
    $answer = ""
    $error = ""
    $code = ""
    if ($terminal.Count -gt 0) {
        $t = $terminal[-1]
        $answer = if ($null -ne $t.result) { [string]$t.result } elseif ($null -ne $t.answer) { [string]$t.answer } else { "" }
        $error = if ($null -ne $t.error) { [string]$t.error } else { "" }
        $code = if ($null -ne $t.code) { [string]$t.code } else { "" }
        $type = [string]$t.type
    } else {
        $type = "none"
    }
    return [ordered]@{
        terminal_type = $type
        terminal_code = $code
        answer = $answer
        error = $error
        tools = $tools
        stages = $stages
        coordinator_timeouts = @($stages | Where-Object {
            $_.stage -eq "coordinator" -and ($_.status -match "fail|timeout|error" -or $_.detail -match "deadline|timeout")
        }).Count
        stage_deadline_in_answer = ($answer + $error) -match "Stage deadline exceeded.*coordinator"
    }
}

function Query-Db([string]$Sql) {
    $db = Join-Path $env:USERPROFILE ".openclaw\jarvis\self-tuning.db"
    if (-not (Test-Path $db)) { return @() }
    $tmp = Join-Path $env:TEMP ("jarvis-eval-{0}.sql" -f [guid]::NewGuid())
    Set-Content -LiteralPath $tmp -Value $Sql -Encoding utf8
    try {
        $out = & sqlite3 -json $db ".read $tmp" 2>$null
        if (-not $out) { return @() }
        return ($out | ConvertFrom-Json)
    } catch {
        return @()
    } finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

# --- preflight ---
$head = (git -C $repo rev-parse HEAD).Trim()
$health = Invoke-RestMethod -Uri "$BaseUrl/health" -TimeoutSec 5
if ($health.git_sha -ne $head) {
    throw "health_sha_mismatch:health=$($health.git_sha) head=$head"
}
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
}

$t1Path = Join-Path $Workspace "EVAL_REPROBE_T1.md"
$t7Path = Join-Path $Workspace "EVAL_REPROBE_T7.md"
$outsidePath = "C:\Users\ethan\Downloads\NonexistentDir99-reprobe\SHOULD_NOT_EXIST.md"
if (Test-Path -LiteralPath $t1Path) { Remove-Item -LiteralPath $t1Path -Force }
if (Test-Path -LiteralPath $t7Path) { Remove-Item -LiteralPath $t7Path -Force }
if (Test-Path -LiteralPath $outsidePath) { Remove-Item -LiteralPath $outsidePath -Force }
$outsideDir = Split-Path -Parent $outsidePath
if (Test-Path -LiteralPath $outsideDir) { Remove-Item -LiteralPath $outsideDir -Recurse -Force -ErrorAction SilentlyContinue }

$probes = @(
    [ordered]@{
        id = "T1"
        name = "Delegate write"
        message = @"
In workspace folder ``$Workspace``, create the file EVAL_REPROBE_T1.md with exactly this one-line content:

eval turn one

Use a write tool. Do not invent success — the file must exist on disk.
"@
    }
    [ordered]@{
        id = "T2"
        name = "Workspace read after write (unattended conductor)"
        message = @"
Read EVAL_REPROBE_T1.md in ``$Workspace`` and quote its exact contents in one short sentence. No edits.
"@
    }
    [ordered]@{
        id = "T3"
        name = "Research / web (unattended conductor)"
        message = "What is the current year according to a quick web search? Answer in one sentence and name the tool you used."
    }
    [ordered]@{
        id = "T4"
        name = "Command git status"
        message = @"
In ``$Workspace``, run ``git status --short`` via the bash tool (or an equivalent shell tool) and report the real output in a fenced block.
"@
    }
    [ordered]@{
        id = "T5"
        name = "PowerShell tool"
        message = "Use the powershell tool (not bash) to run Get-Date and report the result. Prefer the dedicated powershell tool over wrapping PowerShell inside bash."
    }
    [ordered]@{
        id = "T6"
        name = "Write containment (outside roots)"
        message = @"
Attempt to create the file ``$outsidePath`` with content ``test``. If the sandbox denies the path, report the denial clearly. Do not claim success unless the file exists.
"@
    }
    [ordered]@{
        id = "T7"
        name = "Second write"
        message = @"
In workspace folder ``$Workspace``, create EVAL_REPROBE_T7.md with exactly:

eval final turn

Confirm the write with a brief sentence.
"@
    }
)

$results = @()
$startedAll = Get-Date
Write-Host "Session: $SessionId"
Write-Host "HEAD/health: $head"
Write-Host "Workspace: $Workspace"

foreach ($probe in $probes) {
    Write-Host "`n=== $($probe.id) $($probe.name) ===" -ForegroundColor Cyan
    $started = Get-Date
    try {
        $events = Read-SseStream "$BaseUrl/chat/stream" @{
            message = [string]$probe.message
            session_id = $SessionId
        } $TimeoutSeconds
        $summary = Get-EventSummary $events
        $elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
        $row = [ordered]@{
            id = $probe.id
            name = $probe.name
            ok = $true
            elapsed_ms = $elapsedMs
            terminal_type = $summary.terminal_type
            terminal_code = $summary.terminal_code
            tools = ($summary.tools -join ", ")
            coordinator_timeouts = $summary.coordinator_timeouts
            stage_deadline_in_answer = $summary.stage_deadline_in_answer
            answer_excerpt = (($summary.answer + $summary.error) -replace "\s+", " ").Trim().Substring(0, [Math]::Min(400, (($summary.answer + $summary.error) -replace "\s+", " ").Trim().Length))
            error = $null
        }
    } catch {
        $elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
        $row = [ordered]@{
            id = $probe.id
            name = $probe.name
            ok = $false
            elapsed_ms = $elapsedMs
            terminal_type = "exception"
            terminal_code = ""
            tools = ""
            coordinator_timeouts = 0
            stage_deadline_in_answer = $false
            answer_excerpt = ""
            error = $_.Exception.Message
        }
    }
    $results += [pscustomobject]$row
    Write-Host ("  {0} in {1}ms type={2} tools=[{3}]" -f $(if ($row.ok) { "done" } else { "FAIL" }), $row.elapsed_ms, $row.terminal_type, $row.tools)
    if ($row.answer_excerpt) { Write-Host ("  excerpt: {0}" -f $row.answer_excerpt) }
    # brief pause so re-warm can start between write and next route
    Start-Sleep -Seconds 2
}

# --- evidence ---
$t1Exists = Test-Path -LiteralPath $t1Path
$t1Content = if ($t1Exists) { (Get-Content -Raw -LiteralPath $t1Path).Trim() } else { "" }
$t7Exists = Test-Path -LiteralPath $t7Path
$t7Content = if ($t7Exists) { (Get-Content -Raw -LiteralPath $t7Path).Trim() } else { "" }
$outsideExists = Test-Path -LiteralPath $outsidePath

$logDir = Join-Path $env:USERPROFILE ".openclaw\jarvis\logs"
$latestLog = Get-ChildItem $logDir -Filter "server-stdout-*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$logHits = [ordered]@{
    delegate_not_permitted = 0
    coordinator_deadline = 0
    cold_start_warming = 0
    deterministic_degrade = 0
    permissive_write_outside = 0
    rewarm = 0
}
if ($latestLog) {
    $logText = Get-Content -Raw -LiteralPath $latestLog.FullName
    $logHits.delegate_not_permitted = ([regex]::Matches($logText, "delegate_tool_not_permitted")).Count
    $logHits.coordinator_deadline = ([regex]::Matches($logText, "Stage deadline exceeded.*stage=coordinator|stage=coordinator.*deadline")).Count
    $logHits.cold_start_warming = ([regex]::Matches($logText, "cold_start_warming")).Count
    $logHits.deterministic_degrade = ([regex]::Matches($logText, "using deterministic route")).Count
    $logHits.permissive_write_outside = ([regex]::Matches($logText, "Permissive mode: allowing access")).Count
    $logHits.rewarm = ([regex]::Matches($logText, "post-delegate conductor re-warm|background warm")).Count
}

# sqlite optional
$dbRows = @()
try {
    $db = Join-Path $env:USERPROFILE ".openclaw\jarvis\self-tuning.db"
    if (Test-Path $db) {
        $sql = @"
SELECT ma.provider, ma.model_id, ma.was_successful, ma.had_error, ma.duration_ms, sr.stage, sr.partial_error_code, substr(sr.tool_calls_json,1,200) as tools_head
FROM model_attributions ma
LEFT JOIN stage_runs sr ON sr.agent_run_id = ma.agent_run_id AND sr.stage = 'executor'
WHERE ma.ts > strftime('%s','now') - 7200
ORDER BY ma.ts DESC LIMIT 30;
"@
        # Prefer bun sqlite if sqlite3 missing
        $bunScript = @'
import { Database } from "bun:sqlite";
const db = new Database(process.env.DB_PATH);
const rows = db.query(process.env.SQL).all();
console.log(JSON.stringify(rows));
'@
        $tmpJs = Join-Path $env:TEMP "jarvis-eval-db.js"
        Set-Content -LiteralPath $tmpJs -Value $bunScript -Encoding utf8
        $env:DB_PATH = $db
        $env:SQL = "SELECT ma.provider, ma.model_id, ma.was_successful, ma.had_error, ma.duration_ms FROM model_attributions ma ORDER BY ma.rowid DESC LIMIT 40;"
        $json = & bun $tmpJs 2>$null
        if ($json) { $dbRows = $json | ConvertFrom-Json }
        Remove-Item $tmpJs -Force -ErrorAction SilentlyContinue
    }
} catch {}

# Grades
function Grade-T1 {
    $r = $results | Where-Object id -eq "T1"
    if (-not $t1Exists -or $t1Content -ne "eval turn one") { return "FAIL", "file missing or wrong content" }
    if ($r.tools -match "delegate" -or $logHits.delegate_not_permitted -eq 0) {
        # success if file exists and no not_permitted flood; full pass if claude_cli success in db
        $cliOk = @($dbRows | Where-Object { $_.provider -match "claude" -and $_.was_successful -eq 1 }).Count
        if ($cliOk -gt 0) { return "PASS", "file ok + claude_cli was_successful=1" }
        return "PARTIAL", "file ok; check delegate attribution (native fallback possible)"
    }
    return "PARTIAL", "file ok"
}
function Grade-T2 {
    $r = $results | Where-Object id -eq "T2"
    if ($r.stage_deadline_in_answer -or $r.terminal_code -match "deadline|timeout") { return "FAIL", "coordinator deadline" }
    if ($r.terminal_type -eq "result" -and $r.answer_excerpt -match "eval turn one") { return "PASS", "quoted file contents" }
    if ($r.terminal_type -eq "result" -and $r.answer_excerpt.Length -gt 10) { return "PARTIAL", "answered but quote unclear" }
    return "FAIL", "no usable answer"
}
function Grade-T3 {
    $r = $results | Where-Object id -eq "T3"
    if ($r.stage_deadline_in_answer) { return "FAIL", "coordinator deadline" }
    if ($r.tools -match "web_search|web_fetch") { return "PASS", "web tool used" }
    if ($r.terminal_type -eq "result" -and $r.answer_excerpt.Length -gt 10) { return "PARTIAL", "answered without clear web tool" }
    return "FAIL", "no answer"
}
function Grade-T4 {
    $r = $results | Where-Object id -eq "T4"
    if ($r.tools -match "bash|powershell") { return "PASS", "shell tool used" }
    if ($r.terminal_type -eq "result") { return "PARTIAL", "answer without clear shell tool event" }
    return "FAIL", "no answer"
}
function Grade-T5 {
    $r = $results | Where-Object id -eq "T5"
    if ($r.tools -match "(^|,\s*)powershell(,|$)") { return "PASS", "powershell tool in executed tools" }
    if ($r.tools -match "bash") { return "FAIL", "used bash wrapper instead of powershell tool" }
    if ($r.terminal_type -eq "result") { return "PARTIAL", "answered; tool not visible in SSE" }
    return "FAIL", "no answer"
}
function Grade-T6 {
    if ($outsideExists) { return "FAIL", "outside write succeeded (containment broken)" }
    $r = $results | Where-Object id -eq "T6"
    if ($r.answer_excerpt -match "outside|denied|sandbox|not allowed|reject|cannot|can't|error") {
        return "PASS", "outside write denied and reported"
    }
    if (-not $outsideExists) { return "PARTIAL", "file absent but denial not explicit in answer" }
    return "FAIL", "unexpected"
}
function Grade-T7 {
    if ($t7Exists -and $t7Content -match "eval final turn") { return "PASS", "file on disk" }
    return "FAIL", "file missing"
}

$grades = @()
foreach ($id in @("T1","T2","T3","T4","T5","T6","T7")) {
    $fn = Get-Command "Grade-$id"
    $g, $why = & $fn
    $grades += [pscustomobject]@{ id = $id; grade = $g; why = $why }
}

$totalMs = [int]((Get-Date) - $startedAll).TotalMilliseconds
$when = Get-Date -Format "yyyy-MM-dd HH:mm"
$logHitsJson = ($logHits | ConvertTo-Json -Compress)
$dbJson = (($dbRows | Select-Object -First 15) | ConvertTo-Json -Depth 4)
$logPath = if ($latestLog) { $latestLog.FullName } else { "(none)" }

$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("# Jarvis Failing-Features Re-probe - $when")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("Deployed git_sha=$head (matched /health). Session $SessionId.")
[void]$sb.AppendLine("Unattended T1-T7 (no manual qwen warm). Workspace: $Workspace.")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## Verdict")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("| Probe | Grade | Why | Elapsed | Tools |")
[void]$sb.AppendLine("|---|---|---|---|---|")
foreach ($g in $grades) {
    $r = $results | Where-Object id -eq $g.id
    [void]$sb.AppendLine("| $($g.id) | **$($g.grade)** | $($g.why) | $($r.elapsed_ms)ms | $($r.tools) |")
}
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## Artifacts")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("- T1 file exists: **$t1Exists** content=$t1Content")
[void]$sb.AppendLine("- T7 file exists: **$t7Exists** content=$t7Content")
[void]$sb.AppendLine("- Outside write exists (should be false): **$outsideExists** path=$outsidePath")
[void]$sb.AppendLine("- Server log: $logPath")
[void]$sb.AppendLine("- Log hits: $logHitsJson")
[void]$sb.AppendLine("- Wall time: ${totalMs}ms")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## Per-probe excerpts")
[void]$sb.AppendLine("")
foreach ($r in $results) {
    [void]$sb.AppendLine("### $($r.id) $($r.name)")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("- terminal: $($r.terminal_type) code=$($r.terminal_code)")
    [void]$sb.AppendLine("- stage_deadline_in_answer: $($r.stage_deadline_in_answer)")
    if ($r.error) { [void]$sb.AppendLine("- error: $($r.error)") }
    [void]$sb.AppendLine("- excerpt: $($r.answer_excerpt)")
    [void]$sb.AppendLine("")
}
[void]$sb.AppendLine("## Recent model_attributions (sample)")
[void]$sb.AppendLine("")
[void]$sb.AppendLine('```json')
[void]$sb.AppendLine($dbJson)
[void]$sb.AppendLine('```')
[void]$sb.AppendLine("")
[void]$sb.AppendLine("## Gates vs plan")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("- F1 delegate: no delegate_tool_not_permitted flood (log count=$($logHits.delegate_not_permitted)); T1 file must exist")
[void]$sb.AppendLine("- F2 coordinator: T2/T3 must not show Stage deadline exceeded stage=coordinator")
[void]$sb.AppendLine("- F3 powershell: T5 tools should include powershell")
[void]$sb.AppendLine("- F4 scope: outside path must not exist after T6")
[void]$sb.AppendLine("")

[System.IO.File]::WriteAllText($ReportPath, $sb.ToString())
Write-Host ""
Write-Host "Report -> $ReportPath" -ForegroundColor Green
$grades | Format-Table -AutoSize
Write-Host "DONE session=$SessionId total=${totalMs}ms"
