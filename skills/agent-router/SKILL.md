---
name: agent-router
description: Routing playbook for which model, effort level, subagent, CLI agent, skill or plugin should do each piece of work — Opus 5.5 / Haiku 5.5 / Sonnet 5.5 / Fable 5.1, GPT-6 Luna and GPT-6.1 Sol (Codex CLI), Grok 4.7 (Grok CLI), and the OpenCode tier (DeepSeek v4.1 Flash, Mimo 2.6 Flash, OpenCode Zen free models). Use it at the start of any task bigger than a quick edit, before spawning a subagent or fork, before shelling out to another model's CLI, whenever work could be split, delegated, reviewed or run in parallel, and whenever usage limits, cost, prompt caching, effort or "which model should do this" come up — even if the user doesn't ask about routing. Written for any driver (Claude, GPT-6 or Grok).
---

# Agent Router

You are the **driver**, the model running this session: Claude Opus 5.5 in Claude Code, GPT-6 in Codex, or Grok 4.7 in the Grok CLI. This skill tells you who should do each piece of work so the user gets the best output for the least plan usage.

The user's priorities, in order:
1. **Correct, complete output.** Small misses that need correcting are the main thing they want to avoid.
2. **Usage saved.**
3. Speed.

Never trade the first for the second. A cheaper route that needs a redo is not cheaper.

## The roster

The roster has three layers: the driver thinks, the **worker pool** does the work, and the **frontier specialists** are called in for the hardest thinking and for reviews.

**Driver**
- **Claude Opus 5.5**, in the session itself, effort **high**, fixed. It plans, makes architecture and judgment calls, diagnoses subtle problems, writes worker briefs, checks every result, and integrates.

**Worker pool (the default for doing the work)**
- **OpenCode Zen free models**, via the **OpenCode CLI**. Bulk, low-stakes reading and summarizing.
- **DeepSeek v4.1 Flash**, via the **OpenCode CLI** (Go plan). The default grunt worker: code, data generation, summaries, first drafts.
- **Mimo 2.6 Flash**, via the **OpenCode CLI** (Go plan, paid). An alternative or second try for the same work.
- **Claude Haiku 5.5**, via the Agent tool with `model: haiku`. Use **xhigh** for fixes and edits, **low** for lookups and checks. It is the Claude-side implementer: well-specified fixes, edits and tests from a brief. Keep each task's context under about 100K tokens, because its price rises 5× above that.
- **GPT-6 Luna**, via the **Codex CLI**, effort **xhigh**. The strongest pool member, for implementation that needs more than Haiku or the Flash models give, and for parallel implementation in its own worktree.

**Sub-lead (only when needed)**
- **Claude Sonnet 5.5**, via the Agent tool with `model: sonnet`, effort high. Use it only when one chunk of work needs its own coordinator, running several Haiku workers in parallel and integrating their results (see below).

**Frontier specialists**
- **GPT-6.1 Sol**, via the **Codex CLI**, effort **high**. Heavy reasoning, final review of significant changes, and second attempts on problems that resisted two tries.
- **Grok 4.7**, via the **Grok CLI**, default effort. Heavy reasoning, planning, second opinions and reviews; fast and efficient.

**On request only**
- **Claude Fable 5.1**, via `/model fable`. Only when the user asks, because it can bill to usage credits.

Standing rules:

- **Workers do the work; the driver checks it.** You may still handle something inline when briefing would cost more than doing it (see "Don't over-route").
- **Sonnet never drives, never gives the final review, and isn't a default worker.** It earns a place only as a sub-lead over parallel Haiku workers.
- **Sol and Grok are for thinking and judging.** They aren't routine implementers; send routine implementation to the worker pool.
- **When GPT-6 or Grok is the driver, don't route to Claude models.** Use your own vendor's models plus the OpenCode tier. Luna (or the Flash models) takes Haiku's place.

Exact CLI commands and model slugs are in `references/channels.md`. Read it the first time you delegate to an external CLI in a session.

## Route each piece of work

Before starting a task, split it into pieces and route each one. Take the first rule that fits:

