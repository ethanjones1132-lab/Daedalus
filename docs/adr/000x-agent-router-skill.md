# ADR: Agent router skill (model, agent and skill routing)

Source: `skills/agent-router/`. Decided with the owner on 2026-10-11, in an interview against the Claude Code and Claude API docs.

## Decision

A single skill, `agent-router`, tells whichever model is driving a session (Claude Opus 5.5, GPT-6 or Grok 4.7) who should do each piece of work.

| Question | Decision |
|---|---|
| Where it lives | A claude.ai skill, with no SessionStart hook or CLAUDE.md pointer. It stays optional until it proves itself. |
| Claude driver | Opus 5.5, effort pinned at **high**. Fable 5.1 only on request (it can bill usage credits). |
| Sonnet 5.5 | The "bigger subagent": it carries out long-horizon plans that Opus wrote and may run Haiku 5.5 workers. It never drives and never gives the final review. Opus checks each milestone. |
| Haiku 5.5 | Leaf tasks with a mechanical check, context under ~100K tokens (its price rises 5× above that). |
| GPT-6 (Codex CLI) | Luna at xhigh for most work; 6.1 Sol at high for final reviews and second attempts. Roles: cross-vendor reviewer, parallel implementer, second attempt on hard bugs. GPT-6 also runs this skill as a driver. |
| Grok 4.7 (Grok CLI) | The same roles as GPT-6, weighted toward heavy reasoning, planning and second opinions. |
| Cheap tier | DeepSeek v4.1 Flash, Mimo 2.6 Flash (OpenCode Go, paid) and OpenCode Zen free models, **through OpenCode CLI only**. They get grunt work first, every time: bulk reading, data generation, mechanical code, first drafts. |
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
