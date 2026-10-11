# ADR: Agent router skill (model, agent and skill routing)

Source: `skills/agent-router/`. Decided with the owner on 2026-10-11, in an interview against the Claude Code and Claude API docs.

## Decision

A Claude Code plugin, `agent-router` (`plugins/agent-router/`), tells whichever model is driving a session (Claude Sonnet 5.5, GPT-6 or Grok 4.7) who should do each piece of work. It bundles the routing skill with four fixed agent definitions (approver, worker, runner, lead).

| Question | Decision |
|---|---|
| Where it lives | A plugin in this repo's `daedalus-tools` marketplace, plus the same skill as a claude.ai skill for cloud sessions. There is no SessionStart hook or CLAUDE.md pointer; it stays optional until it proves itself. (Revised 2026-10-11: it was a claude.ai skill only.) |
| Claude driver | **Sonnet 5.5 at xhigh**. Opus 5.5 (high) is consulted as a subagent: it approves large plans (gate 1) and handles heavy reasoning (gate 2). Fable 5.1 only on request. (Revised 2026-10-11: Opus at high was the driver.) |
| Sonnet safeguards | The plan goes in a file and is re-read at each milestone; the request is checked line by line before calling the task done; anything surprising means stop and re-plan. |
| Worker pool (default doers) | OpenCode Zen free models, DeepSeek v4.1 Flash and Mimo 2.6 Flash (OpenCode Go, paid) **through OpenCode CLI only**; Haiku 5.5 at **xhigh** for well-specified fixes and edits (context under ~100K tokens); GPT-6 Luna at xhigh (Codex CLI) for larger implementation. |
| Sonnet 5.5 sub-lead | `agent-router:lead`, used only when a large chunk needs its own coordinator over parallel Haiku workers. |
| Frontier specialists | GPT-6.1 Sol at high (Codex CLI) and Grok 4.7 (Grok CLI): heavy reasoning, second opinions, second attempts on stuck problems, and cross-vendor final review (Grok by default; Sol for core or hard-to-undo changes). They aren't routine implementers. GPT-6 also runs this skill as a driver. |
| Data rule | Anything that isn't a secret may go to any roster model. Secrets, keys, `.env*`, `auth.json` and personal data never leave. |
| DeepSeek quota | No skill-level restriction. |
| Non-Claude drivers | Don't route to Claude. They use their own vendor plus the OpenCode tier. |
| CLI slugs and flags | Discovered on first use and saved in `~/.agent-router/channels.md`, which every driver shares. The shipped templates are marked unverified. |
| Approval | No asking before routine delegation. Every delegation goes in a Routing log at the end of the task. |

## Facts this rests on (checked 2026-10-11)

- **Prompt caching** matches on an exact prefix (tools → system → messages) and is scoped to one model. Switching the main model throws the cache away.
- **Cache lifetime on a subscription** is 1 hour, dropping to 5 minutes once usage credits are in use. Reads refresh the timer. Reads cost about 0.1× input (0.05× on Opus 5.5); writes cost 1.25× for a 5-minute entry and 2× for a 1-hour entry.
- **Fresh subagents** have their own system prompt and tools, so they never share the parent's cache. **Forks** reuse the parent's cache on their first request but carry its full history.
- **Subagents nest** three layers deep by default. Their requests count against the same plan limits as the main session.
- **Effort defaults:** Opus 5.5, Sonnet 5.5 and Haiku 5.5 default to `medium` in Claude Code. The `high` driver setting is a deliberate override.

## Consequences

- Inline work versus delegation is decided by **how much context each piece carries**, not by chasing cache hits.
- The routing log makes the skill's value measurable, and the owner can tune the roster from it.
- Model slugs and CLI flags for GPT-6, Grok and OpenCode are unverified until a driver records them on the owner's machine.
