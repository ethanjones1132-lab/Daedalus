/** Discord delivery vertical.
 *
 * The bot token is injected by the native secret boundary at construction
 * time. This module never accepts a token from a React request and never
 * writes it into a delivery receipt.
 */

import { Database } from "bun:sqlite";
import { homedir } from "os";
import { dirname, join } from "path";
import { mkdirSync } from "fs";

export interface DeliveryReceipt {
  message_id: string;
  channel: "discord";
  direction: "outbound";
  status: "queued" | "delivered" | "failed";
  retry_count: number;
  error_code?: string;
  correlation_id: string;
  finished_at: string;
}

export interface DiscordSendRequest {
  text: string;
  correlation_id: string;
}

export interface DiscordReceiptStore {
  persist(receipt: DeliveryReceipt): Promise<void> | void;
}

export class SqliteDeliveryReceiptStore implements DiscordReceiptStore {
  private readonly dbPath: string;
  private memoryDb: Database | null = null;
  constructor(dbPath = join(homedir(), ".openclaw", "jarvis", "server-state.db")) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      try { mkdirSync(dirname(dbPath), { recursive: true }); } catch { /* best effort */ }
    }
  }

  private open(): Database {
    if (this.dbPath === ":memory:") {
      if (!this.memoryDb) this.memoryDb = new Database(":memory:");
      return this.memoryDb;
    }
    return new Database(this.dbPath, { create: true });
  }

  private close(db: Database): void {
    if (this.dbPath !== ":memory:") db.close();
  }

  persist(receipt: DeliveryReceipt): void {
    const db = this.open();
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS delivery_receipts (
        message_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_count INTEGER NOT NULL,
        error_code TEXT,
        correlation_id TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        PRIMARY KEY (channel, correlation_id)
      )`);
      db.query(`INSERT INTO delivery_receipts
        (message_id, channel, direction, status, retry_count, error_code, correlation_id, finished_at)
        VALUES ($message_id, $channel, $direction, $status, $retry_count, $error_code, $correlation_id, $finished_at)
        ON CONFLICT(channel, correlation_id) DO UPDATE SET
          message_id=excluded.message_id, status=excluded.status,
          retry_count=excluded.retry_count, error_code=excluded.error_code,
          finished_at=excluded.finished_at`).run({
            $message_id: receipt.message_id,
            $channel: receipt.channel,
            $direction: receipt.direction,
            $status: receipt.status,
            $retry_count: receipt.retry_count,
            $error_code: receipt.error_code ?? null,
            $correlation_id: receipt.correlation_id,
            $finished_at: receipt.finished_at,
          });
    } finally {
      this.close(db);
    }
  }

  list(limit = 50): DeliveryReceipt[] {
    const db = this.open();
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS delivery_receipts (
        message_id TEXT NOT NULL, channel TEXT NOT NULL, direction TEXT NOT NULL,
        status TEXT NOT NULL, retry_count INTEGER NOT NULL, error_code TEXT,
        correlation_id TEXT NOT NULL, finished_at TEXT NOT NULL,
        PRIMARY KEY (channel, correlation_id))`);
      return db.query(`SELECT message_id, channel, direction, status, retry_count,
        error_code, correlation_id, finished_at FROM delivery_receipts
        ORDER BY finished_at DESC LIMIT $limit`).all({ $limit: Math.max(1, Math.min(500, limit)) }) as DeliveryReceipt[];
    } finally {
      this.close(db);
    }
  }
}

export interface DiscordAdapterOptions {
  token: string;
  channelId: string;
  fetchImpl?: typeof fetch;
  receiptStore?: DiscordReceiptStore;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 120);
  return "discord_delivery_failed";
}

export function createDiscordAdapter(options: DiscordAdapterOptions) {
  if (!options.token.trim()) throw new Error("discord_token_required");
  if (!options.channelId.trim()) throw new Error("discord_channel_required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
  const retryDelayMs = Math.max(0, Math.min(5000, options.retryDelayMs ?? 250));

  return {
    async send(request: DiscordSendRequest): Promise<DeliveryReceipt> {
      if (!request.text.trim()) throw new Error("discord_message_required");
      let retryCount = 0;
      let failure = "discord_delivery_failed";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const response = await fetchImpl(
            `https://discord.com/api/v10/channels/${encodeURIComponent(options.channelId)}/messages`,
            {
              method: "POST",
              headers: {
                Authorization: `Bot ${options.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ content: request.text }),
            },
          );
          if (response.ok) {
            const body = (await response.json().catch(() => ({}))) as { id?: string };
            const receipt: DeliveryReceipt = {
              message_id: body.id ?? `discord-${crypto.randomUUID()}`,
              channel: "discord",
              direction: "outbound",
              status: "delivered",
              retry_count: retryCount,
              correlation_id: request.correlation_id,
              finished_at: new Date().toISOString(),
            };
            await options.receiptStore?.persist(receipt);
            return receipt;
          }
          failure = `discord_http_${response.status}`;
          if (!isTransientStatus(response.status)) break;
        } catch (error) {
          failure = errorCode(error);
        }
        if (attempt < maxAttempts) {
          retryCount++;
          if (retryDelayMs) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
      const receipt: DeliveryReceipt = {
        message_id: "",
        channel: "discord",
        direction: "outbound",
        status: "failed",
        retry_count: retryCount,
        error_code: failure,
        correlation_id: request.correlation_id,
        finished_at: new Date().toISOString(),
      };
      await options.receiptStore?.persist(receipt);
      return receipt;
    },
  };
}
