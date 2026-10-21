import { NOT_FLOAT, NOT_INT, RedisError } from "./types.js";

const INT_RE = /^-?(0|[1-9][0-9]*)$/;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** Parse a Redis integer argument (signed 64-bit, no leading zeros or spaces). */
export function parseInt64(s: string, msg = NOT_INT): bigint {
  if (!INT_RE.test(s)) throw new RedisError(msg);
  const v = BigInt(s);
  if (v < I64_MIN || v > I64_MAX) throw new RedisError(msg);
  return v;
}
export function inRange64(v: bigint): boolean {
  return v >= I64_MIN && v <= I64_MAX;
}
export function parseIntArg(s: string, msg = NOT_INT): number {
  return Number(parseInt64(s, msg));
}

/** Parse a Redis float argument, accepting inf/-inf like Redis does. */
export function parseFloatArg(s: string, msg = NOT_FLOAT): number {
  const t = s.toLowerCase();
  if (t === "inf" || t === "+inf" || t === "infinity" || t === "+infinity") return Infinity;
  if (t === "-inf" || t === "-infinity") return -Infinity;
  if (s.trim() !== s || s === "" ) throw new RedisError(msg);
  const v = Number(s);
  if (Number.isNaN(v)) throw new RedisError(msg);
  return v;
}

/** Format a double the way Redis replies with it (shortest round-trip, inf, no trailing .0). */
export function formatFloat(v: number): string {
  if (v === Infinity) return "inf";
  if (v === -Infinity) return "-inf";
  if (Object.is(v, -0)) return "-0";
  if (Number.isInteger(v) && Math.abs(v) < 1e17) return v.toFixed(0);
  const s = String(v);
  if (!s.includes("e")) return s;
  const [m, e] = s.split("e");
  const exp = Number(e);
  return `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
}

/** Glob matcher implementing Redis stringmatchlen semantics (*, ?, [..], escapes). */
export function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else if (c === "\\" && i + 1 < pattern.length) re += escapeRe(pattern[++i]!);
    else if (c === "[") {
      let j = i + 1;
      let negate = false;
      if (pattern[j] === "^") { negate = true; j++; }
      let cls = "";
      while (j < pattern.length && pattern[j] !== "]") {
        if (pattern[j] === "\\" && j + 1 < pattern.length) { cls += escapeRe(pattern[j + 1]!); j += 2; continue; }
        if (pattern[j + 1] === "-" && j + 2 < pattern.length && pattern[j + 2] !== "]") {
          cls += `${escapeRe(pattern[j]!)}-${escapeRe(pattern[j + 2]!)}`; j += 3; continue;
        }
        cls += escapeRe(pattern[j]!); j++;
      }
      i = j;
      re += cls === "" ? (negate ? "[\\s\\S]" : "(?!)") : `[${negate ? "^" : ""}${cls}]`;
    } else re += escapeRe(c);
  }
  return new RegExp(re + "$");
}
function escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");
}

/** Normalise start/stop indices the way LRANGE/GETRANGE/ZRANGE do. Returns null if empty. */
export function normRange(start: number, stop: number, len: number): [number, number] | null {
  if (start < 0) start = len + start;
  if (stop < 0) stop = len + stop;
  if (start < 0) start = 0;
  if (stop >= len) stop = len - 1;
  if (start > stop || start >= len) return null;
  return [start, stop];
}