1. **Small, and dependent on this conversation?** → **Do it inline.** Your cache is warm, and a brief would cost more than the work. This covers one-file fixes, renames across a handful of files, and quick questions.
2. **Bulk reading or summarizing** (logs, docs, transcripts, many files)? → **Zen free model or DeepSeek v4.1 Flash**. Then verify with spot reads or cross-checks.
3. **Data, fixtures, boilerplate, conversions, first drafts, or mechanical edits across many files?** → **DeepSeek v4.1 Flash**, with Mimo 2.6 Flash as the second try. You verify with a test or a diff check.
4. **A well-specified fix or edit** (you know the cause and the change; it's bounded and has a check)? → **Haiku 5.5 at xhigh**. Give it the files, the cause, the intended change and the acceptance check. For implementation that is larger or more involved, or for a GPT-6 driver, use **GPT-6 Luna at xhigh** in its own worktree.
5. **Several independent pieces that each need a worker, plus coordination** (a split refactor, a migration across modules, many failing-test clusters)?
   - Driver only: **dispatch Haiku workers in parallel yourself** when you can brief each one directly and the integration is simple.
   - Sub-lead: send it to a **Sonnet sub-lead** when the chunk is big enough that coordinating it would flood your context. Sonnet runs the parallel Haiku workers and hands you one integrated result.
6. **Running tests, builds or searches and reporting the result?** → A fresh **Haiku 5.5 subagent at low**, with the exact commands and the output format you want (e.g. failures grouped by file and error). Use a **fork** (Claude Code: the `fork` subagent type or `/subtask`) only when the side task needs this conversation's reasoning, not just its commands. A fork runs on the driver's model and carries your full history, so it reuses your cache but is the most expensive way to run anything.
7. **Hard design, architecture, or diagnosis?** → **Do it yourself**, at high effort. If the problem is genuinely heavy or contested, get an opinion from **Grok 4.7** or **GPT-6.1 Sol** before committing to it. If a bug survives two attempts, get a second attempt from **Sol** or **Grok**, giving them your failed hypotheses.
8. **A significant change about to be called done** (multi-file, touches core logic, security, data or anything hard to undo)? → Do your own review, then a **cross-vendor review** from **GPT-6.1 Sol (high)** or **Grok 4.7**. Different training means different blind spots, and that is exactly where the small misses hide.

**Escalation ladder** for worker output that fails its check twice:
- free → DeepSeek / Mimo → Haiku xhigh → Luna xhigh → do it yourself.
- When stuck on reasoning, not on volume: go to Sol or Grok.

**Don't over-route.** Every delegation costs a brief, a cold start and your time reading the result. Delegate when the work is big enough, or parallel enough, to repay that.

## Cache and context economics

Facts from the Claude Code and Claude API docs, checked 2026-10:

- **Caching is a prefix match, scoped to one model.** Same tools, system prompt and messages, in order, on the same model. **Switching the main session's model throws the cache away**, so keep the main session on one model and send other work to subagents and CLIs.
- **On a subscription, cache entries live 1 hour** (5 minutes once you're drawing on usage credits). Every read refreshes the timer. Reads are cheap (0.05× input on Opus 5.5, about 0.1× on most models), but **every turn re-reads the whole conversation**, so a long session costs more per message even when fully cached.
- **A fresh subagent never shares your cache.** It has its own system prompt and tools, so it writes its own small cache. **A fork does share it**, but carries your full history.
- **External CLIs (Codex, Grok, OpenCode) are always cold** and know nothing you haven't put in the brief. Write tight, self-contained briefs, and point at file paths they can read rather than pasting content.
- **Every subagent and CLI call counts against limits.** The Claude ones share the session's 5-hour and weekly windows; external ones draw on that vendor's plan. Agent teams cost about 7× a normal session, so don't use them without being asked.

What follows from these facts: the main cost driver is **how much context each piece of work carries**, not cache hits. Keep the driver's context on decisions. Push reading and doing into the worker pool, and bring back summaries and diffs rather than raw output.

## Worker protocol

1. **The driver writes each brief:**
   - the goal;
   - the files in scope and what is out of scope (no skipped tests, no weakened assertions, files not to touch);
   - the cause or intended change, if known;
   - an **acceptance check** you can verify (a test command, an expected output, an exact behavior);
   - the output wanted (a diff summary plus the check's actual output).
2. **Tell workers to stop and report, not improvise**, when what they find doesn't match the brief.
3. **Parallel workers get disjoint files or their own git worktrees** (`git worktree add ../<name> -b <branch>`), so they can't collide.
4. **Check every result before building on it:** read the diff and rerun the check; don't trust the summary. A miss caught here is cheap, and one caught at the end is not.
5. **The driver does the final review**, plus a cross-vendor review for significant changes (rule 8).

### Sonnet sub-lead

Use one only under rule 5. The driver gives Sonnet the chunk's plan, broken into worker briefs (or the material to write them), and the acceptance check for the whole chunk. Sonnet then:
- dispatches **Haiku 5.5 workers in parallel**, at xhigh for edits and low for checks, each on disjoint files and under ~100K tokens;
- checks each worker's result against its brief;
- integrates the results and runs the chunk's check;
- reports one result: a diff summary, the check's output, and anything it was unsure of.

The driver reviews the integrated diff before accepting it. Subagents nest three layers deep by default, so Opus → Sonnet → Haiku fits.

## Delegating to an external CLI

- **Run from the repo directory.** Give implementers (Luna, DeepSeek, Mimo) their own worktree when they edit files; run reviewers read-only where the CLI supports it.
- **Capture the output to a file** and read it from there. Don't stream a long transcript into your own context.
- **Verify before you trust.** Run the tests, read the diff. Pool output is a draft until it's checked.
- **Never send secrets**: API keys, tokens, `.env*` files, `auth.json`, credential stores, or personal data. Any other code or content may go to any model on the roster.
- **Don't ask permission for routine delegation within these rules.** Log it instead (see Routing log).

## Choosing skills and plugins

- **Before starting a task, scan the available skills list** and load any skill whose description fits before acting. Skills hold known-good procedures, and skipping one means re-deriving it, usually worse.
- **Prefer a CLI over an MCP tool** when both can do the job (`gh` over a GitHub MCP for bulk reads, for example); a CLI adds less to context.
- **Give subagents the skills they need** (the `skills:` frontmatter, or by naming them in the brief) rather than loading those skills into your own context.
- **If you've done the same multi-step procedure twice**, tell the user it could become a skill.

## Effort

| Model | Effort |
|---|---|
| Opus 5.5 (driver) | **high**, always (the user's choice). Don't raise to max or switch to Fable unless asked. |
| Haiku 5.5 | **xhigh** for fixes and edits; low for lookups and checks. Set it per invocation (Agent tool `effort`) or in agent frontmatter. |
| Sonnet 5.5 (sub-lead) | high |
| GPT-6 Luna | xhigh |
| GPT-6.1 Sol | high |
| Grok 4.7 | default |

## Routing log

End every substantial task with a short **Routing log** listing each delegation, in this form:

`who (model, effort) — what for — rough size — outcome (accepted / fixed / redone / escalated)`

Include escalations and anything a worker got wrong. This is how the user judges whether the routing is paying off, and how this skill gets tuned. Skip the log when nothing was delegated.
