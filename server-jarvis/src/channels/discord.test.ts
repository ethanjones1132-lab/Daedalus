import { describe, expect, test } from "bun:test";
import { createDiscordAdapter, createDiscordSendHandler, SqliteDeliveryReceiptStore, type DeliveryReceipt } from "./discord";

describe("Discord delivery adapter", () => {
  test("retries transient failures and persists a delivered receipt", async () => {
    let attempts = 0;
    const receipts: DeliveryReceipt[] = [];
    const adapter = createDiscordAdapter({
      token: "operator-secret",
      channelId: "123",
      retryDelayMs: 0,
      receiptStore: { persist: (receipt) => receipts.push(receipt) },
      fetchImpl: async (_input, _init) => {
        attempts++;
        if (attempts === 1) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ id: "discord-message-1" }), { status: 200 });
      },
    });
    const receipt = await adapter.send({ text: "health check", correlation_id: "c1" });
    expect(receipt).toMatchObject({ status: "delivered", message_id: "discord-message-1", retry_count: 1 });
    expect(attempts).toBe(2);
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts[0])).not.toContain("operator-secret");
  });

  test("does not retry a permanent authentication failure", async () => {
    let attempts = 0;
    const adapter = createDiscordAdapter({
      token: "operator-secret",
      channelId: "123",
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts++;
        return new Response("unauthorized", { status: 401 });
      },
    });
    const receipt = await adapter.send({ text: "health check", correlation_id: "c2" });
    expect(receipt).toMatchObject({ status: "failed", retry_count: 0, error_code: "discord_http_401" });
    expect(attempts).toBe(1);
  });

  test("requires native-injected credentials and channel", () => {
    expect(() => createDiscordAdapter({ token: "", channelId: "123" })).toThrow("discord_token_required");
    expect(() => createDiscordAdapter({ token: "secret", channelId: "" })).toThrow("discord_channel_required");
  });

  test("persists receipts without storing the bot token", () => {
    const store = new SqliteDeliveryReceiptStore(":memory:");
    store.persist({
      message_id: "m1",
      channel: "discord",
      direction: "outbound",
      status: "delivered",
      retry_count: 0,
      correlation_id: "c3",
      finished_at: new Date().toISOString(),
    });
    expect(store.list()).toHaveLength(1);
    expect(JSON.stringify(store.list())).not.toContain("token");
  });
});

describe("Discord delivery route", () => {
  test("rejects a missing injected secret without attempting delivery", async () => {
    const receipts: DeliveryReceipt[] = [];
    let attempts = 0;
    const handler = createDiscordSendHandler({
      token: () => "",
      receiptStore: { persist: (receipt) => receipts.push(receipt) },
      fetchImpl: async () => {
        attempts++;
        return new Response("unexpected", { status: 200 });
      },
    });

    const response = await handler(new Request("http://jarvis.test/channels/discord/send", {
      method: "POST",
      body: JSON.stringify({ channel_id: "123", text: "verify" }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "discord_secret_unavailable" });
    expect(attempts).toBe(0);
    expect(receipts).toHaveLength(0);
  });

  test("rejects a missing destination before constructing a delivery request", async () => {
    let attempts = 0;
    const handler = createDiscordSendHandler({
      token: () => "operator-secret",
      fetchImpl: async () => {
        attempts++;
        return new Response("unexpected", { status: 200 });
      },
    });

    const response = await handler(new Request("http://jarvis.test/channels/discord/send", {
      method: "POST",
      body: JSON.stringify({ text: "verify" }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "discord_channel_required" });
    expect(attempts).toBe(0);
  });

  test("delivers the configured destination and returns a secret-free receipt", async () => {
    const receipts: DeliveryReceipt[] = [];
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const handler = createDiscordSendHandler({
      token: () => "operator-secret",
      correlationId: () => "verification-1",
      receiptStore: { persist: (receipt) => receipts.push(receipt) },
      fetchImpl: async (input, init) => {
        requests.push({ input: String(input), init });
        return new Response(JSON.stringify({ id: "discord-message-1" }), { status: 200 });
      },
    });

    const response = await handler(new Request("http://jarvis.test/channels/discord/send", {
      method: "POST",
      body: JSON.stringify({ channel_id: "123", text: "verify" }),
    }));

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({ ok: true, receipt: { status: "delivered", correlation_id: "verification-1" } });
    expect(requests).toHaveLength(1);
    expect(requests[0].input).toBe("https://discord.com/api/v10/channels/123/messages");
    expect(requests[0].init?.body).toBe(JSON.stringify({ content: "verify" }));
    expect(JSON.stringify(requests[0].init?.body)).not.toContain("operator-secret");
    expect((requests[0].init?.headers as Record<string, string>).Authorization).toBe("Bot operator-secret");
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(responseBody)).not.toContain("operator-secret");
  });

  test("returns the authoritative failed receipt without exposing provider detail", async () => {
    const receipts: DeliveryReceipt[] = [];
    const handler = createDiscordSendHandler({
      token: () => "operator-secret",
      correlationId: () => "verification-2",
      receiptStore: { persist: (receipt) => receipts.push(receipt) },
      fetchImpl: async () => new Response("private provider body", { status: 401 }),
    });

    const response = await handler(new Request("http://jarvis.test/channels/discord/send", {
      method: "POST",
      body: JSON.stringify({ channel_id: "123", text: "verify" }),
    }));

    expect(response.status).toBe(502);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({ ok: false, receipt: { status: "failed", error_code: "discord_http_401" } });
    expect(receipts[0]).toMatchObject({ status: "failed", correlation_id: "verification-2" });
    expect(JSON.stringify(responseBody)).not.toContain("private provider body");
  });
});
