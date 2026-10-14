# Brief template

Fill in the slots; keep each one short. A worker starts cold, so it knows only what is written here and in the files it is pointed at.

```
GOAL: <one sentence: the outcome, not the steps>
CONTEXT: <why; the cause if known, with file:line evidence>
IN SCOPE: <files or globs this worker may change>
OUT OF SCOPE: <files not to touch>; no skipped/disabled tests; no weakened assertions
CHANGE: <the intended change, if you already know it>
CHECK: <the exact command(s) and the expected result that prove it worked>
STOP IF: <the conditions where it should stop and report instead of improvising>
REPORT: STATUS done|blocked|partial; files changed; `git diff --stat`; the CHECK output; anything unsure; ≤150 words
```

## Plan file (for Opus gate 1)

```
REQUEST: <the user's words, verbatim>
CONSTRAINTS: <what must not change or regress>
FINDINGS: <the facts behind the plan, each with file:line or command-output evidence>
PLAN: <milestones in order; for each: who does it, the files, the CHECK>
RISKS: <what could go wrong, and how each would be caught>
OPEN QUESTIONS: <what you're unsure about and want Opus to rule on>
```

## Review request (Grok or Sol)

```
Review this diff for correctness against the request. Look for regressions, missed requirements, edge cases, and weakened tests.
REQUEST: <verbatim>
DIFF: <path to the patch file, or the git range>
CONTEXT FILES: <the touched files only>
OUTPUT: numbered findings, each with severity (blocking/minor), file:line, why, and a suggested fix. Say "no blocking findings" if that's the case.
```
