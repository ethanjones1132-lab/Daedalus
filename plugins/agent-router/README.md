# agent-router (Claude Code plugin)

Routes each piece of work to the right model:
- **Driver:** Sonnet 5.5 at xhigh.
- **Plan approval and heavy reasoning:** Opus 5.5.
- **Workers:** Haiku 5.5, plus DeepSeek v4.1 Flash, Mimo 2.6 Flash and the Zen free models (all three through the OpenCode CLI), plus GPT-6 Luna.
- **Heavy reasoning and cross-vendor review:** GPT-6.1 Sol and Grok 4.7.

## Install

```
/plugin marketplace add ethanjones1132-lab/Daedalus
/plugin install agent-router@daedalus-tools
```

Then set the driver: `/model sonnet` and `/effort xhigh`. To make that the default, put `"model": "sonnet"` and `"effortLevel": "xhigh"` in `~/.claude/settings.json`.

## Make it trigger reliably

On its own, the skill only loads for routing and usage questions. Sonnet starts concrete coding tasks with `Bash` and never consults it. One line in `~/.claude/CLAUDE.md` fixes that: in testing it triggered 10/10 on real tasks, with 0/10 false triggers.

```
Before your first tool call on any task bigger than a quick edit or a factual question, load the agent-router skill and route the work with it.
```

## What's inside

| Component | Model / effort | Role |
|---|---|---|
| `skills/agent-router` | — | The routing playbook (loads on demand) |
| `agent-router:approver` | Opus 5.5 / high | Approves large plans; heavy reasoning (read-only tools) |
| `agent-router:worker` | Haiku 5.5 / xhigh | Implements one well-specified brief |
| `agent-router:runner` | Haiku 5.5 / low | Runs tests, builds and searches; returns a compact summary |
| `agent-router:lead` | Sonnet 5.5 / high | Sub-lead running parallel Haiku workers on a large chunk |

The external CLIs (Codex, Grok, OpenCode) are discovered on first use. Working commands are saved to `~/.agent-router/channels.md`, which every driver shares. If you create `~/.agent-router/`, delegations are also logged to `~/.agent-router/ledger.jsonl`.

Decision record: `docs/adr/000x-agent-router-skill.md`.
