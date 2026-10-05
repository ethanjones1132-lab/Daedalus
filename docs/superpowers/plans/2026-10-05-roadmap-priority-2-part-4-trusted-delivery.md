# Roadmap Priority 2 — Part 4: Trusted accepted delivery

**Owner:** Luna, planning/review/coordination. **Production executor:** OpenCode CLI `opencode-go/deepseek-v4.1-flash` only.

## Outcome

Approved actions execute through Jarvis's canonical Tool runtime under the existing Permission policy. A trusted acceptance manifest is validated before execution, runtime-owned checks determine acceptance, and durable evidence/output references flow back to the Goal and Action Registry. Completion is a verified, reviewable delivery state and cannot be inferred from model prose.

## Prerequisite

Parts 1–3 are committed and reviewed. Use their Goal state, run/checkpoint, schedule, cancellation, permission, resource, and evidence contracts. Continue the existing Action Registry integration; do not create another action source of truth or direct tool executor.

## Trusted manifest source and administration

- Store trusted acceptance manifests in a distinct native SQLite table in the existing `jarvis.db` under Tauri `app_data_dir`; the Action Registry files under `workspace/action-registry` remain untrusted action data and are not a manifest authority.
- Each registered manifest has a stable native manifest ID, schema version, canonical content hash, validated versioned content, exact Agent ID, and canonical project-root scope. The user must explicitly add, replace, or remove a manifest through a Settings trust-management surface. There are no auto-seeded executable manifests.
- Goal, Action Registry, model, and task content may reference a registered manifest ID only. None may supply, replace, mutate, or authorize manifest content. Native code resolves the ID and revalidates its Agent/project scope at dispatch; a missing, stale, malformed, or mismatched binding remains unavailable/blocked.
- The Settings surface must show manifest ID/version/hash and bound Agent/workspace scope, and require an explicit user action for each add/replace/remove. Trust administration does not grant tool permissions; dispatch still uses current native Agent projection and existing ToolRuntime Permission policy.

## v1 trusted acceptance manifest schema (Part 4 slice 1)

Slice 1 implements only the native trust registry and its explicit Settings management surface. It defines the exact versioned content shape below, stores strictly validated canonical content, and performs no dispatch, execution, evidence, or completion.

### Registry row

Table `trusted_acceptance_manifests` in the app-owned `jarvis.db` (via `AppDb`):

| Column | Meaning |
|---|---|
| `manifest_id` | Stable native UUID minted on create; never changes across replace. |
| `registry_version` | Incrementing integer starting at 1; `replace` adds exactly 1. |
| `schema_version` | Content schema version (only `1` is accepted now). |
| `content_hash` | Lowercase SHA-256 of the canonical serialized content. |
| `content_json` | Canonical validated JSON (`json_valid` enforced). |
| `agent_id` | Exact existing, enabled native Agent row id. |
| `project_root` | Canonical existing directory from `normalize_project_root`. |
| `action_id` | Exact Action Registry `id` this manifest is bound to (opaque identity). Nullable only for legacy rows created before action binding; those stay unbound/unavailable. |
| `created_at`, `updated_at` | Native timestamps. |

No row is auto-seeded. `create` mints `registry_version = 1`. `replace` and `remove` require an optimistic `expected_version` and/or `expected_hash`; the write is guarded by `WHERE registry_version = ? AND content_hash = ?`, so a stale caller cannot silently overwrite or delete a changed record. Uniqueness is enforced per canonical project root + `action_id` (unique index `idx_trusted_manifests_root_action`); SQLite treats NULLs as distinct, so legacy unbound rows never collide.

### Action binding

