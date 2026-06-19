---
name: jarvis-tauri-listen-race
description: Recurring chat-spam bug pattern in the React UI from async Tauri listen() + bad effect deps
metadata:
  type: feedback
---

In src-ui, registering Tauri `listen('jarvis://…')` inside a `useEffect` whose deps include a value that changes during streaming (e.g. `companion`, or worst case `streamedText` which updates every token) causes the effect to re-run mid-stream. Because `listen()` is async, the cleanup `unsub.forEach(f => f())` runs before the unlisten promises resolve, so old listeners are never removed → duplicate listeners accumulate → every token gets re-appended = **chat spam**.

This bit twice: ChatPanel (deps had `companion`/`sessionId`) and PrizePicksPanel (deps had `[streamedText]` — a prior model added it to fix a stale-closure in the `done` handler and thereby caused the spam). Both fixed 2026-06-14.

**Why:** async listen() + dependency that mutates per-token = re-subscribe storm with a racing cleanup.

**How to apply:** Register jarvis:// listeners ONCE on mount (stable/`[]` deps). Read mutable values (sessionId, companion, latest streamed text) via refs synced in a tiny `useEffect`. Make unlisten race-safe: `let disposed=false; const track=p=>p.then(f=>disposed?f():arr.push(f)); return ()=>{disposed=true; arr.forEach(f=>f());}`. Filter handlers by `e.payload.session_id`. See [[jarvis-streaming-architecture]].
