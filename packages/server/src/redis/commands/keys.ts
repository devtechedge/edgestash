import { define, type CommandTable } from "../registry.js";
import { OK, RedisError, Status, SYNTAX, type Entry } from "../types.js";
import { globToRegExp, parseInt64, parseIntArg } from "../util.js";

function cloneEntry(e: Entry): Entry {
  switch (e.type) {
    case "string": return { ...e };
    case "hash": return { ...e, value: new Map(e.value) };
    case "list": return { ...e, value: [...e.value] };
    case "set": return { ...e, value: new Set(e.value) };
    case "zset": return { ...e, value: new Map(e.value) };
  }
}

/** Shared implementation of EXPIRE/PEXPIRE/EXPIREAT/PEXPIREAT with NX XX GT LT flags. */
function expireGeneric(db: import("../keyspace.js").Keyspace, args: string[], toAbsMs: (n: bigint) => bigint): number {
  const [key, raw, ...flags] = args as [string, string, ...string[]];
  const n = parseInt64(raw);
  let nx = false, xx = false, gt = false, lt = false;
  for (const f of flags) {
    const u = f.toUpperCase();
    if (u === "NX") nx = true; else if (u === "XX") xx = true; else if (u === "GT") gt = true; else if (u === "LT") lt = true;
    else throw new RedisError(`ERR Unsupported option ${f}`);
  }
  if (nx && (xx || gt || lt)) throw new RedisError("ERR NX and XX, GT or LT options at the same time are not compatible");
  if (gt && lt) throw new RedisError("ERR GT and LT options at the same time are not compatible");
  const e = db.get(key);
  if (!e) return 0;
  const at = Number(toAbsMs(n));
  const cur = e.expireAt;
  if (nx && cur !== undefined) return 0;
  if (xx && cur === undefined) return 0;
  if (gt && (cur === undefined || at <= cur)) return 0;
  if (lt && cur !== undefined && at >= cur) return 0;
  if (at <= db.now()) { db.delete(key); return 1; }
  e.expireAt = at;
  return 1;
}

