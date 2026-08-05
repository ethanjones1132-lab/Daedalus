# Build Gate + Live-Fire Report — 2026-08-05

Covers the verification-gate work and the two live-fire attempts to have Jarvis
fix real compile errors. Evidence: `~/.openclaw/jarvis/self-tuning.db`,
`C:\Users\ethan\Downloads\Perihelion`, and the running server's own log.

**Bottom line:** the gate shipped and works. The runtime did not fix the errors —
it wrote nothing in either attempt. But it also never claimed it had, and that
is new. The blocking problem is no longer honesty or supervision; it is that the
capable delegate model never executed, both times, for an infrastructure reason
that is still unexplained.

---

## 1. What shipped

| Commit | Change |
|---|---|
| `06caafb` | Completion gated on landed writes, not the contract flag; VS-bundled cmake resolution; error-preferring build-failure extraction |
| `4ec2062` | Delegate ground-truth snapshot excludes build/output directories |

2750 tests pass, `tsc --noEmit` clean.

### 1.1 The gate defect

`decideCompletion` demanded an authoritative check only when the task-run's
sticky `writeIntent` was true — the same flag that goes false when a
continuation mints a fresh contract. A turn that wrote 21 files and never
compiled fell through to `non_write_complete` and was eligible to persist as
success with `check_tier="none"`. That is the `success_without_runtime_check`
class: 93 violations, the largest in the replay harness.

Verification is now required on evidence or requirement:

```ts
requiresVerification = writeIntent || wroteCode || requirement === "full_execution"
```

`wroteCode` = a write-effect tool call actually landed. A contract can be lost;
a landed write cannot be argued with.

### 1.2 Two defects found only by running it

- **`cmake` was unreachable.** Visual Studio ships CMake but keeps it off PATH.
  The detector emitted bare `cmake`, ENOENT'd, and the whole C++ gate degraded
  to an "honest none". Perihelion had a fully configured `build/` and still
  could not be checked.
- **The failure detail omitted the failure.** `tailDetail` returned the last 8
  lines of `stderr || stdout`. MSVC writes *errors* to stdout and *warnings* to
  stderr, so `||` selected stderr and the detail came back as a trailing C4530
  warning with every real error discarded. This would have made the whole
  live-fire exercise meaningless.

Verified end-to-end against the real tree: the gate runs
`cmake --build C:\Users\ethan\Downloads\Perihelion\build`, returns
`kind: failed`, and hands back the actual `C2039: 'isnan': is not a member of
'juce'` lines.

---

## 2. Live-fire: two attempts, zero writes

Both turns were the same prompt — the 16 real compile errors plus the specific
API corrections (`std::isnan`, `AudioProcessorParameterWithID`, the
`ValueSmoothingTypes::Multiplicative` template parameter, no such enum as
`notch`, the private `presetManager`).

| | Attempt 1 `run_a176017c` | Attempt 2 `run_6e924106` |
|---|---|---|
| Duration | 270s | 470s |
| Tool calls | 0 | 5 |
| **Successful writes** | **0** | **0** |
| Outcome | `partial` | `degraded` |
| `check_tier` | none | none |
| `executor_no_tool` turns | 2 | 8 (110s) |
| Delegate | `delegate_snapshot_error` | `delegate_snapshot_error` |

Ground truth confirms zero writes — every source file's mtime is still
`8/4/2026 10:5x PM`, from the previous session. Nothing was modified.

Attempt 2 also lost a planner stage to `stage_window_exhausted` (120s deadline)
and spent 110s across 8 no-tool executor turns.

---

## 3. The one unambiguous win: it stopped lying

Attempt 2's final output, verbatim:

> "**No source fixes were applied this turn — the files on disk are unchanged,
> so the build will still fail with the exact errors you listed.** Only
> `PluginProcessor.cpp` was actually read; the source was not modified and no
> rebuild was run."

It then produced a correct, per-error remediation table.

Attempt 1 was equally direct: "The Group A refactor compile errors **have not
been fixed**. The executor only read files but made **zero mutations**."

Neither run claimed success. Both were scored `partial`/`degraded`. Supervision
also caught a zero-mutation executor pass at 35s in attempt 2 and rerouted back
into the executor rather than letting it through:

> `reroute: write-intent executor stage completed with zero successful mutations; re-entering executor`

Set against this session's starting point — 21 uncompiled writes that would have
persisted as success — the completion-integrity layer is now behaving.

---

## 4. The blocker: the delegate never ran

