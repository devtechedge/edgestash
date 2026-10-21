import type { RedisEngine } from "./engine.js";
import { createHash } from "node:crypto";
import { RespClient } from "./resp.js";
import { RedisError, type Reply } from "./types.js";

export type CommandResult = { result: Reply } | { error: string };

/** A Redis execution backend: the embedded engine or a proxied real Redis. */
export interface RedisBackend {
  readonly kind: "embedded" | "proxy";
  run(commands: string[][], atomic: boolean): Promise<CommandResult[]>;
  close?(): void;
}

export class EmbeddedBackend implements RedisBackend {
  readonly kind = "embedded";
  constructor(readonly engine: RedisEngine) {}
  async run(commands: string[][], atomic: boolean): Promise<CommandResult[]> {
    // The engine is synchronous, so a batch is naturally atomic. For multi-exec we
    // still validate every command up front like MULTI queueing does.
    if (atomic) {
      for (const c of commands) {
        const spec = this.engine.table.get((c[0] ?? "").toUpperCase());
        if (!spec) return commands.map(() => ({ error: "EXECABORT Transaction discarded because of previous errors." }));
      }
    }
    return commands.map((c) => {
      try {
        return { result: this.engine.exec(c) };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    });
  }
}

export class ProxyBackend implements RedisBackend {
  readonly kind = "proxy";
  private client: RespClient;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(url: string) {
    this.client = new RespClient(url);
  }
  run(commands: string[][], atomic: boolean): Promise<CommandResult[]> {
    // Serialise batches so MULTI blocks from different requests never interleave.
    const job = this.chain.then(() => this.runNow(commands, atomic));
    this.chain = job.catch(() => undefined);
    return job;
  }
  /** Upstash-only shebang flags that stock Redis rejects with "Unexpected flag in script shebang". */
  private static readonly UPSTASH_FLAGS = /^#!lua([^\n]*)/;
  /** Original script SHA (as computed by the SDK) to the body Redis can run. */
  private rewritten = new Map<string, string>();

  /**
   * @upstash/ratelimit scripts start with `#!lua flags=allow-key-locking`, which Upstash
   * accepts but Redis 7+ refuses. Strip unknown flags and keep EVALSHA working by mapping
   * the SDK's SHA of the original body to the rewritten script.
   */
  rewrite(cmd: string[]): string[] {
    const name = (cmd[0] ?? "").toUpperCase();
    const fix = (body: string) => {
      const m = ProxyBackend.UPSTASH_FLAGS.exec(body);
      if (!m || !/allow-key-locking/.test(m[1]!)) return body;
      const flags = m[1]!.replace(/flags=([^\s]*)/, (_x, f: string) => {
        const keep = f.split(",").filter((x) => x && x !== "allow-key-locking");
        return keep.length ? `flags=${keep.join(",")}` : "";
      });
      return body.replace(ProxyBackend.UPSTASH_FLAGS, `#!lua${flags.trimEnd()}`);
    };
    if ((name === "EVAL" || name === "EVAL_RO") && cmd[1] !== undefined) {
      const fixed = fix(cmd[1]);
      if (fixed !== cmd[1]) this.rewritten.set(createHash("sha1").update(cmd[1]).digest("hex"), fixed);
      return [cmd[0]!, fixed, ...cmd.slice(2)];
    }
    if ((name === "EVALSHA" || name === "EVALSHA_RO") && cmd[1] && this.rewritten.has(cmd[1].toLowerCase())) {
      return [name === "EVALSHA" ? "EVAL" : "EVAL_RO", this.rewritten.get(cmd[1].toLowerCase())!, ...cmd.slice(2)];
    }
    if (name === "SCRIPT" && (cmd[1] ?? "").toUpperCase() === "LOAD" && cmd[2] !== undefined) {
      const fixed = fix(cmd[2]);
      if (fixed !== cmd[2]) this.rewritten.set(createHash("sha1").update(cmd[2]).digest("hex"), fixed);
      return [cmd[0]!, cmd[1]!, fixed];
    }
    return cmd;
  }

  private async runNow(original: string[][], atomic: boolean): Promise<CommandResult[]> {
    const commands = original.map((c) => this.rewrite(c));
    const wrap = (r: Reply | RedisError): CommandResult => (r instanceof RedisError ? { error: r.message } : { result: r });
    if (!atomic) return (await Promise.all(commands.map((c) => this.client.send(c)))).map(wrap);
    const pending = [this.client.send(["MULTI"]), ...commands.map((c) => this.client.send(c)), this.client.send(["EXEC"])];
    const replies = await Promise.all(pending);
    const exec = replies[replies.length - 1]!;
    if (exec instanceof RedisError) return commands.map(() => ({ error: exec.message }));
    if (!Array.isArray(exec)) return commands.map(() => ({ error: "EXECABORT Transaction discarded" }));
    return exec.map((r) => wrap(r as Reply | RedisError));
  }
  close(): void {
    this.client.close();
  }
}
