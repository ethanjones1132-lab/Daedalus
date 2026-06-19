---
name: jarvis-model-profiles
description: How Jarvis model profiles work — two systems, and applyProfile is the bridge from DB profiles to the running config
metadata:
  type: project
---

There are TWO profile concepts; don't confuse them:
1. **DB `model_profiles` table** (src-tauri/src/commands/models.rs `ModelProfile` struct: id/name/provider/model/api_base/api_key/.../is_active/**engine**). This is what `ModelProfilesView.tsx` manages (list/get/set_active/create_profile). Authoritative for the UI.
2. **Config `cfg.profiles` Record + `cfg.active_profile`** (server-jarvis/config.ts + src-tauri/jarvis/types.rs `ModelProfile`: name/model_id/context_window/gpu_layers/... — Ollama tuning presets). streamJarvis sees `cfg`.

**The bridge is `applyProfile()` in ModelProfilesView.tsx.** On switch it: `set_active_profile(id)` (DB is_active) → `applyProfile(config, profile)` maps the DB profile into the running config (`active_backend`, ollama/openrouter `model`+`base_url`+`api_key`, `active_profile = profile.name`) → `save_jarvis_config`. So a DB profile's `provider`/`model` reach inference only through applyProfile writing them into `cfg.ollama`/`cfg.openrouter`. `cfg.profiles[active_profile]` is often undefined (names rarely match the tuning-preset keys) — don't read model from there.

Added 2026-06-15: DB profiles have an **`engine` field** (`native` | `claude_cli`), orthogonal to `provider`. applyProfile maps `engine==='claude_cli'` → `active_backend='claude_cli'` and sets `cfg.claude_cli.model = profile.model`; the claude_cli path reads `cfg.claude_cli.model` and the proxy routes it (namespaced id → OpenRouter, bare → Ollama). See [[jarvis-streaming-architecture]]. Engine column migration: `add_column_if_missing` in db/migrations.rs run_migrations.