In **both** attempts the delegate failed at launch with
`delegate_snapshot_error`, before `minimax-m3` executed a single tool. The
server log shows the launch and the failure 214ms apart:

```
13:35:47.241 INFO Pipeline: delegate launching model=minimax-m3 pool=go_capable reason=write_evidence
13:35:47.455 (stage_run) partial_error_code=delegate_snapshot_error
```

Once that happens, `delegateNoWriteRuns` benches the delegate for the rest of
the run — the log shows `delegate skipped: prior attempt produced no verified
write` four more times. Every subsequent write attempt fell to the free
OpenCode Zen pool (`deepseek-v4-flash-free` ×11, `north-mini-code-free` ×4,
`big-pickle` ×3), which produced reads and prose but no edits.

**So the capable model never got a turn.** That is the whole story of both runs.

### 4.1 What I got wrong

I initially attributed `delegate_snapshot_error` to the 336-file / 255 MB
`build/` tree I created while verifying Group A. Perihelion has no `.gitignore`,
and `captureRoot` uses `git ls-files -co --exclude-standard`, which includes
untracked files — so the snapshot was SHA-256ing every build artifact.

That attribution does not hold:

- The same error occurred **three times on 2026-07-22**, months before any build
  directory existed.
- It **recurred after** the exclusion fix was deployed.
- It **does not reproduce**: capturing both allowed roots now takes 205ms and
  65ms and succeeds — 41 files, zero from `build/`.

The exclusion fix is still worth having (377 files → 41; 255 MB → negligible,
on every delegate launch, twice per run) and the coupling it removes is real:
the build gate's CMake detector only fires when `build/CMakeCache.txt` exists,
so the gate guarantees every C++ workspace grows exactly the tree that was
being hashed. But **it is not the cause of this error, and the cause is not
established.**

### 4.2 What is known

- Failure is in the pre-launch snapshot inside `runClaudeDelegate`
  (`claude-delegate.ts:1266`), reached only when `snapshotFactory.capture()`
  rejects.
- `stage_runs.error_message` is the bare code and `diagnostic_json` is empty —
  the underlying exception text is discarded, which is why this is unexplained.
  The `delegateFailure` narrative carries
  `Delegate ground-truth snapshot failed: ${error}` but it is not persisted.
- Both allowed roots are healthy in isolation:
  `C:\Users\ethan\Downloads\Perihelion` (git, 41 files) and
  `C:\Users\ethan\.openclaw\agents\coderclaw\workspace\home-base` (filesystem,
  10 files).
- Intermittent: 5 occurrences total in the store, clustered on 2026-07-22 and
  2026-08-05.

The single highest-value next step is to **persist the snapshot exception text**
into `diagnostic_json`. This error has now cost two live-fire runs and one
false diagnosis, and it is unexplained purely because the message is thrown
away.

---

## 5. State of the Perihelion work

Unchanged from last night — this session added no source edits.

| Task | Criterion | Status |
|---|---|---|
| A1 | `PresetManager` wired | Structurally wired; **editor cannot reach it** (private, no accessor) |
| A2 | 0 literal `"volDepth"` | **PASS** |
| A3 | `PluginProcessor.cpp` < 400 lines | **FAIL** — 560 lines; also left `volGain` dangling |
| A4 | No orphan `Source/*.h` | PASS (mechanical) |

The tree does not compile: ~20 distinct errors, six of seven error-causing
symbols introduced by the 08-04 run (`HEAD=0 → NOW=2`), mostly fabricated JUCE
APIs.

---

## 6. Standing gaps

1. **`delegate_snapshot_error` — unexplained, blocks the capable model.** Now
   the top item. Persist the exception text first.
2. **Free-pool models cannot edit.** With the delegate benched, 11 calls to
   `deepseek-v4-flash-free` and 4 to `north-mini-code-free` produced zero
   mutations across 470s. This is the ceiling the 2026-06-30 audit named, and
   it is now the binding constraint again.
3. **One no-write failure benches the delegate for the whole run.**
   `delegateNoWriteRuns` cannot distinguish "this model won't write" from "the
   snapshot crashed before launch". An infrastructure failure should not count
   as model evidence.
4. **`success_without_runtime_check` (93) is fixed going forward but not
   retroactively** — historical rows still carry it; date-slice future
   benchmarks.
5. **`mid_loop_continue` hot loop** — 73 directives in ~6s in the 08-05 02:50
   run. Untouched by any fix this session.
6. Perihelion has no `.gitignore`; `build/` is untracked and visible to every
   tool that walks the tree.
