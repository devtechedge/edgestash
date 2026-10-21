import { connect, type Socket } from "node:net";
import { RedisError, Status, type Reply } from "./types.js";

/** Encode a command as a RESP2 array of bulk strings. */
export function encodeCommand(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(a);
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

type Parsed = { value: Reply | RedisError; next: number } | null;

/** Incremental RESP2 parser. Returns null when more bytes are needed. */
export function parseReply(buf: Buffer, pos = 0): Parsed {
  if (pos >= buf.length) return null;
  const end = buf.indexOf("\r\n", pos);
  if (end < 0) return null;
  const type = String.fromCharCode(buf[pos]!);
  const line = buf.toString("utf8", pos + 1, end);
  const after = end + 2;
  switch (type) {
    case "+": return { value: new Status(line), next: after };
    case "-": return { value: new RedisError(line), next: after };
    case ":": {
      const n = BigInt(line);
      return { value: n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n, next: after };
    }
    case "$": {
      const len = Number(line);
      if (len < 0) return { value: null, next: after };
      if (buf.length < after + len + 2) return null;
      return { value: buf.toString("utf8", after, after + len), next: after + len + 2 };
    }
    case "*": {
      const n = Number(line);
      if (n < 0) return { value: null, next: after };
      const out: Reply[] = [];
      let p = after;
      for (let i = 0; i < n; i++) {
        const r = parseReply(buf, p);
        if (!r) return null;
        // Errors nested in arrays (EXEC) are kept as error objects by the caller.
        out.push(r.value as Reply);
        p = r.next;
      }
      return { value: out, next: p };
    }
    default:
      throw new Error(`Unsupported RESP type byte ${type}`);
  }
}

/** Minimal pipelining Redis client used for the proxy backend and differential tests. */
export class RespClient {
  private socket: Socket;
  private buf: Buffer = Buffer.alloc(0);
  private queue: Array<{ resolve: (v: Reply | RedisError) => void; reject: (e: Error) => void }> = [];
  private ready: Promise<void>;

  constructor(url: string) {
    const u = new URL(url);
    this.socket = connect({ host: u.hostname || "127.0.0.1", port: Number(u.port || 6379) });
    this.ready = new Promise((res, rej) => {
      this.socket.once("connect", () => res());
      this.socket.once("error", rej);
    });
    this.socket.on("data", (d: Buffer) => this.onData(d));
    this.socket.on("error", (e) => { for (const q of this.queue.splice(0)) q.reject(e); });
    if (u.password) void this.send(["AUTH", ...(u.username ? [decodeURIComponent(u.username)] : []), decodeURIComponent(u.password)]);
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let pos = 0;
    for (;;) {
      const r = parseReply(this.buf, pos);
      if (!r) break;
      pos = r.next;
      this.queue.shift()?.resolve(r.value);
    }
    this.buf = this.buf.subarray(pos);
  }

  async send(args: string[]): Promise<Reply | RedisError> {
    await this.ready;
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.socket.write(encodeCommand(args));
    });
  }

  close(): void {
    this.socket.end();
  }
}
