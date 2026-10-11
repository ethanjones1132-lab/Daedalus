---
name: agent-router
description: Routing playbook for which model, effort level, subagent, CLI agent, skill or plugin should do each piece of work — Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Fable 5.1, GPT-6 Luna and GPT-6.1 Sol (Codex CLI), Grok 4.7 (Grok CLI), and the cheap OpenCode tier (DeepSeek v4.1 Flash, Mimo 2.6 Flash, OpenCode Zen free models). Use it at the start of any task bigger than a quick edit, before spawning a subagent or fork, before shelling out to another model's CLI, whenever work could be split, delegated, reviewed or run in parallel, and whenever usage limits, cost, prompt caching, effort or "which model should do this" come up — even if the user doesn't ask about routing. Written for any driver (Claude, GPT-6 or Grok).
---

# Agent Router

You are the **driver**: the model running this session, whether that is Claude Opus 5.5 in Claude Code, GPT-6 in Codex, or Grok 4.7 in the Grok CLI. This skill tells you who should do each piece of work so the user gets the best output for the least plan usage.

The user's priorities, in order: **correct, complete output** (small misses that need correcting are the main thing they want to avoid), then **usage saved**, then speed. Never trade the first for the second. A cheaper route that needs a redo is not cheaper.

## The roster

| Tier | Model | Reach it via | Effort | Use for |
|---|---|---|---|---|
| Driver (Claude sessions) | Claude Opus 5.5 | the session itself | **high**, fixed | Planning, architecture, subtle debugging, judgment calls, integrating results, reviewing every milestone |
| Long-horizon executor | Claude Sonnet 5.5 | Agent tool, `model: sonnet` | high | Carrying out a plan Opus already wrote, milestone by milestone; may run its own Haiku workers |
| Claude grunt | Claude Haiku 5.5 | Agent tool, `model: haiku` | low–medium | Small, self-contained leaf tasks with a mechanical check; keep its context under ~100K tokens (its price rises 5× above that) |
| Frontier peer | GPT-6 Luna | Codex CLI | xhigh | Cross-vendor review, parallel implementation, most frontier work when GPT-6 drives |
| Frontier peer, strongest | GPT-6.1 Sol | Codex CLI | high | Final review of significant changes; second attempt on a bug that resisted two tries |
| Frontier peer | Grok 4.7 | Grok CLI | (default) | Heavy reasoning, planning, second opinions, also review and parallel implementation; fast and efficient |
| Cheap tier | DeepSeek v4.1 Flash, Mimo 2.6 Flash (OpenCode Go, paid), OpenCode Zen free models | **OpenCode CLI only** | — | Grunt work, first, every time (see below) |
| On request only | Claude Fable 5.1 | `/model fable` | — | Only when the user asks: it can bill to usage credits |

Two standing rules:

- **Sonnet never drives and never gives the final review.** It is the "bigger subagent": strong at executing a laid-out plan over many steps, but it can lose the plot or miss small things, so Opus plans before it starts and checks it at every milestone.
- **When GPT-6 or Grok is the driver, don't route to Claude models.** Use your own vendor's models plus the OpenCode tier. The Claude rows apply only to Claude sessions.

Exact CLI commands and model slugs are in `references/channels.md`. Read it the first time you delegate to an external CLI in a session.

## Route each piece of work

Before starting a task, split it into pieces and route each one. Ask these in order and take the first that fits:

1. **Is it grunt work?** That means bulk reading or summarizing (logs, docs, transcripts, many files), data or fixture generation, mechanical code (boilerplate, conversions, renames across files, simple scripts), or a first draft you'll correct. → **Cheap tier first**, through OpenCode. You then verify the result yourself with a test, a diff check or spot reads. If it fails twice, or the output is junk, escalate one step: Haiku for leaf tasks, Sonnet for anything needing judgment.
2. **Is it small and does it depend on what's already in this conversation?** → **Do it inline.** Your cache is warm, and a brief for someone else would cost more than the work.
3. **Does it depend on this conversation, but would flood your context with tool output** (a long test run, a big search)? → **Fork** (Claude Code: the `fork` subagent type or `/subtask`). A fork reuses your prompt cache and history; only its result comes back.
4. **Is it self-contained and reading-heavy?** → A **fresh subagent**: Haiku if mechanical and small, Sonnet if it needs judgment. Or the cheap tier, if it's grunt work. It starts cold but keeps your context lean.
5. **Is it a long, already-planned implementation?** → **Sonnet executor** under the milestone protocol below.
6. **Is it hard design, architecture, or a subtle bug?** → **Do it yourself**, at high effort. If a bug survives two genuine attempts, get a second attempt from **GPT-6.1 Sol** (high) or **Grok 4.7**, giving them your failed hypotheses so they don't repeat them.
7. **Is it a significant change about to be called done** (multi-file, touches core logic, security, data or anything hard to undo)? → Do your own review, then get a **cross-vendor review** from GPT-6.1 Sol (high) or Grok 4.7. Different training means different blind spots, and that is exactly where the small misses hide.

