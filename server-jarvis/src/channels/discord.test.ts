import { describe, expect, test } from "bun:test";
import { createDiscordAdapter, SqliteDeliveryReceiptStore, type DeliveryReceipt } from "./discord";

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
