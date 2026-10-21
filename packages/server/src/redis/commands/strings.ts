import type { Keyspace } from "../keyspace.js";
import { define, type CommandTable } from "../registry.js";
import { NOT_INT, OK, RedisError, SYNTAX } from "../types.js";
import { formatFloat, inRange64, parseFloatArg, parseInt64, parseIntArg } from "../util.js";

const getStr = (db: Keyspace, k: string) => db.getTyped(k, "string")?.value ?? null;

function incrBy(db: Keyspace, key: string, by: bigint): bigint {
  const e = db.getTyped(key, "string");
  const cur = e ? parseInt64(e.value) : 0n;
  const next = cur + by;
  if (!inRange64(next)) throw new RedisError("ERR increment or decrement would overflow");
  if (e) e.value = next.toString();
  else db.set(key, { type: "string", value: next.toString() });
  return next;
}

function badExpire(cmd: string): RedisError {
  return new RedisError(`ERR invalid expire time in '${cmd}' command`);
}

export function registerStrings(t: CommandTable): void {
  define(t, "GET", 2, ({ db }, a) => getStr(db, a[0]!));
  define(t, "SET", -3, ({ db }, a) => {
    const [key, value, ...opts] = a as [string, string, ...string[]];
    let nx = false, xx = false, get = false, keepTtl = false;
    let expireAt: number | undefined;
    for (let i = 0; i < opts.length; i++) {
      const u = opts[i]!.toUpperCase();
      if (u === "NX" && !xx) nx = true;
      else if (u === "XX" && !nx) xx = true;
      else if (u === "GET") get = true;
      else if (u === "KEEPTTL" && expireAt === undefined) keepTtl = true;
      else if ((u === "EX" || u === "PX" || u === "EXAT" || u === "PXAT") && i + 1 < opts.length && expireAt === undefined && !keepTtl) {
        const n = parseIntArg(opts[++i]!);
        if (n <= 0) throw badExpire("set");
        expireAt = u === "EX" ? db.now() + n * 1000 : u === "PX" ? db.now() + n : u === "EXAT" ? n * 1000 : n;
      } else throw new RedisError(SYNTAX);
    }
    const prev = get ? getStr(db, key) : null;
    const exists = db.has(key);
    if ((nx && exists) || (xx && !exists)) return get ? prev : null;
    db.set(key, { type: "string", value }, keepTtl);
    if (expireAt !== undefined) db.get(key)!.expireAt = expireAt;
    return get ? prev : OK;
  }, true);
  define(t, "SETNX", 3, ({ db }, a) => {
    if (db.has(a[0]!)) return 0;
    db.set(a[0]!, { type: "string", value: a[1]! });
    return 1;
  }, true);
  const setex = (mul: number, name: string) => ({ db }: { db: Keyspace }, a: string[]) => {
    const n = parseIntArg(a[1]!);
    if (n <= 0) throw badExpire(name);
    db.set(a[0]!, { type: "string", value: a[2]! });
    db.get(a[0]!)!.expireAt = db.now() + n * mul;
    return OK;
  };
  define(t, "SETEX", 4, setex(1000, "setex"), true);
  define(t, "PSETEX", 4, setex(1, "psetex"), true);
  define(t, "MGET", -2, ({ db }, a) => a.map((k) => {
    const e = db.get(k);
    return e && e.type === "string" ? e.value : null;
  }));
  define(t, "MSET", -3, ({ db }, a) => {
    if (a.length % 2) throw new RedisError("ERR wrong number of arguments for 'mset' command");
    for (let i = 0; i < a.length; i += 2) db.set(a[i]!, { type: "string", value: a[i + 1]! });
    return OK;
  }, true);
  define(t, "MSETNX", -3, ({ db }, a) => {
    if (a.length % 2) throw new RedisError("ERR wrong number of arguments for 'msetnx' command");
    for (let i = 0; i < a.length; i += 2) if (db.has(a[i]!)) return 0;
    for (let i = 0; i < a.length; i += 2) db.set(a[i]!, { type: "string", value: a[i + 1]! });
    return 1;
  }, true);
  define(t, "GETSET", 3, ({ db }, a) => {
    const prev = getStr(db, a[0]!);
    db.set(a[0]!, { type: "string", value: a[1]! });
    return prev;
  }, true);
  define(t, "GETDEL", 2, ({ db }, a) => {
    const prev = getStr(db, a[0]!);
    if (prev !== null) db.delete(a[0]!);
    return prev;
  }, true);
  define(t, "GETEX", -2, ({ db }, a) => {
    const [key, ...opts] = a as [string, ...string[]];
    const v = getStr(db, key);
    let at: number | undefined | "persist";
    for (let i = 0; i < opts.length; i++) {
      const u = opts[i]!.toUpperCase();
      if (u === "PERSIST" && at === undefined) at = "persist";
      else if (["EX", "PX", "EXAT", "PXAT"].includes(u) && i + 1 < opts.length && at === undefined) {
        const n = parseIntArg(opts[++i]!);
        if (n <= 0) throw badExpire("getex");
        at = u === "EX" ? db.now() + n * 1000 : u === "PX" ? db.now() + n : u === "EXAT" ? n * 1000 : n;
      } else throw new RedisError(SYNTAX);
    }
    const e = db.get(key);
    if (e && at === "persist") e.expireAt = undefined;
    else if (e && typeof at === "number") e.expireAt = at;
    return v;
  }, true);
  define(t, "APPEND", 3, ({ db }, a) => {
    const e = db.getOrCreate(a[0]!, "string");
    e.value += a[1]!;
    return Buffer.byteLength(e.value);
  }, true);
  define(t, "STRLEN", 2, ({ db }, a) => Buffer.byteLength(getStr(db, a[0]!) ?? ""));
  define(t, "INCR", 2, ({ db }, a) => incrBy(db, a[0]!, 1n), true);
  define(t, "DECR", 2, ({ db }, a) => incrBy(db, a[0]!, -1n), true);
  define(t, "INCRBY", 3, ({ db }, a) => incrBy(db, a[0]!, parseInt64(a[1]!)), true);
  define(t, "DECRBY", 3, ({ db }, a) => {
    const by = parseInt64(a[1]!);
    if (by === -(2n ** 63n)) throw new RedisError("ERR decrement would overflow");
    return incrBy(db, a[0]!, -by);
  }, true);
  define(t, "INCRBYFLOAT", 3, ({ db }, a) => {
    const e = db.getTyped(a[0]!, "string");
    const cur = e ? parseFloatArg(e.value) : 0;
    const next = cur + parseFloatArg(a[1]!);
    if (!Number.isFinite(next)) throw new RedisError("ERR increment would produce NaN or Infinity");
    const s = formatFloat(next);
    if (e) e.value = s; else db.set(a[0]!, { type: "string", value: s });
    return s;
  }, true);
  define(t, "GETRANGE", 4, ({ db }, a) => {
    const buf = Buffer.from(getStr(db, a[0]!) ?? "");
    let s = parseIntArg(a[1]!), e = parseIntArg(a[2]!);
    const len = buf.length;
    if (s < 0 && e < 0 && s > e) return "";
    if (s < 0) s = len + s;
    if (e < 0) e = len + e;
    if (s < 0) s = 0;
    if (e < 0) e = 0;
    if (e >= len) e = len - 1;
    if (len === 0 || s > e) return "";
    return buf.subarray(s, e + 1).toString();
  });
  define(t, "SUBSTR", 4, (c, a) => t.get("GETRANGE")!.run(c, a));
  define(t, "SETRANGE", 4, ({ db }, a) => {
    const off = parseIntArg(a[1]!, "ERR offset is out of range");
    if (off < 0) throw new RedisError("ERR offset is out of range");
    const e = db.getTyped(a[0]!, "string");
    const cur = Buffer.from(e?.value ?? "");
    if (!e && a[2] === "") return 0;
    const patch = Buffer.from(a[2]!);
    const out = Buffer.alloc(Math.max(cur.length, off + patch.length));
    cur.copy(out);
    patch.copy(out, off);
    const s = out.toString();
    if (e) e.value = s; else db.set(a[0]!, { type: "string", value: s });
    return out.length;
  }, true);
}
export { NOT_INT };