Don't over-route. A one-line fix, a quick question or a single-file rename is faster and cheaper inline than any delegation. Every delegation costs a brief, a cold start and your time reading the result. Delegate when the work is big enough, or parallel enough, to repay that.

## Cache and context economics

Facts from the Claude Code and Claude API docs, checked 2026-10:

- **Caching is a prefix match, scoped to one model.** Same tools, system prompt and messages, in order, on the same model. **Switching the main session's model throws the cache away**, so keep the main session on one model and send cheaper work to subagents instead.
- **On a subscription, cache entries live 1 hour** (5 minutes once you're drawing on usage credits). Every read refreshes the timer. Cache reads are cheap (0.05× input on Opus 5.5, about 0.1× on most models), but **every turn re-reads the whole conversation**, so a long session costs more per message even when it is fully cached.
- **A fresh subagent never shares your cache.** It has its own system prompt and tools, so it writes its own small cache. **A fork does share it**, but carries your full history.
- **External CLIs (Codex, Grok, OpenCode) are always cold** and know nothing you haven't put in the brief. Write tight, self-contained briefs, and point at file paths they can read rather than pasting content.
- **Subagents and CLI calls all count against the user's limits.** The Claude ones share the same 5-hour and weekly windows as the main session; the external ones draw on that vendor's plan. Agent teams cost about 7× a normal session, so don't use them without being asked.

What follows from these facts: the main cost driver is **how much context each piece of work carries**, not cache hits. Keep the driver's context focused on decisions. Push verbose reading into subagents or the cheap tier, and bring back summaries rather than raw output.

## Sonnet executor protocol (Claude sessions)

1. **Opus writes the plan.** Milestones in order, and for each one: the files in scope, what is out of scope, and an **acceptance check** Opus can verify, such as a test command, an expected output or an exact behavior.
2. **Sonnet runs one milestone at a time** and reports back with evidence: a diff summary, the check's actual output, and anything it was unsure about. Tell Sonnet to stop and report, not improvise, when the plan doesn't fit what it finds.
3. **Sonnet may hand leaf tasks to Haiku** (Agent tool, `model: haiku`), each self-contained with a mechanical check and under ~100K tokens. Subagents nest three layers deep by default, so Opus → Sonnet → Haiku fits.
4. **Opus reviews each milestone before the next starts.** That means reading the diff and checking the evidence, not trusting the summary. Fix course here; a miss caught at milestone 2 is cheap, and one caught at the end is not.
5. **Opus does the final review**, and adds a cross-vendor review for significant changes (step 7 above).

## Delegating to an external CLI

- **Brief template**: the goal; the files and paths to read; the constraints (what not to touch, the conventions); the exact output wanted (format, where to write it); and how success is checked. One brief, one job.
- **Run it from the repo directory.** A **parallel implementer gets its own git worktree** (`git worktree add ../<name> -b <branch>`) so it can't collide with your edits. Reviewers run read-only where the CLI supports it.
- **Capture the output to a file** and read it from there. Don't stream a long transcript into your own context.
- **Verify before you trust it.** Run the tests, read the diff. Cheap-tier output especially is a draft until you've checked it.
- **Never send secrets**: API keys, tokens, `.env*` files, `auth.json`, credential stores, or personal data. Any other code or content may go to any model on the roster.
- **Don't ask permission for routine delegation within these rules.** Log it instead (next section).

## Choosing skills and plugins

- **Before starting a task, scan the available skills list** and load any skill whose description fits before acting. Skills hold the user's and the platform's known-good procedures, and skipping one means re-deriving it, usually worse.
- **Prefer a CLI over an MCP tool** when both can do the job (`gh` over a GitHub MCP for bulk reads, for example); a CLI adds less to context.
- **Load a subagent's skills into the subagent** (the `skills:` frontmatter, or by naming them in the brief), not into your own context.
- **If you've done the same multi-step procedure twice**, tell the user it could become a skill.

## Effort

- **Claude driver:** Opus 5.5 at **high**, all the time (the user's choice). Don't raise it to max, or switch to Fable, unless the user asks.
- **Subagents:** Sonnet at high for long-horizon execution, and lower if the milestone is routine. Haiku at low for lookups and checks, medium for small edits.
- **GPT-6 Luna at xhigh; GPT-6.1 Sol at high; Grok 4.7 at its default.**

## Routing log

End every substantial task with a short **Routing log** listing each delegation, in this form:

`who (model, effort) — what for — rough size — outcome (accepted / fixed / redone)`

Include escalations and anything the cheap tier got wrong. This is how the user judges whether the routing is paying off, and how this skill gets tuned. Skip the log when nothing was delegated.
