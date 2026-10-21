import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Keyspace } from "./keyspace.js";
import type { Entry } from "./types.js";

type Serial = { k: string; t: Entry["type"]; v: unknown; x?: number };

/** JSON snapshot persistence (an RDB-like dump) for the embedded engine. */
export function dump(db: Keyspace): string {
  const out: Serial[] = [];
  for (const k of db.keys()) {
    const e = db.get(k)!;
    const v = e.type === "string" ? e.value : e.type === "list" ? e.value : e.type === "set" ? [...e.value] : [...e.value];
    out.push({ k, t: e.type, v, ...(e.expireAt !== undefined ? { x: e.expireAt } : {}) });
  }
  return JSON.stringify({ version: 1, savedAt: Date.now(), entries: out });
}

export function load(db: Keyspace, text: string): number {
  const parsed = JSON.parse(text) as { entries: Serial[] };
  let n = 0;
  for (const s of parsed.entries) {
    if (s.x !== undefined && s.x <= db.now()) continue;
    const value =
      s.t === "string" ? (s.v as string)
      : s.t === "list" ? (s.v as string[])
      : s.t === "set" ? new Set(s.v as string[])
      : new Map(s.v as [string, string | number][]);
    db.data.set(s.k, { type: s.t, value, expireAt: s.x } as Entry);
    n++;
  }
  return n;
}

export async function saveTo(db: Keyspace, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, dump(db));
  await rename(tmp, file);
}

export async function loadFrom(db: Keyspace, file: string): Promise<number> {
  try {
    return load(db, await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}
