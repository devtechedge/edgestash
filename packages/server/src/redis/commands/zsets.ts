import type { Keyspace } from "../keyspace.js";
import { define, type CommandTable } from "../registry.js";
import { RedisError, SYNTAX, type Reply } from "../types.js";
import { formatFloat, globToRegExp, normRange, parseFloatArg, parseIntArg } from "../util.js";
import { scanSlice } from "./keys.js";

type Item = [member: string, score: number];
const zs = (db: Keyspace, k: string) => db.getTyped(k, "zset")?.value;

export function sorted(z: Map<string, number>): Item[] {
  return [...z].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const MIN_MAX = "ERR min or max is not a float";
function scoreBound(s: string): { v: number; excl: boolean } {
  if (s.startsWith("(")) return { v: parseFloatArg(s.slice(1), MIN_MAX), excl: true };
  return { v: parseFloatArg(s, MIN_MAX), excl: false };
}
function lexBound(s: string): { v: string; excl: boolean; inf?: 1 | -1 } {
  if (s === "+") return { v: "", excl: false, inf: 1 };
  if (s === "-") return { v: "", excl: false, inf: -1 };
  if (s.startsWith("(")) return { v: s.slice(1), excl: true };
  if (s.startsWith("[")) return { v: s.slice(1), excl: false };
  throw new RedisError("ERR min or max not valid string range item");
}
const geMin = (score: number, b: { v: number; excl: boolean }) => (b.excl ? score > b.v : score >= b.v);
const leMax = (score: number, b: { v: number; excl: boolean }) => (b.excl ? score < b.v : score <= b.v);
function lexGe(m: string, b: ReturnType<typeof lexBound>) { if (b.inf) return b.inf < 0; return b.excl ? m > b.v : m >= b.v; }
function lexLe(m: string, b: ReturnType<typeof lexBound>) { if (b.inf) return b.inf > 0; return b.excl ? m < b.v : m <= b.v; }

const withScores = (items: Item[], ws: boolean): Reply => (ws ? items.flatMap(([m, s]) => [m, formatFloat(s)]) : items.map(([m]) => m));

interface RangeOpts { by: "rank" | "score" | "lex"; rev: boolean; limit?: [number, number]; ws: boolean }

function rangeGeneric(z: Map<string, number> | undefined, minArg: string, maxArg: string, o: RangeOpts): Item[] {
  if (o.by === "rank") {
    const items = sorted(z ?? new Map());
    if (o.rev) items.reverse();
    const r = normRange(parseIntArg(minArg), parseIntArg(maxArg), items.length);
    return r ? items.slice(r[0], r[1] + 1) : [];
  }
  // For REV, Redis takes max first then min.
  const [lo, hi] = o.rev ? [maxArg, minArg] : [minArg, maxArg];
  let items: Item[];
  if (o.by === "score") {
    const a = scoreBound(lo), b = scoreBound(hi);
    items = sorted(z ?? new Map()).filter(([, s]) => geMin(s, a) && leMax(s, b));
  } else {
    const a = lexBound(lo), b = lexBound(hi);
    items = sorted(z ?? new Map()).filter(([m]) => lexGe(m, a) && lexLe(m, b));
  }
  if (o.rev) items.reverse();
  if (o.limit) {
    const [off, cnt] = o.limit;
    if (off < 0) return [];
    items = cnt < 0 ? items.slice(off) : items.slice(off, off + cnt);
  }
  return items;
}

function parseRangeOpts(rest: string[], base: Partial<RangeOpts>): RangeOpts {
  const o: RangeOpts = { by: "rank", rev: false, ws: false, ...base };
  for (let i = 0; i < rest.length; i++) {
    const u = rest[i]!.toUpperCase();
    if (u === "WITHSCORES") o.ws = true;
    else if (u === "BYSCORE") o.by = "score";
    else if (u === "BYLEX") o.by = "lex";
    else if (u === "REV") o.rev = true;
    else if (u === "LIMIT" && i + 2 < rest.length) o.limit = [parseIntArg(rest[++i]!), parseIntArg(rest[++i]!)];
    else throw new RedisError(SYNTAX);
  }
  if (o.limit && o.by === "rank") throw new RedisError("ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX");
  if (o.ws && o.by === "lex") throw new RedisError("ERR syntax error, WITHSCORES not supported in combination with BYLEX");
  return o;
}

function popGeneric(db: Keyspace, a: string[], max: boolean): Reply {
  const z = zs(db, a[0]!);
  let n = 1;
  if (a.length > 2) throw new RedisError(SYNTAX);
  if (a.length === 2) {
    n = parseIntArg(a[1]!, "ERR value is out of range, must be positive");
    if (n < 0) throw new RedisError("ERR value is out of range, must be positive");
  }
  if (!z) return [];
  const items = sorted(z);
  if (max) items.reverse();
  const out = items.slice(0, n);
  for (const [m] of out) z.delete(m);
  db.cleanup(a[0]!);
  return withScores(out, true);
}

export function registerZsets(t: CommandTable): void {
  define(t, "ZADD", -4, ({ db }, a) => {
    const key = a[0]!;
    let i = 1, nx = false, xx = false, gt = false, lt = false, ch = false, incr = false;
    for (; i < a.length; i++) {
      const u = a[i]!.toUpperCase();
      if (u === "NX") nx = true; else if (u === "XX") xx = true; else if (u === "GT") gt = true;
      else if (u === "LT") lt = true; else if (u === "CH") ch = true; else if (u === "INCR") incr = true;
      else break;
    }
    const pairs = a.slice(i);
    if (pairs.length === 0 || pairs.length % 2) throw new RedisError(SYNTAX);
    if (nx && xx) throw new RedisError("ERR XX and NX options at the same time are not compatible");
    if ((gt && nx) || (lt && nx) || (gt && lt)) throw new RedisError("ERR GT, LT, and/or NX options at the same time are not compatible");
    if (incr && pairs.length !== 2) throw new RedisError("ERR INCR option supports a single increment-element pair");
    const parsed: Item[] = [];
    for (let j = 0; j < pairs.length; j += 2) parsed.push([pairs[j + 1]!, parseFloatArg(pairs[j]!)]);
    const existing = zs(db, key);
    if (!existing && xx) return incr ? null : 0;
    const z = db.getOrCreate(key, "zset").value;
    let added = 0, changed = 0;
    let incrResult: string | null = null;
    for (const [m, s] of parsed) {
      const cur = z.get(m);
      if (cur === undefined) {
        if (xx) continue;
        z.set(m, s); added++; incrResult = formatFloat(s);
        continue;
      }
      if (nx) { incrResult = null; continue; }
      const next = incr ? cur + s : s;
      if (Number.isNaN(next)) throw new RedisError("ERR resulting score is not a number (NaN)");
      if ((gt && next <= cur) || (lt && next >= cur)) { incrResult = null; continue; }
      if (next !== cur) { z.set(m, next); changed++; }
      incrResult = formatFloat(next);
    }
    db.cleanup(key);
    if (incr) return incrResult;
    return ch ? added + changed : added;
  }, true);
  define(t, "ZINCRBY", 4, ({ db }, a) => {
    const by = parseFloatArg(a[1]!);
    const z = db.getOrCreate(a[0]!, "zset").value;
    const next = (z.get(a[2]!) ?? 0) + by;
    if (Number.isNaN(next)) throw new RedisError("ERR resulting score is not a number (NaN)");
    z.set(a[2]!, next);
    return formatFloat(next);
  }, true);
  define(t, "ZSCORE", 3, ({ db }, a) => { const s = zs(db, a[0]!)?.get(a[1]!); return s === undefined ? null : formatFloat(s); });
  define(t, "ZMSCORE", -3, ({ db }, a) => { const z = zs(db, a[0]!); return a.slice(1).map((m) => { const s = z?.get(m); return s === undefined ? null : formatFloat(s); }); });
  define(t, "ZCARD", 2, ({ db }, a) => zs(db, a[0]!)?.size ?? 0);
  define(t, "ZCOUNT", 4, ({ db }, a) => {
    const lo = scoreBound(a[1]!), hi = scoreBound(a[2]!);
    return [...(zs(db, a[0]!)?.values() ?? [])].filter((s) => geMin(s, lo) && leMax(s, hi)).length;
  });
  define(t, "ZLEXCOUNT", 4, ({ db }, a) => {
    const lo = lexBound(a[1]!), hi = lexBound(a[2]!);
    return [...(zs(db, a[0]!)?.keys() ?? [])].filter((m) => lexGe(m, lo) && lexLe(m, hi)).length;
  });
  define(t, "ZRANGE", -4, ({ db }, a) => {
    const o = parseRangeOpts(a.slice(3), {});
    return withScores(rangeGeneric(zs(db, a[0]!), a[1]!, a[2]!, o), o.ws);
  });
  define(t, "ZREVRANGE", -4, ({ db }, a) => {
    const o = parseRangeOpts(a.slice(3), { rev: true });
    return withScores(rangeGeneric(zs(db, a[0]!), a[1]!, a[2]!, o), o.ws);
  });
  define(t, "ZRANGEBYSCORE", -4, ({ db }, a) => {
    const o = parseRangeOpts(a.slice(3), { by: "score" });
    return withScores(rangeGeneric(zs(db, a[0]!), a[1]!, a[2]!, o), o.ws);
  });
  define(t, "ZREVRANGEBYSCORE", -4, ({ db }, a) => {
    const o = parseRangeOpts(a.slice(3), { by: "score", rev: true });
    // ZREVRANGEBYSCORE takes max then min, which rangeGeneric already expects for rev.
    return withScores(rangeGeneric(zs(db, a[0]!), a[1]!, a[2]!, o), o.ws);
  });
  define(t, "ZRANGEBYLEX", -4, ({ db }, a) => {
    const o = parseRangeOpts(a.slice(3), { by: "lex" });
    return withScores(rangeGeneric(zs(db, a[0]!), a[1]!, a[2]!, o), false);
  });
  const rank = (rev: boolean) => ({ db }: { db: Keyspace }, a: string[]): Reply => {
    const z = zs(db, a[0]!);
    const ws = a[2]?.toUpperCase() === "WITHSCORE";
    if (a.length > 3 || (a.length === 3 && !ws)) throw new RedisError(SYNTAX);
    if (!z || !z.has(a[1]!)) return null;
    const items = sorted(z);
    if (rev) items.reverse();
    const i = items.findIndex(([m]) => m === a[1]);
    return ws ? [i, formatFloat(items[i]![1])] : i;
  };
  define(t, "ZRANK", -3, rank(false));
  define(t, "ZREVRANK", -3, rank(true));
  define(t, "ZREM", -3, ({ db }, a) => {
    const z = zs(db, a[0]!);
    if (!z) return 0;
    let n = 0;
    for (const m of a.slice(1)) if (z.delete(m)) n++;
    db.cleanup(a[0]!);
    return n;
  }, true);
  define(t, "ZREMRANGEBYRANK", 4, ({ db }, a) => {
    const z = zs(db, a[0]!);
    if (!z) return 0;
    const out = rangeGeneric(z, a[1]!, a[2]!, { by: "rank", rev: false, ws: false });
    for (const [m] of out) z.delete(m);
    db.cleanup(a[0]!);
    return out.length;
  }, true);
  define(t, "ZREMRANGEBYSCORE", 4, ({ db }, a) => {
    const z = zs(db, a[0]!);
    if (!z) return 0;
    const out = rangeGeneric(z, a[1]!, a[2]!, { by: "score", rev: false, ws: false });
    for (const [m] of out) z.delete(m);
    db.cleanup(a[0]!);
    return out.length;
  }, true);
  define(t, "ZPOPMIN", -2, ({ db }, a) => popGeneric(db, a, false), true);
  define(t, "ZPOPMAX", -2, ({ db }, a) => popGeneric(db, a, true), true);
  define(t, "ZRANDMEMBER", -2, ({ db }, a) => {
    const items = [...(zs(db, a[0]!) ?? [])];
    if (a.length === 1) return items.length ? items[Math.floor(Math.random() * items.length)]![0] : null;
    const n = parseIntArg(a[1]!);
    const ws = a[2]?.toUpperCase() === "WITHSCORES";
    const pick = n >= 0 ? items.sort(() => Math.random() - 0.5).slice(0, n) : items.length ? Array.from({ length: -n }, () => items[Math.floor(Math.random() * items.length)]!) : [];
    return withScores(pick, ws);
  });
  define(t, "ZSCAN", -3, ({ db }, a) => {
    const cursor = parseIntArg(a[1]!, "ERR invalid cursor");
    let match: RegExp | undefined, count = 10;
    for (let i = 2; i < a.length; i++) {
      const u = a[i]!.toUpperCase();
      if (u === "MATCH" && i + 1 < a.length) match = globToRegExp(a[++i]!);
      else if (u === "COUNT" && i + 1 < a.length) count = parseIntArg(a[++i]!);
      else throw new RedisError(SYNTAX);
    }
    const z = zs(db, a[0]!) ?? new Map<string, number>();
    const [next, ms] = scanSlice(sorted(z).map(([m]) => m), cursor, count, (k) => !match || match.test(k));
    return [next, ms.flatMap((m) => [m, formatFloat(z.get(m)!)])];
  });
}
