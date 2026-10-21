import type { Keyspace } from "../keyspace.js";
import { define, type CommandTable } from "../registry.js";
import { RedisError, SYNTAX } from "../types.js";
import { globToRegExp, parseIntArg } from "../util.js";
import { shuffle } from "./hashes.js";
import { scanSlice } from "./keys.js";

const set = (db: Keyspace, k: string) => db.getTyped(k, "set")?.value;

function combine(db: Keyspace, keys: string[], op: "inter" | "union" | "diff"): Set<string> {
  const sets = keys.map((k) => set(db, k) ?? new Set<string>());
  const [first, ...rest] = sets;
  if (op === "union") return new Set(sets.flatMap((s) => [...s]));
  if (op === "inter") return new Set([...first!].filter((m) => rest.every((s) => s.has(m))));
  return new Set([...first!].filter((m) => !rest.some((s) => s.has(m))));
}

function store(db: Keyspace, dst: string, s: Set<string>): number {
  db.delete(dst);
  if (s.size) db.set(dst, { type: "set", value: s });
  return s.size;
}

export function registerSets(t: CommandTable): void {
  define(t, "SADD", -3, ({ db }, a) => {
    const s = db.getOrCreate(a[0]!, "set").value;
    let n = 0;
    for (const m of a.slice(1)) if (!s.has(m)) { s.add(m); n++; }
    return n;
  }, true);
  define(t, "SREM", -3, ({ db }, a) => {
    const s = set(db, a[0]!);
    if (!s) return 0;
    let n = 0;
    for (const m of a.slice(1)) if (s.delete(m)) n++;
    db.cleanup(a[0]!);
    return n;
  }, true);
  define(t, "SMEMBERS", 2, ({ db }, a) => [...(set(db, a[0]!) ?? [])].sort());
  define(t, "SISMEMBER", 3, ({ db }, a) => (set(db, a[0]!)?.has(a[1]!) ? 1 : 0));
  define(t, "SMISMEMBER", -3, ({ db }, a) => { const s = set(db, a[0]!); return a.slice(1).map((m) => (s?.has(m) ? 1 : 0)); });
  define(t, "SCARD", 2, ({ db }, a) => set(db, a[0]!)?.size ?? 0);
  define(t, "SPOP", -2, ({ db }, a) => {
    const s = set(db, a[0]!);
    if (a.length > 2) throw new RedisError(SYNTAX);
    if (a.length === 2) {
      const n = parseIntArg(a[1]!, "ERR value is out of range, must be positive");
      if (n < 0) throw new RedisError("ERR value is out of range, must be positive");
      if (!s) return [];
      const picked = shuffle([...s]).slice(0, n);
      for (const m of picked) s.delete(m);
      db.cleanup(a[0]!);
      return picked;
    }
    if (!s) return null;
    const [m] = shuffle([...s]);
    s.delete(m!);
    db.cleanup(a[0]!);
    return m!;
  }, true);
  define(t, "SRANDMEMBER", -2, ({ db }, a) => {
    const members = [...(set(db, a[0]!) ?? [])];
    if (a.length === 1) return members.length ? members[Math.floor(Math.random() * members.length)]! : null;
    const n = parseIntArg(a[1]!);
    if (n >= 0) return shuffle(members).slice(0, n);
    return members.length ? Array.from({ length: -n }, () => members[Math.floor(Math.random() * members.length)]!) : [];
  });
  define(t, "SINTER", -2, ({ db }, a) => [...combine(db, a, "inter")].sort());
  define(t, "SUNION", -2, ({ db }, a) => [...combine(db, a, "union")].sort());
  define(t, "SDIFF", -2, ({ db }, a) => [...combine(db, a, "diff")].sort());
  define(t, "SINTERCARD", -3, ({ db }, a) => {
    const n = parseIntArg(a[0]!);
    const keys = a.slice(1, 1 + n);
    let limit = 0;
    if (a[1 + n]?.toUpperCase() === "LIMIT") limit = parseIntArg(a[2 + n]!);
    const size = combine(db, keys, "inter").size;
    return limit ? Math.min(limit, size) : size;
  });
  define(t, "SINTERSTORE", -3, ({ db }, a) => store(db, a[0]!, combine(db, a.slice(1), "inter")), true);
  define(t, "SUNIONSTORE", -3, ({ db }, a) => store(db, a[0]!, combine(db, a.slice(1), "union")), true);
  define(t, "SDIFFSTORE", -3, ({ db }, a) => store(db, a[0]!, combine(db, a.slice(1), "diff")), true);
  define(t, "SMOVE", 4, ({ db }, a) => {
    const s = set(db, a[0]!);
    set(db, a[1]!);
    if (!s || !s.has(a[2]!)) return 0;
    s.delete(a[2]!);
    db.cleanup(a[0]!);
    db.getOrCreate(a[1]!, "set").value.add(a[2]!);
    return 1;
  }, true);
  define(t, "SSCAN", -3, ({ db }, a) => {
    const cursor = parseIntArg(a[1]!, "ERR invalid cursor");
    let match: RegExp | undefined, count = 10;
    for (let i = 2; i < a.length; i++) {
      const u = a[i]!.toUpperCase();
      if (u === "MATCH" && i + 1 < a.length) match = globToRegExp(a[++i]!);
      else if (u === "COUNT" && i + 1 < a.length) count = parseIntArg(a[++i]!);
      else throw new RedisError(SYNTAX);
    }
    return scanSlice([...(set(db, a[0]!) ?? [])].sort(), cursor, count, (k) => !match || match.test(k));
  });
}
