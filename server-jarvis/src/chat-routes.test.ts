import { describe, expect, mock, test } from "bun:test";
import { handleChatStreamRequest } from "./chat-routes";
import { observedStageRouteSseFrame } from "./orchestration/inference-route-telemetry";

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

  test("forwards live stage route telemetry from an observed upstream response", async () => {
    const upstreamResponse = new Response("provider unavailable", { status: 503 });
    const stream = mock(async (_message: string, sessionId: string) => {
      const event = observedStageRouteSseFrame({
        response: upstreamResponse,
        sessionId,
        stage: "reviewer",
        provider: "openrouter",
        model: "review-model",
      });
      return new Response(event, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const request = new Request("http://jarvis.local/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "inspect the Session", session_id: "session-1" }),
    });

    const response = await handleChatStreamRequest(request, { stream });

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(`data: ${JSON.stringify({
      type: "stage_route",
      stage: "reviewer",
      actual_provider: "openrouter",
      actual_model: "review-model",
      session_id: "session-1",
    })}\n\n`);
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
