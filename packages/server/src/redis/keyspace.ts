import { RedisError, WRONGTYPE, type Entry, type Value } from "./types.js";

/** In-memory keyspace with lazy plus periodic expiry, like Redis. */
export class Keyspace {
  readonly data = new Map<string, Entry>();
  now: () => number = () => Date.now();

  get(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (!e) return undefined;
    if (e.expireAt !== undefined && e.expireAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
  /** Typed lookup that throws WRONGTYPE on mismatch. */
  getTyped<T extends Value["type"]>(key: string, type: T): Extract<Entry, { type: T }> | undefined {
    const e = this.get(key);
    if (!e) return undefined;
    if (e.type !== type) throw new RedisError(WRONGTYPE);
    return e as Extract<Entry, { type: T }>;
  }
  /** Returns the existing typed entry or creates an empty one. */
  getOrCreate<T extends Value["type"]>(key: string, type: T): Extract<Entry, { type: T }> {
    const e = this.getTyped(key, type);
    if (e) return e;
    const fresh = { type, value: emptyValue(type) } as Extract<Entry, { type: T }>;
    this.data.set(key, fresh);
    return fresh;
  }
  set(key: string, v: Value, keepTtl = false): void {
    const prev = keepTtl ? this.get(key) : undefined;
    this.data.set(key, { ...v, expireAt: prev?.expireAt } as Entry);
  }
  delete(key: string): boolean {
    const existed = this.has(key);
    this.data.delete(key);
    return existed;
  }
  /** Remove containers that became empty, matching Redis auto-deletion. */
  cleanup(key: string): void {
    const e = this.data.get(key);
    if (!e) return;
    const v = e.value as { size?: number; length?: number };
    if (e.type !== "string" && (v.size ?? v.length) === 0) this.data.delete(key);
  }
  keys(): string[] {
    const out: string[] = [];
    for (const k of this.data.keys()) if (this.get(k)) out.push(k);
    return out;
  }
  sweep(): number {
    let n = 0;
    const t = this.now();
    for (const [k, e] of this.data) if (e.expireAt !== undefined && e.expireAt <= t) { this.data.delete(k); n++; }
    return n;
  }
}

function emptyValue(type: Value["type"]): Value["value"] {
  switch (type) {
    case "string": return "";
    case "hash": return new Map<string, string>();
    case "list": return [];
    case "set": return new Set<string>();
    case "zset": return new Map<string, number>();
  }
}
