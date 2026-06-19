        return;
      }
      if (code === 0) {
        // Try to parse the last JSON line for structured output
        const lines = stdout.trim().split("\n");
        let sessionId: string | undefined;
        let tokensUsed: number | undefined;

        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]);
            if (parsed.session_id) sessionId = parsed.session_id;
            if (parsed.usage) tokensUsed = (parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0);
          } catch { /* skip */ }
        }

        resolve({ success: true, output: stdout, session_id: sessionId, tokens_used: tokensUsed });
      } else {
        resolve({ success: false, output: "", error: stderr || `Claude CLI exited with code ${code}` });
      }
    });

    proc.on("error", (e) => {
      clearTimeout(timeout);
      resolve({ success: false, output: "", error: `Failed to spawn Claude CLI: ${e.message}` });
    });
  });
}

// ── Stream Invoke (yields SSE events) ──

export interface ClaudeStreamEvent {
  type: "init" | "stream_event" | "tool_use" | "tool_result" | "message_stop" | "error" | "result";
  content?: string;
  delta?: { text: string };
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_output?: string;
  session_id?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

export async function* streamClaudeCli(
  cfg: JarvisConfig,
  req: ClaudeCliRequest,
): AsyncGenerator<ClaudeStreamEvent> {
  const cliCfg = cfg.claude_cli;

  // Use provided cliArgs (which may include --append-system-prompt) or fall back to cfg defaults
  const args = buildLocalClaudeArgs([...(req.cliArgs || cliCfg.args || [])]);
  // Prompt is passed as a positional argument (not --prompt flag)
  args.push(req.prompt);

  if (req.session_id) args.push("--resume", req.session_id);
  // Note: --cwd is not a valid Claude CLI flag; cwd is set via spawn options below

  yield { type: "init", session_id: req.session_id || crypto.randomUUID() };

  // Use localhost for Ollama — Bun server runs in WSL, Claude CLI subprocess
  // also runs in WSL, so localhost reaches WSL's Ollama directly.
  // The Windows host IP is only needed for the HTTP server's own Ollama calls
  // (via resolveWindowsHostIP), not for spawned subprocesses.
  const streamEnv = buildLocalClaudeEnv();

  const resolvedPath = resolveClaudePath(cliCfg.path);
  const proc = spawn(resolvedPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: streamEnv,
    cwd: req.cwd || cliCfg.cwd,
  });

  // Close stdin immediately — CLI should use positional prompt arg, not stdin
  proc.stdin?.end();

  const decoder = new TextDecoder();
  let buffer = "";
  let fullOutput = "";

  const stdoutIterator = proc.stdout![Symbol.asyncIterator]();

  try {
    while (true) {
      const { done, value } = await stdoutIterator.next();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const msg: ClaudeCliMessage = JSON.parse(trimmed);

          switch (msg.type) {
            case "assistant": {
              // Content can be a string or an array of content blocks
              let text = "";
              if (typeof msg.content === "string") {
                text = msg.content;
              } else if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block && typeof block === "object" && block.type === "text" && block.text) {
                    text += block.text;
                  }
                }
              }
              if (text) {
                fullOutput += text;
                yield { type: "stream_event", delta: { text }, session_id: msg.session_id };
              }
              break;
            }
            case "stream_event": {
              if (msg.delta?.text) {
                fullOutput += msg.delta.text;
                yield { type: "stream_event", delta: msg.delta, session_id: msg.session_id };
              }
              break;
            }
            case "tool_use": {
              yield {
                type: "tool_use",
                tool_name: msg.tool_use?.name || "unknown",
                tool_input: msg.tool_use?.input || {},
                session_id: msg.session_id,
              };
              break;
            }
            case "tool_result": {
              yield {
                type: "tool_result",
                tool_output: msg.tool_result?.content || "",
                session_id: msg.session_id,
              };
              break;
            }
            case "result": {
              // The CLI's result event contains the full text in msg.result
              // (assistant events may have empty content strings in stream-json mode)
              const resultText = msg.result || fullOutput || "";
              yield {
                type: "result",
                content: resultText,
                session_id: msg.session_id,
                usage: msg.usage,
              };
              break;
            }
          }
        } catch {
          // Non-JSON line — treat as plain text
          if (trimmed.length > 0) {
            fullOutput += trimmed + "\n";
            yield { type: "stream_event", delta: { text: trimmed + "\n" } };
          }
        }
      }
    }

    // Check stderr for errors
    let stderr = "";