export function registerKeys(t: CommandTable): void {
  define(t, "PING", -1, (_c, a) => (a.length ? a[0]! : new Status("PONG")));
  define(t, "ECHO", 2, (_c, a) => a[0]!);
  define(t, "TIME", 1, ({ db }) => {
    const ms = db.now();
    return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)];
  });
  define(t, "DEL", -2, ({ db }, a) => a.reduce((n, k) => n + (db.delete(k) ? 1 : 0), 0), true);
  define(t, "UNLINK", -2, ({ db }, a) => a.reduce((n, k) => n + (db.delete(k) ? 1 : 0), 0), true);
  define(t, "EXISTS", -2, ({ db }, a) => a.reduce((n, k) => n + (db.has(k) ? 1 : 0), 0));
  define(t, "TOUCH", -2, ({ db }, a) => a.reduce((n, k) => n + (db.has(k) ? 1 : 0), 0));
  define(t, "TYPE", 2, ({ db }, a) => new Status(db.get(a[0]!)?.type ?? "none"));
  define(t, "EXPIRE", -3, ({ db }, a) => expireGeneric(db, a, (n) => BigInt(db.now()) + n * 1000n), true);
  define(t, "PEXPIRE", -3, ({ db }, a) => expireGeneric(db, a, (n) => BigInt(db.now()) + n), true);
  define(t, "EXPIREAT", -3, ({ db }, a) => expireGeneric(db, a, (n) => n * 1000n), true);
  define(t, "PEXPIREAT", -3, ({ db }, a) => expireGeneric(db, a, (n) => n), true);
  const ttl = (div: number) => ({ db }: { db: import("../keyspace.js").Keyspace }, a: string[]) => {
    const e = db.get(a[0]!);
    if (!e) return -2;
    if (e.expireAt === undefined) return -1;
    return div === 1 ? e.expireAt - db.now() : Math.round((e.expireAt - db.now()) / div);
  };
  define(t, "TTL", 2, ttl(1000));
  define(t, "PTTL", 2, ttl(1));
  const expTime = (div: number) => ({ db }: { db: import("../keyspace.js").Keyspace }, a: string[]) => {
    const e = db.get(a[0]!);
    if (!e) return -2;
    if (e.expireAt === undefined) return -1;
    return Math.floor(e.expireAt / div);
  };
  define(t, "EXPIRETIME", 2, expTime(1000));
  define(t, "PEXPIRETIME", 2, expTime(1));
  define(t, "PERSIST", 2, ({ db }, a) => {
    const e = db.get(a[0]!);
    if (!e || e.expireAt === undefined) return 0;
    e.expireAt = undefined;
    return 1;
  }, true);
  define(t, "KEYS", 2, ({ db }, a) => {
    const re = globToRegExp(a[0]!);
    return db.keys().filter((k) => re.test(k)).sort();
  });
  define(t, "DBSIZE", 1, ({ db }) => db.keys().length);
  define(t, "RANDOMKEY", 1, ({ db }) => {
    const ks = db.keys();
    return ks.length ? ks[Math.floor(Math.random() * ks.length)]! : null;
  });
  define(t, "FLUSHDB", -1, ({ db }) => { db.data.clear(); return OK; }, true);
  define(t, "FLUSHALL", -1, ({ db }) => { db.data.clear(); return OK; }, true);
  const rename = (nx: boolean) => ({ db }: { db: import("../keyspace.js").Keyspace }, a: string[]) => {
    const [src, dst] = a as [string, string];
    const e = db.get(src);
    if (!e) throw new RedisError("ERR no such key");
    if (src === dst) return nx ? 0 : OK;
    if (nx && db.has(dst)) return 0;
    db.data.delete(src);
    db.data.set(dst, e);
    return nx ? 1 : OK;
  };
  define(t, "RENAME", 3, rename(false), true);
  define(t, "RENAMENX", 3, rename(true), true);
  define(t, "COPY", -3, ({ db }, a) => {
    const [src, dst, ...rest] = a as [string, string, ...string[]];
    let replace = false;
    for (let i = 0; i < rest.length; i++) {
      const u = rest[i]!.toUpperCase();
      if (u === "REPLACE") replace = true;
      else if (u === "DB" && i + 1 < rest.length) { if (rest[++i] !== "0") throw new RedisError("ERR DB index is out of range"); }
      else throw new RedisError(SYNTAX);
    }
    const e = db.get(src);
    if (!e) return 0;
    if (db.has(dst) && !replace) return 0;
    db.data.set(dst, cloneEntry(e));
    return 1;
  }, true);
  define(t, "SCAN", -2, ({ db }, a) => {
    const cursor = parseIntArg(a[0]!, "ERR invalid cursor");
    let match: RegExp | undefined, count = 10, type: string | undefined;
    for (let i = 1; i < a.length; i++) {
      const u = a[i]!.toUpperCase();
      if (u === "MATCH" && i + 1 < a.length) match = globToRegExp(a[++i]!);
      else if (u === "COUNT" && i + 1 < a.length) { count = parseIntArg(a[++i]!); if (count < 1) throw new RedisError(SYNTAX); }
      else if (u === "TYPE" && i + 1 < a.length) type = a[++i]!.toLowerCase();
      else throw new RedisError(SYNTAX);
    }
    return scanSlice(db.keys().sort(), cursor, count, (k) => (!match || match.test(k)) && (!type || db.get(k)?.type === type));
  });
}

/** Cursor = offset into a sorted snapshot; stable across calls while the keyspace is unchanged. */
export function scanSlice(items: string[], cursor: number, count: number, keep: (k: string) => boolean): [string, string[]] {
  const page = items.slice(cursor, cursor + count).filter(keep);
  const next = cursor + count >= items.length ? 0 : cursor + count;
  return [String(next), page];
}
