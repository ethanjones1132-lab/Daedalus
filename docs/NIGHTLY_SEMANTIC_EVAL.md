# Nightly semantic evaluation

The live semantic harness is opt-in because it calls real model providers. The
nightly wrapper records every report under:

`%USERPROFILE%\.openclaw\jarvis\eval\semantic\`

It writes `latest.json`, one immutable file under `runs/`, and an alert artifact
under `alerts/` when the baseline is missing, unreadable, or regresses.

Run it from the repository with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-nightly-semantic-eval.ps1
```

The process exits `0` only when the report passes the existing
`semantic-baseline.json` regression band. A non-zero exit is the scheduler alert
signal. The wrapper never rewrites the baseline; updating that file remains an
intentional operator action after reviewing a report.

For Windows Task Scheduler, use the script above as the action and schedule it
once per night after the machine's model/provider services are available. For
Hermes or another cron runner, invoke the same script and retain stdout/stderr
plus the JSON artifacts as the run record.
