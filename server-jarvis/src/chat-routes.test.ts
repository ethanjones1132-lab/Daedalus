import { describe, expect, mock, test } from "bun:test";
import { handleChatStreamRequest } from "./chat-routes";

describe("chat stream request route", () => {
  test("forwards the exact request lifetime signal to the Session stream", async () => {
    const stream = mock(async () => new Response("data: {\"type\":\"message_stop\"}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const request = new Request("http://jarvis.local/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "inspect the Session",
        session_id: "session-1",
        history: [{ role: "user", content: "prior turn" }],
        surface: "chat",
      }),
      signal: new AbortController().signal,
    });

    const response = await handleChatStreamRequest(request, {
      stream,
      createSessionId: () => "generated-session",
    });

    expect(response?.status).toBe(200);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledWith("inspect the Session", "session-1", {
      config: undefined,
      history: [{ role: "user", content: "prior turn" }],
      systemPromptOverride: undefined,
      surface: "chat",
      requestSignal: request.signal,
    });
  });

  test("uses a generated Session id without forwarding a signal for other routes", async () => {
    const stream = mock(async () => new Response(null, { status: 204 }));
    const request = new Request("http://jarvis.local/chat/other", {
      method: "POST",
      body: "{}",
    });

    const response = await handleChatStreamRequest(request, {
      stream,
      createSessionId: () => "generated-session",
    });

    expect(response).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });
});
