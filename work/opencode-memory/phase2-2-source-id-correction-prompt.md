Apply one bounded Priority #2 Part 2 correction with exact OpenCode model `opencode-go/deepseek-v4.1-flash`. The last exact source-check pass and receipt flow are present and compile, but Luna found a remaining integrity gap:

`GoalRunRegistry.consume()` in `server-jarvis/src/native-memory.ts` currently accepts only `(turnId, sessionId, message)` and merely checks the stored `source_message_id` is nonempty. `server-jarvis/src/index.ts` calls it with three arguments. `JarvisView.tsx` passes `userMessageId` to native `goal_prepare_run`, but does NOT include that ID in the `/chat/stream` request body. This fails the explicit exact `(Session, turn, source_message_id, source hash)` requirement; a hash alone is insufficient.

Fix it narrowly:
1. Add the exact persisted `source_message_id` (the same native saved user row ID used by `memory_prepare_turn`) to the `/chat/stream` request payload when a native/Goal turn has it. Parse/bound it at the server request boundary into private turn options. Missing/invalid remains absent and cannot consume a Goal binding.
2. Change `GoalRunRegistry.consume` to require the supplied source message ID and actual `message`; match exact Session + turn + source ID and compare SHA-256 of actual message body to the native-bound stored hash before consuming. Missing, mismatched, expired, or replayed registration yields no Goal association and creates no Goal-linked TaskRun. Do not consume on a mismatch.
3. Preserve ordinary Goal-less HTTP and relay turns when they omit source ID. Keep source ID as identity only; no body/client field becomes authority beyond matching a binding already registered through the private native capability.
4. Add/update no test files; do not run tests. Keep existing native registration/terminal proof and checkpoint code intact.

Use focused source reads. Allowed checks: `bun run typecheck`, server build, `cargo check`, UI build, `git diff --check` only. Do not commit. Report changed files, the exact validation path, check results, and confirm tests were not added/run.