- Every trusted manifest is tied to **exactly one** Action Registry `id`, supplied explicitly by the user on add/replace.
- `create`/`replace` call the native resolver `resolve_bindable_action_conn`, which reads the file-backed Action Registry `active` bucket and requires the id to resolve to exactly one item that is `open`/`in_progress` and already satisfies the same approval condition `dispatch_approved_action` enforces (`approval_required` false, or `approval_status` in `approved`/`waived`).
- The action id is **opaque identity only**. The action title, description, and any other Action Registry text are never read as tool calls, arguments, or acceptance content, and Goal/model text may only select a manifest ID.
- Missing, duplicated, non-active, or approval-ambiguous/unavailable action ids are rejected with an actionable error; binding never infers approval. Rebinding a legacy unbound row requires an explicit `replace` with a valid action id.

### Content JSON v1 (exact shape)

```json
{
  "schema_version": 1,
  "execution": [
    { "tool": "write_file", "arguments": { "path": "notes/result.md", "content": "Hello from Jarvis\n" } }
  ],
  "acceptance": {
    "<stable-goal-criterion-uuid>": [
      {
        "tool": "read_file",
        "arguments": { "path": "notes/result.md" },
        "expect_sha256": "<64-char lowercase sha256>"
      }
    ]
  }
}
```

- `execution` is the explicit approved call list; `acceptance` is keyed by stable Goal criterion UUID and each check carries the deterministic result's expected SHA-256.
- Tool identity and arguments are the only call data. There is no `command`, `shell`, `script`, `template`, or free-form `args` field anywhere in the shape. The only free-text fields are the bounded writer payloads `content`, `old_string`, and `new_string`, which are permitted solely for execution writers.
- **Execution vs acceptance allowlists (distinct):** `execution` may use the read tools `read_file`, `list_directory`, `glob`, `grep` plus the minimal bounded writers `write_file` and `edit_file`, so the approved action can perform state-changing filesystem work. `acceptance` remains separately restricted to the deterministic read-only tools `read_file`, `list_directory`, `glob`, `grep`. A writer never appears under `acceptance`.

### Strict validation

- `deny_unknown_fields` at every level: unknown keys are rejected.
- `schema_version` must equal `1`; `execution`/`acceptance` must be non-empty.
- Shell tools (`bash`, `powershell`), the unbounded/array writers (`apply_patch`, `multi_edit`), web tools, and any template/script field are rejected — so no shell command string, script, or unbounded payload can be encoded. A writer is rejected if its exact arguments cannot be bounded safely.
- Per-tool arguments are exact and bounded:
  - `read_file` requires `path`, allows bounded `offset`/`limit`.
  - `list_directory` requires `path`.
  - `glob` requires `pattern` and optional `path`.
  - `grep` requires `pattern`, optional `path`/`output_mode` (`files_with_matches`, `content`, `count`)/`head_limit`.
  - `write_file` (execution only) requires `path` and `content` (bounded UTF-8 payload).
  - `edit_file` (execution only) requires `path`, non-empty `old_string`, and `new_string` (bounded UTF-8 payloads).
  - Any other field for a tool is rejected, and the writer payload fields are rejected on every read-only tool and on all acceptance checks.
