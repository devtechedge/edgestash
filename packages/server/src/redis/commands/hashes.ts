import { define, type CommandTable } from "../registry.js";
import { OK, RedisError, SYNTAX, wrongArgs } from "../types.js";
import { formatFloat, globToRegExp, inRange64, parseFloatArg, parseInt64, parseIntArg } from "../util.js";
import { scanSlice } from "./keys.js";

export function registerHashes(t: CommandTable): void {
  const hset = (name: string, reply: "count" | "ok") => (c: { db: import("../keyspace.js").Keyspace }, a: string[]) => {
    if (a.length < 3 || a.length % 2 === 0) throw wrongArgs(name);
    const h = c.db.getOrCreate(a[0]!, "hash").value;
    let added = 0;
    for (let i = 1; i < a.length; i += 2) {
      if (!h.has(a[i]!)) added++;
      h.set(a[i]!, a[i + 1]!);
    }
    return reply === "ok" ? OK : added;
  };
  define(t, "HSET", -4, hset("hset", "count"), true);
  define(t, "HMSET", -4, hset("hmset", "ok"), true);
  define(t, "HSETNX", 4, ({ db }, a) => {
    const h = db.getOrCreate(a[0]!, "hash").value;
    if (h.has(a[1]!)) return 0;
    h.set(a[1]!, a[2]!);
    return 1;
  }, true);
  define(t, "HGET", 3, ({ db }, a) => db.getTyped(a[0]!, "hash")?.value.get(a[1]!) ?? null);
  define(t, "HMGET", -3, ({ db }, a) => {
    const h = db.getTyped(a[0]!, "hash")?.value;
    return a.slice(1).map((f) => h?.get(f) ?? null);
  });
  define(t, "HGETALL", 2, ({ db }, a) => {
    const h = db.getTyped(a[0]!, "hash")?.value;
    return h ? [...h].flat() : [];
  });
  define(t, "HKEYS", 2, ({ db }, a) => [...(db.getTyped(a[0]!, "hash")?.value.keys() ?? [])]);
  define(t, "HVALS", 2, ({ db }, a) => [...(db.getTyped(a[0]!, "hash")?.value.values() ?? [])]);
  define(t, "HLEN", 2, ({ db }, a) => db.getTyped(a[0]!, "hash")?.value.size ?? 0);
  define(t, "HEXISTS", 3, ({ db }, a) => (db.getTyped(a[0]!, "hash")?.value.has(a[1]!) ? 1 : 0));
  define(t, "HSTRLEN", 3, ({ db }, a) => Buffer.byteLength(db.getTyped(a[0]!, "hash")?.value.get(a[1]!) ?? ""));
  define(t, "HDEL", -3, ({ db }, a) => {
    const h = db.getTyped(a[0]!, "hash")?.value;
    if (!h) return 0;
    let n = 0;
    for (const f of a.slice(1)) if (h.delete(f)) n++;
    db.cleanup(a[0]!);
    return n;
  }, true);
  define(t, "HINCRBY", 4, ({ db }, a) => {
    const by = parseInt64(a[2]!);
    const e = db.getTyped(a[0]!, "hash");
    const curRaw = e?.value.get(a[1]!);
    const cur = curRaw === undefined ? 0n : parseInt64(curRaw, "ERR hash value is not an integer");
    const next = cur + by;
    if (!inRange64(next)) throw new RedisError("ERR increment or decrement would overflow");
    db.getOrCreate(a[0]!, "hash").value.set(a[1]!, next.toString());
    return next;
  }, true);
  define(t, "HINCRBYFLOAT", 4, ({ db }, a) => {
    const by = parseFloatArg(a[2]!);
    const curRaw = db.getTyped(a[0]!, "hash")?.value.get(a[1]!);
    const cur = curRaw === undefined ? 0 : parseFloatArg(curRaw, "ERR hash value is not a float");
    const next = cur + by;
    if (!Number.isFinite(next)) throw new RedisError("ERR increment would produce NaN or Infinity");
    const s = formatFloat(next);
    db.getOrCreate(a[0]!, "hash").value.set(a[1]!, s);
    return s;
  }, true);
  define(t, "HRANDFIELD", -2, ({ db }, a) => {
    const h = db.getTyped(a[0]!, "hash")?.value;
    const keys = [...(h?.keys() ?? [])];
    if (a.length === 1) return keys.length ? keys[Math.floor(Math.random() * keys.length)]! : null;
    const n = parseIntArg(a[1]!);
    const withValues = a[2]?.toUpperCase() === "WITHVALUES";
    const picked = n >= 0 ? shuffle(keys).slice(0, n) : Array.from({ length: keys.length ? -n : 0 }, () => keys[Math.floor(Math.random() * keys.length)]!);
    return withValues ? picked.flatMap((k) => [k, h!.get(k)!]) : picked;
  });
  define(t, "HSCAN", -3, ({ db }, a) => {
    const cursor = parseIntArg(a[1]!, "ERR invalid cursor");
    let match: RegExp | undefined, count = 10, novalues = false;
    for (let i = 2; i < a.length; i++) {
      const u = a[i]!.toUpperCase();
      if (u === "MATCH" && i + 1 < a.length) match = globToRegExp(a[++i]!);
      else if (u === "COUNT" && i + 1 < a.length) count = parseIntArg(a[++i]!);
      else if (u === "NOVALUES") novalues = true;
      else throw new RedisError(SYNTAX);
    }
    const h = db.getTyped(a[0]!, "hash")?.value ?? new Map<string, string>();
    const [next, fields] = scanSlice([...h.keys()].sort(), cursor, count, (k) => !match || match.test(k));
    return [next, novalues ? fields : fields.flatMap((f) => [f, h.get(f)!])];
  });
}

export function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
