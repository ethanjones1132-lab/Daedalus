# Memory Index

- [Windows hang root cause](windows-hang-root-cause.md) — why the Tauri app spawn-stall-crashes on Windows (AppHang→ntdll) and the wsl.exe/DB hardening that fixed it
- [Jarvis streaming architecture](jarvis-streaming-architecture.md) — chat flow + invariants (single terminal message_stop, always-strip reasoning) and the stream-emitter.ts consolidation
- [Tauri listen race](jarvis-tauri-listen-race.md) — recurring chat-spam bug from async listen() + per-token effect deps; register once on mount with refs
- [Writable repo path](home-base-writable-path.md) — write via \\wsl.localhost\ubuntu\home\ethan\... (the /mnt/wslg/distro view is read-only)
- [Model profiles](jarvis-model-profiles.md) — two profile systems (DB model_profiles vs config cfg.profiles); applyProfile is the bridge; per-profile engine field (native|claude_cli)