- Paths must be relative, non-empty, ≤ 1024 chars, free of control characters, and must not be absolute, drive-prefixed, root, or contain `..`.
- Patterns must be non-empty, ≤ 512 chars, and free of control characters.
- Writer payloads (`content`, `old_string`, `new_string`) are valid UTF-8 by construction, must contain no NUL byte, and are ≤ 64 KiB each; the 64 KiB manifest cap bounds their total.
- `expect_sha256` must be exactly 64 lowercase hex characters.
- Acceptance criterion keys must be well-formed UUIDs (resolved against the bound Goal's `goal_criteria.id` at resolution time, which is not implemented in slice 1).
- The bound `action_id` must be non-empty and must resolve to exactly one active `open`/`in_progress` Action Registry item that satisfies the existing approval condition; otherwise binding is refused.
- Bounds: whole manifest ≤ 64 KiB; each writer payload ≤ 64 KiB; ≤ 50 execution calls; ≤ 100 acceptance criteria; ≤ 50 checks per criterion; ≤ 200 total checks.

### Trust invariants

- The SQLite registry is the only native trust authority; the file-backed Action Registry remains untrusted.
- Manifest scope binds an exact existing **enabled** Agent and a canonical existing workspace root. Registration is attribution only and grants no tool permission.
- Listing `write_file`/`edit_file` in `execution` grants no permission and bypasses no approval. Later execution must run through the canonical ToolRuntime in an Agent context under current Permission policy; if policy denies or requires approval it persists a `blocked`/`waiting` state and is never treated as dispatched.
- Content is never supplied or authorized by Goal, model, task, Action Registry, or Action Registry text. Goal/model/registry text may reference a manifest ID only — never action calls, arguments, or acceptance checks.
- Each manifest binds exactly one Action Registry id as opaque identity; its title/description are never read as tool calls, args, or acceptance.
- Canonical content SHA-256 is computed over the re-serialized validated content (struct-field order, sorted criterion keys, omitted absent optionals), so equivalent inputs hash identically.

## Implementation scope

1. Define a versioned trusted acceptance-manifest contract in the app-owned SQLite registry above and validate it against canonical Goal criteria. Manifest selection must be explicit and scoped to project/workspace/Agent; content supplied by a Goal, model, action description, or untrusted registry data cannot grant permission or define a command to trust.
2. Replace the current eligible-action `verification_manifest_missing` unavailable stub only where a trusted manifest resolves and current policy authorizes it. Otherwise preserve an explicit actionable unavailable/blocked/waiting reason.
3. Dispatch the approved action through canonical Tool runtime bundles and a bounded execution context. Revalidate Agent projection and Permission policy at dispatch; honor cancellation, timeout/resource bounds, and durable idempotency from Part 2/3.
4. Execute acceptance criteria using runtime-owned checks and capture exact command/tool identity, exit outcome, timestamps, run ID, and bounded output artifact/evidence references. Model-written success claims are never acceptance evidence.
5. Write execution and acceptance outcomes atomically/idempotently to Goal run/checkpoint/evidence state and the existing Action Registry `execution_evidence`; status transitions must distinguish pending, running, waiting, blocked, paused, completed, failed, and cancelled.
6. Close the Goal only when every required criterion is accepted and reviewable output/evidence is linked. Partial or unavailable verification remains open with a specific blocker. Ensure ambiguous outcomes preserve the exact operation identity for safe reconciliation/retry.
7. Complete integrated Goal/Action Registry UX: approved/waiting/blocked state, progress, evidence and output links, retry/cancel affordances, and confirmed receipt wording only after durable readback. Keep P1 memory acceptance status unchanged.

## Source review criteria

- Trust provenance for each acceptance manifest and command is explicit and cannot be supplied by runtime user/task text.
- All actual effects go through canonical Tool runtime + existing Permission enforcement; no direct shell/process bypass or new permissions.
- Completion derives from exact runtime check results plus durable evidence readback; assistant wording cannot complete a Goal.
- Cancellation/failure/partial/unavailable/ambiguous outcomes cannot become accepted completion.
- Retrying after restart reuses the durable operation identity and does not repeat an effect already known complete.
- Action Registry and Goal remain reconciled after durable write/readback failure without false success messages.

## Allowed verification

Run only source review, migration inspection, compiler/type/build checks, and diff/status checks. Do not add/run tests, fixtures, test declarations, scripted provider, live inference, real action dispatch, runtime acceptance, restart demonstrations, packaging, or installation. Record all Priority #2 completion criteria as NOT RUN/open pending explicit live acceptance work.

## Checkpoint

Require a focused fresh Luna source review of the final dispatch/acceptance paths, all allowed checks against exact final source SHA, and a documentation/evidence checkpoint. No Priority #2 runtime-complete claim is permitted without the roadmap's real-goal, interruption/restart, actionable blocker, distinct cancellation/failure, and accepted evidence/output criteria.
