---
name: agent-router
description: >-
  Use this skill before starting any substantial engineering job, to decide who does each piece: which model, effort level, subagent, worker or external CLI (Sonnet, Opus, Haiku, Codex/GPT-6, Grok, OpenCode/DeepSeek/Mimo/Zen). Trigger on multi-file or multi-step work. That includes executing a written plan or its phases, refactoring or splitting a large file, a repo-wide audit with fixes everywhere, getting a big batch of failing tests green, generating bulk data or fixtures, long investigations, and anything that can be split up, run in parallel, or needs review or a second opinion. Also trigger when usage limits, cost, prompt caching, effort or "which model should do this" come up, even if routing isn't mentioned. Skip it for quick lookups, one-line or single-file edits, factual questions about code, format conversions, commit messages, and how-to questions about a tool's configuration.
---

# Agent Router

You are the **driver**, the model running this session: Claude Sonnet 5.5 at xhigh in Claude Code, GPT-6 in Codex, or Grok 4.7 in the Grok CLI. This skill tells you who should do each piece of work so the user gets the best output for the least plan usage.

The user's priorities, in order:
1. **Correct, complete output.** Small misses that need correcting are the main thing they want to avoid.
2. **Usage saved**, frontier subscriptions first.
3. Speed.

Never trade the first for the second. A cheaper route that needs a redo is not cheaper.

## The roster

**Driver**
- **Claude Sonnet 5.5**, in the session itself, effort **xhigh**. It scopes the task, writes plans and worker briefs, checks every result, and integrates.

**Approver and heavy reasoner**
- **Claude Opus 5.5**, effort high. Reach it via `agent-router:approver`, or the Agent tool with `model: opus`. It approves large plans before they run, and handles the heavy reasoning: subtle diagnosis, architecture and design calls, and problems the driver couldn't crack.

**Worker pool (the default for doing the work)**
- **OpenCode Zen free models**, via the **OpenCode CLI**. Bulk, low-stakes reading and summarizing.
- **DeepSeek v4.1 Flash**, via the **OpenCode CLI**. The default grunt worker: code, data generation, summaries, first drafts.
- **Mimo 2.6 Flash** (paid), via the **OpenCode CLI**. An alternative or second try for the same work.
- **Claude Haiku 5.5**, via `agent-router:worker` (xhigh) and `agent-router:runner` (low). It is the Claude-side implementer: well-specified fixes, edits and tests. Keep each task's context under about 100K tokens, because its price rises 5× above that.
- **GPT-6 Luna**, via the **Codex CLI**, effort **xhigh**. Implementation that needs more than Haiku or the Flash models give; a parallel implementer in its own worktree.

**Sub-lead (only when needed)**
- **Claude Sonnet 5.5**, via `agent-router:lead`, effort high. Use it when one chunk needs its own coordinator, running parallel Haiku workers, and coordinating it yourself would flood your context.

**Frontier specialists**
- **GPT-6.1 Sol**, via the **Codex CLI**, effort **high**. Heavy reasoning, independent second opinions, second attempts on stuck problems, and cross-vendor final review.
- **Grok 4.7**, via the **Grok CLI**, default effort. The same roles as Sol; fast and efficient.

**On request only**
- **Claude Fable 5.1**, via `/model fable`. Only when the user asks, because it can bill to usage credits.

Standing rules:

- **Workers do the work; the driver checks it.** You may still handle something inline when briefing would cost more than doing it (see "Don't over-route").
- **Opus thinks and approves; it doesn't do routine work.** Bring it in at the gates below, not for every step.
- **Sol and Grok are for thinking and judging, not routine implementation.**
- **Don't switch the session's model mid-task.** `/model opus` throws away the prompt cache, and the whole context is re-sent at Opus prices. Consult Opus as a subagent instead.
- **When GPT-6 or Grok is the driver, don't route to Claude models.** Use your own vendor's models plus the OpenCode tier. Luna (or the Flash models) takes Haiku's place, and Sol or Grok takes Opus's.
- **If this session is actually running on Opus,** you are the approver too. Skip the Opus consults and keep the rest.

