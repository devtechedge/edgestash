import type { RedisEngine } from "./engine.js";
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
  private async runNow(commands: string[][], atomic: boolean): Promise<CommandResult[]> {
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
