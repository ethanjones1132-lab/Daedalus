# Nightly semantic evaluation

The live semantic harness is opt-in because it calls real model providers. The
nightly wrapper records every report under:

`%USERPROFILE%\.openclaw\jarvis\eval\semantic\`

It writes `latest.json`, one immutable file under `runs/`, and an alert artifact
under `alerts/` when the baseline is missing, unreadable, or regresses.

The wrapper is dry-run by default; running it bare prints what it would do and
exits `0` without touching any model provider:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-nightly-semantic-eval.ps1
```

The live run is opt-in and passes `-Live`, which sets `JARVIS_EVAL_LIVE=1` for
the harness's own guard and calls real model providers:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-nightly-semantic-eval.ps1 -Live
```

The process exits `0` only when the report passes the existing
`semantic-baseline.json` regression band. A non-zero exit is the scheduler alert
signal. The wrapper never rewrites the baseline; updating that file remains an
intentional operator action after reviewing a report.

Nothing schedules the nightly eval by default. To opt in on this machine, run
`scripts/install-nightly-semantic-eval-task.ps1 -Register` from the repository:
it registers a daily Windows scheduled task named `Jarvis Nightly Semantic Eval`
that runs the wrapper with `-Live` once per night (03:00 local by default, after
the machine's model/provider services are expected to be available). Running
that installer without `-Register` is a dry run that prints the task name,
schedule, and executable it would register and writes nothing, and `-WhatIf`
previews a `-Register` or `-Uninstall` the same way. To opt back out, run the
installer with `-Uninstall`, which removes the task. For Hermes or another cron
runner, invoke the wrapper with `-Live` and retain stdout/stderr plus the JSON
artifacts as the run record.
