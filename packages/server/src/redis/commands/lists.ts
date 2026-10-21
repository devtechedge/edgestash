import type { Keyspace } from "../keyspace.js";
import { define, type CommandTable } from "../registry.js";
import { OK, RedisError, SYNTAX, type Reply } from "../types.js";
import { normRange, parseIntArg } from "../util.js";

const list = (db: Keyspace, k: string) => db.getTyped(k, "list")?.value;

function pop(db: Keyspace, a: string[], left: boolean): Reply {
  const l = list(db, a[0]!);
  if (a.length > 2) throw new RedisError(SYNTAX);
  if (a.length === 2) {
    const n = parseIntArg(a[1]!, "ERR value is out of range, must be positive");
    if (n < 0) throw new RedisError("ERR value is out of range, must be positive");
    if (!l) return null;
    const out = left ? l.splice(0, n) : l.splice(Math.max(0, l.length - n)).reverse();
    db.cleanup(a[0]!);
    return out;
  }
  if (!l) return null;
  const v = left ? l.shift()! : l.pop()!;
  db.cleanup(a[0]!);
  return v;
}

function move(db: Keyspace, src: string, dst: string, fromLeft: boolean, toLeft: boolean): Reply {
  const s = list(db, src);
  if (!s) return null;
  if (db.get(dst) && db.get(dst)!.type !== "list") db.getTyped(dst, "list");
  const v = fromLeft ? s.shift()! : s.pop()!;
  db.cleanup(src);
  const d = db.getOrCreate(dst, "list").value;
  if (toLeft) d.unshift(v); else d.push(v);
  return v;
}

const side = (s: string) => {
  const u = s.toUpperCase();
  if (u !== "LEFT" && u !== "RIGHT") throw new RedisError(SYNTAX);
  return u === "LEFT";
};

export function registerLists(t: CommandTable): void {
  define(t, "LPUSH", -3, ({ db }, a) => { const l = db.getOrCreate(a[0]!, "list").value; for (const v of a.slice(1)) l.unshift(v); return l.length; }, true);
  define(t, "RPUSH", -3, ({ db }, a) => { const l = db.getOrCreate(a[0]!, "list").value; l.push(...a.slice(1)); return l.length; }, true);
  define(t, "LPUSHX", -3, ({ db }, a) => { const l = list(db, a[0]!); if (!l) return 0; for (const v of a.slice(1)) l.unshift(v); return l.length; }, true);
  define(t, "RPUSHX", -3, ({ db }, a) => { const l = list(db, a[0]!); if (!l) return 0; l.push(...a.slice(1)); return l.length; }, true);
  define(t, "LPOP", -2, ({ db }, a) => pop(db, a, true), true);
  define(t, "RPOP", -2, ({ db }, a) => pop(db, a, false), true);
  define(t, "LLEN", 2, ({ db }, a) => list(db, a[0]!)?.length ?? 0);
  define(t, "LRANGE", 4, ({ db }, a) => {
    const l = list(db, a[0]!) ?? [];
    const r = normRange(parseIntArg(a[1]!), parseIntArg(a[2]!), l.length);
    return r ? l.slice(r[0], r[1] + 1) : [];
  });
  define(t, "LINDEX", 3, ({ db }, a) => {
    const l = list(db, a[0]!) ?? [];
    let i = parseIntArg(a[1]!);
    if (i < 0) i += l.length;
    return l[i] ?? null;
  });
  define(t, "LSET", 4, ({ db }, a) => {
    const l = list(db, a[0]!);
    if (!l) throw new RedisError("ERR no such key");
    let i = parseIntArg(a[1]!);
    if (i < 0) i += l.length;
    if (i < 0 || i >= l.length) throw new RedisError("ERR index out of range");
    l[i] = a[2]!;
    return OK;
  }, true);
  define(t, "LREM", 4, ({ db }, a) => {
    const l = list(db, a[0]!);
    if (!l) return 0;
    let count = parseIntArg(a[1]!);
    const v = a[2]!;
    let removed = 0;
    if (count >= 0) {
      for (let i = 0; i < l.length && (count === 0 || removed < count); ) {
        if (l[i] === v) { l.splice(i, 1); removed++; } else i++;
      }
    } else {
      count = -count;
      for (let i = l.length - 1; i >= 0 && removed < count; i--) if (l[i] === v) { l.splice(i, 1); removed++; }
    }
    db.cleanup(a[0]!);
    return removed;
  }, true);
  define(t, "LTRIM", 4, ({ db }, a) => {
    const l = list(db, a[0]!);
    if (!l) return OK;
    const r = normRange(parseIntArg(a[1]!), parseIntArg(a[2]!), l.length);
    const kept = r ? l.slice(r[0], r[1] + 1) : [];
    l.length = 0;
    l.push(...kept);
    db.cleanup(a[0]!);
    return OK;
  }, true);
  define(t, "LINSERT", 5, ({ db }, a) => {
    const where = a[1]!.toUpperCase();
    if (where !== "BEFORE" && where !== "AFTER") throw new RedisError(SYNTAX);
    const l = list(db, a[0]!);
    if (!l) return 0;
    const i = l.indexOf(a[2]!);
    if (i < 0) return -1;
    l.splice(where === "BEFORE" ? i : i + 1, 0, a[3]!);
    return l.length;
  }, true);
  define(t, "LPOS", -3, ({ db }, a) => {
    const l = list(db, a[0]!) ?? [];
    let rank = 1, count: number | undefined, maxlen = 0;
    for (let i = 2; i < a.length; i++) {
      const u = a[i]!.toUpperCase();
      if (u === "RANK" && i + 1 < a.length) {
        rank = parseIntArg(a[++i]!);
        if (rank === 0) throw new RedisError("ERR RANK can't be zero: use 1 to start from the first match, 2 from the second ... or use negative to start from the end of the list");
      } else if (u === "COUNT" && i + 1 < a.length) {
        count = parseIntArg(a[++i]!);
        if (count < 0) throw new RedisError("ERR COUNT can't be negative");
      } else if (u === "MAXLEN" && i + 1 < a.length) {
        maxlen = parseIntArg(a[++i]!);
        if (maxlen < 0) throw new RedisError("ERR MAXLEN can't be negative");
      } else throw new RedisError(SYNTAX);
    }
    const out: number[] = [];
    const want = count === undefined ? 1 : count === 0 ? Infinity : count;
    let skip = Math.abs(rank) - 1;
    const idxs = rank > 0 ? [...l.keys()] : [...l.keys()].reverse();
    let scanned = 0;
    for (const i of idxs) {
      if (maxlen && scanned++ >= maxlen) break;
      if (l[i] !== a[1]) continue;
      if (skip > 0) { skip--; continue; }
      out.push(i);
      if (out.length >= want) break;
    }
    return count === undefined ? (out[0] ?? null) : out;
  });
  define(t, "RPOPLPUSH", 3, ({ db }, a) => move(db, a[0]!, a[1]!, false, true), true);
  define(t, "LMOVE", 5, ({ db }, a) => move(db, a[0]!, a[1]!, side(a[2]!), side(a[3]!)), true);
}
