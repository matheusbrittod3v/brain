import net from "node:net";
import type { RetrievalCacheBackend } from "./sql-retrieval.js";

function encodeRespCommand(args: string[]): string {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const byteLen = Buffer.byteLength(arg, "utf8");
    parts.push(`$${byteLen}\r\n${arg}\r\n`);
  }
  return parts.join("");
}

function parseRespReply(buffer: Buffer): { value: string | number | Array<string | null> | null; consumed: number } | undefined {
  const text = buffer.toString("utf8");
  const firstCrlf = text.indexOf("\r\n");
  if (firstCrlf === -1) return undefined;
  const prefix = text[0];
  const line = text.slice(1, firstCrlf);
  if (prefix === "+" || prefix === ":") {
    const consumed = Buffer.byteLength(text.slice(0, firstCrlf + 2), "utf8");
    return { value: prefix === ":" ? Number(line) : line, consumed };
  }
  if (prefix === "-") {
    throw new Error(`Valkey error: ${line}`);
  }
  if (prefix === "$") {
    const len = Number(line);
    if (len === -1) {
      return { value: null, consumed: Buffer.byteLength(text.slice(0, firstCrlf + 2), "utf8") };
    }
    const headerBytes = Buffer.byteLength(text.slice(0, firstCrlf + 2), "utf8");
    if (buffer.length < headerBytes + len + 2) return undefined;
    const payload = buffer.subarray(headerBytes, headerBytes + len).toString("utf8");
    return { value: payload, consumed: headerBytes + len + 2 };
  }
  if (prefix === "*") {
    const count = Number(line);
    if (count === -1) {
      return { value: null, consumed: Buffer.byteLength(text.slice(0, firstCrlf + 2), "utf8") };
    }
    let offset = Buffer.byteLength(text.slice(0, firstCrlf + 2), "utf8");
    const items: Array<string | null> = [];
    for (let i = 0; i < count; i += 1) {
      const sub = parseRespReply(buffer.subarray(offset));
      if (!sub) return undefined;
      items.push(typeof sub.value === "string" || sub.value === null ? sub.value : String(sub.value));
      offset += sub.consumed;
    }
    return { value: items, consumed: offset };
  }
  throw new Error(`Unsupported RESP prefix: ${prefix}`);
}

export class ValkeyRetrievalCache implements RetrievalCacheBackend {
  private readonly host: string;
  private readonly port: number;
  private readonly password?: string;
  private readonly timeoutMs: number;

  constructor(url: string, options: { timeoutMs?: number } = {}) {
    const parsed = new URL(url);
    this.host = parsed.hostname || "127.0.0.1";
    this.port = Number(parsed.port || 6379);
    this.password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    this.timeoutMs = options.timeoutMs ?? 500;
  }

  private async exec(commands: string[][]): Promise<Array<string | number | Array<string | null> | null>> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const results: Array<string | number | Array<string | null> | null> = [];
      let buffer = Buffer.alloc(0);
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(results);
      };

      socket.setTimeout(this.timeoutMs, () => finish(new Error("Valkey connection timeout")));
      socket.on("error", (err) => finish(err));
      socket.on("connect", () => {
        const queue = this.password ? [["AUTH", this.password], ...commands] : commands;
        const payload = queue.map((cmd) => encodeRespCommand(cmd)).join("");
        socket.write(payload);
      });
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const expectedCount = this.password ? commands.length + 1 : commands.length;
        try {
          while (results.length < expectedCount) {
            const parsed = parseRespReply(buffer);
            if (!parsed) break;
            results.push(parsed.value);
            buffer = buffer.subarray(parsed.consumed);
          }
          if (results.length >= expectedCount) {
            finish();
          }
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async get(key: string): Promise<string | null> {
    try {
      const replies = await this.exec([["GET", key]]);
      const val = replies[this.password ? 1 : 0];
      return typeof val === "string" ? val : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.exec([["SET", key, value, "EX", String(Math.max(1, Math.ceil(ttlSeconds)))]]);
    } catch {
      // Fail-open cache write
    }
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    try {
      const replies = await this.exec([["DEL", ...keys]]);
      const val = replies[this.password ? 1 : 0];
      return typeof val === "number" ? val : 0;
    } catch {
      return 0;
    }
  }

  async invalidateByPrefix(prefix: string): Promise<void> {
    try {
      const replies = await this.exec([["KEYS", `${prefix}*`]]);
      const keys = replies[this.password ? 1 : 0];
      if (Array.isArray(keys)) {
        const validKeys = keys.filter((k): k is string => typeof k === "string" && k.length > 0);
        if (validKeys.length > 0) {
          await this.del(...validKeys);
        }
      }
    } catch {
      // Fail-open cache invalidation
    }
  }
}