Exact CLI commands and model slugs are in `references/channels.md`. Read it the first time you delegate to an external CLI in a session. The `agent-router:*` agents come with the agent-router plugin; if they aren't installed, use the Agent tool with the model and effort shown above.

## Keeping the plot (Sonnet driver)

Sonnet's known weak spot is losing the thread on long tasks, or missing small things. Guard against that deliberately:

- **For any task beyond a quick edit, write the plan to a file before starting.** It holds the user's request verbatim, the constraints, the milestones and an acceptance check for each. Re-read the request and the current milestone from that file at every milestone boundary, not from memory.
- **Before calling the task done, check the original request line by line against the result.** Every requirement must be met and have evidence (a test, an output, a diff). Anything unmet is either finished or reported plainly.
- **When you find something surprising** (a cause you didn't expect, a test that contradicts the plan), stop and re-plan. Don't patch around it. If the re-plan changes a large plan, it goes back to Opus.

## The Opus gates (Claude sessions)

**Gate 1: plan approval.** A plan needs Opus's approval before work starts if it is any of these:
- multi-file and multi-step;
- touching core logic, security, data, or anything hard to undo;
- using more than about 4 workers.

How it works:
1. Write the plan file: the request, the findings with `file:line` evidence, the milestones with checks, the risks and the open questions.
2. Send `agent-router:approver` the path to that file and the key source paths. Opus starts cold and sees none of this conversation, so the file must stand alone.
3. Opus returns **APPROVE**, or **REVISE** with numbered changes. Apply them and resubmit.
4. After two REVISE rounds, take the disagreement to the user rather than looping.

**Gate 2: heavy reasoning.** Bring in Opus when:
- a diagnosis is subtle, or you have competing explanations;
- an architecture or design choice will be costly to reverse;
- a problem survives two of your own genuine attempts.

Give Opus the evidence and your failed hypotheses. For an **independent second opinion**, or when Opus's answer is uncertain, ask **Sol or Grok** as well; their usage isn't on the Claude plan.

## Route each piece of work

Before starting a task, split it into pieces and route each one. Take the first rule that fits:

1. **Small, and dependent on this conversation?** → **Do it inline.** Your cache is warm, and a brief would cost more than the work. This covers one-file fixes, renames across a handful of files, and quick questions.
2. **Bulk reading or summarizing** (logs, docs, transcripts, many files)? → **Zen free model or DeepSeek v4.1 Flash**. Then verify with spot reads or cross-checks.
3. **Data, fixtures, boilerplate, conversions, first drafts, or mechanical edits across many files?** → **DeepSeek v4.1 Flash**, with Mimo 2.6 Flash as the second try. You verify with a test or a diff check.
4. **A well-specified fix or edit** (the cause and the change are known; it's bounded and has a check)? → **Haiku 5.5 at xhigh** (`agent-router:worker`). For larger or more involved implementation, use **GPT-6 Luna at xhigh** in its own worktree.
5. **Several independent pieces that each need a worker, plus coordination?**
   - Simple integration: **dispatch the Haiku workers in parallel yourself, in one turn.**
   - A big enough chunk that coordinating it would flood your context: hand it to `agent-router:lead`.
6. **Running tests, builds or searches and reporting the result?** → **`agent-router:runner`** (Haiku 5.5 at low), with the exact commands and the output format you want (e.g. failures grouped by file and error). Use a **fork** only when the side task needs this conversation's reasoning, not just its commands. A fork carries your full history, so it reuses your cache but is the most expensive way to run anything.
7. **Hard design, architecture, or diagnosis?** → **Opus gate 2.** Draft your view first, so Opus judges a concrete proposal rather than starting from scratch.
8. **A large plan about to start?** → **Opus gate 1.**
9. **A significant change about to be called done** (multi-file, touches core logic, security, data or anything hard to undo)? → Do your own line-by-line check against the request, then get a **cross-vendor review** from **Grok 4.7** (the default) or **GPT-6.1 Sol** (for core or hard-to-undo changes). Different training means different blind spots, and that is exactly where the small misses hide.

**Escalation ladder** for worker output that fails its check twice:
- free → DeepSeek / Mimo → Haiku xhigh → Luna xhigh → you.
- If it's stuck on reasoning, not on volume: go to Opus (gate 2), then Sol or Grok.

**Don't over-route.** Every delegation costs a brief, a cold start and your time reading the result. Delegate when the work is big enough, or parallel enough, to repay that.

## Cache and context economics

Facts from the Claude Code and Claude API docs, checked 2026-10:

- **Caching is a prefix match, scoped to one model.** Switching the session's model throws the cache away; keep the session on one model and send other work to subagents and CLIs.
- **On a subscription, cache entries live 1 hour** (5 minutes once you're drawing on usage credits). Every read refreshes the timer, and an idle gap longer than that re-sends the whole context at write price (2×). Reads are cheap (0.1× input on Sonnet 5.5), but **every turn re-reads the whole conversation**.
- **A fresh subagent never shares your cache** and starts with its own small one. **A fork does share it**, but carries your full history at your model's price.
- **External CLIs are always cold.** Write tight, self-contained briefs, and point at file paths rather than pasting content.
- **Every subagent and CLI call counts against limits.** The Claude ones share the session's 5-hour and weekly windows; external ones draw on their vendor's plan. Agent teams cost about 7× a normal session, so don't use them without being asked.

What follows from these facts: cost is driven by **how much context each piece carries and how many driver turns it takes**. To keep both down:
- dispatch parallel work in one turn;
- have workers report in the fixed format;
- read only the changed parts of diffs, not whole files;
- push reading and doing into the pool.

## Worker protocol

1. **The driver writes each brief**, using `references/brief-template.md`:
   - the goal;
   - the files in scope and what is out of scope (no skipped tests, no weakened assertions, files not to touch);
   - the cause or intended change, if known;
   - an **acceptance check** you can verify;
   - the report format.
2. **Workers stop and report, not improvise**, when what they find doesn't match the brief.
3. **Parallel workers get disjoint files or their own git worktrees** (`git worktree add ../<name> -b <branch>`).
4. **Check every result before building on it:** read the diff and rerun the check; don't trust the summary.
5. **Report format** (all workers): `STATUS: done | blocked | partial`, then the files changed, `git diff --stat`, the acceptance check's command and actual output, and anything unsure, in ≤ 150 words. The `agent-router:*` agents already use it; ask external CLIs for it in the brief.

## Delegating to an external CLI

- **Run from the repo directory.** Give implementers (Luna, DeepSeek, Mimo) their own worktree when they edit files; run reviewers read-only where the CLI supports it.
- **Limit reviews to the diff plus the files it touches.** It is cheaper on their plan, and the review stays sharper.
- **Capture the output to a file** and read it from there. Don't stream a long transcript into your own context.
- **Verify before you trust.** Pool output is a draft until it's checked.
- **Never send secrets**: API keys, tokens, `.env*` files, `auth.json`, credential stores, or personal data. Any other code or content may go to any model on the roster.
- **Don't ask permission for routine delegation within these rules.** Log it instead.

## Choosing skills and plugins

- **Before starting a task, scan the available skills list** and load any skill whose description fits before acting. Skills hold known-good procedures, and skipping one means re-deriving it, usually worse.
- **Prefer a CLI over an MCP tool** when both can do the job; a CLI adds less to context.
- **Give subagents the skills they need** (name them in the brief) rather than loading those skills into your own context.
- **If you've done the same multi-step procedure twice**, tell the user it could become a skill.

## Effort

| Model | Effort |
|---|---|
| Sonnet 5.5 (driver) | **xhigh** (the user's choice) |
| Opus 5.5 (approver, heavy reasoning) | high |
| Haiku 5.5 | **xhigh** for fixes and edits (worker); low for running commands (runner) |
| Sonnet 5.5 (sub-lead) | high |
| GPT-6 Luna | xhigh |
| GPT-6.1 Sol | high |
| Grok 4.7 | default |

## Routing log

End every substantial task with a short **Routing log** listing each delegation, Opus gates included, in this form:

`who (model, effort) — what for — rough size — outcome (approved / revised / accepted / fixed / redone / escalated)`

Skip it when nothing was delegated.

If `~/.agent-router/` exists, also append one JSON line per delegation to `~/.agent-router/ledger.jsonl`:

`{"date", "task", "who", "effort", "purpose", "size", "outcome"}`

This is how the user measures whether the routing is paying off.
