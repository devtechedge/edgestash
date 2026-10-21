import { RedisEngine } from "../src/redis/engine.js";
import { RespClient } from "../src/redis/resp.js";
import { RedisError, Status, type Reply } from "../src/redis/types.js";
import { groups, type Case } from "./cases.js";
import { fuzzCommands } from "./fuzz.js";

export interface CaseResult { group: string; cmd: string[]; ok: boolean; ours: unknown; theirs: unknown }

/** Normalise replies for comparison: statuses become strings, errors compare by their first word. */
export function norm(r: Reply | RedisError, c: Pick<Case, "unordered" | "ignoreValue">): unknown {
  if (r instanceof RedisError) return { error: r.message.split(" ")[0] };
  if (c.ignoreValue) return Array.isArray(r) ? { arrayOfLength: r.length } : { type: typeof r };
  if (r instanceof Status) return r.value;
  if (typeof r === "bigint") return r.toString();
  if (typeof r === "number") return String(r);
  if (Array.isArray(r)) {
    // SCAN-style [cursor, [items]] with unordered items
    if (c.unordered && r.length === 2 && Array.isArray(r[1]) && typeof r[0] === "string") return [r[0] === "0" ? "0" : "cursor", (r[1] as Reply[]).map((x) => norm(x, {})).sort()];
    const xs = r.map((x) => norm(x as Reply, {}));
    return c.unordered ? xs.sort() : xs;
  }
  return r;
}

export async function runDifferential(redisUrl: string, opts: { fuzzOps?: number; seed?: number } = {}): Promise<{ results: CaseResult[]; byGroup: Record<string, { pass: number; total: number }> }> {
  const client = new RespClient(redisUrl);
  const results: CaseResult[] = [];
  const all = [...groups, { name: "fuzz", cases: fuzzCommands(opts.fuzzOps ?? 2000, opts.seed ?? 42).map((cmd) => ({ cmd, unordered: /^(SMEMBERS|SINTER|SUNION|SDIFF|KEYS|HKEYS|HVALS|HGETALL)$/.test(String(cmd[0])) })) }];
  try {
    for (const g of all) {
      const engine = new RedisEngine();
      await client.send(["FLUSHALL"]);
      await client.send(["SCRIPT", "FLUSH"]);
      for (const c of g.cases) {
        const args = c.cmd.map(String);
        let ours: Reply | RedisError;
        try { ours = engine.exec(args); } catch (e) { ours = e instanceof RedisError ? e : new RedisError(String(e)); }
        const theirs = await client.send(args);
        // HGETALL-like replies are field/value pairs, so pair them before sorting.
        const pairwise = g.name === "fuzz" && args[0] === "HGETALL";
        const n1 = pairwise ? pairUp(ours) : norm(ours, c);
        const n2 = pairwise ? pairUp(theirs) : norm(theirs, c);
        results.push({ group: g.name, cmd: args, ok: JSON.stringify(n1) === JSON.stringify(n2), ours: n1, theirs: n2 });
      }
      engine.close();
    }
  } finally {
    client.close();
  }
  const byGroup: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    const g = (byGroup[r.group] ??= { pass: 0, total: 0 });
    g.total++;
    if (r.ok) g.pass++;
  }
  return { results, byGroup };
}

function pairUp(r: Reply | RedisError): unknown {
  if (!Array.isArray(r)) return norm(r, {});
  const pairs: string[] = [];
  for (let i = 0; i < r.length; i += 2) pairs.push(`${String(r[i])}=${String(r[i + 1])}`);
  return pairs.sort();
}
