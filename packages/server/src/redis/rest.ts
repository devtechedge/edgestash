import type { RedisBackend, CommandResult } from "./backend.js";
import { Status, type Reply } from "./types.js";

export interface RedisRestOptions {
  backend: RedisBackend;
  /** Full-access tokens. */
  tokens: string[];
  /** Read-only tokens (only non-write commands allowed). */
  readonlyTokens?: string[];
  isWrite?: (cmd: string) => boolean;
  onCommand?: (cmd: string, ok: boolean) => void;
}

/** Serialise a reply into Upstash JSON, optionally base64-encoding strings (all but "OK"). */
export function encodeReply(r: Reply, base64: boolean): unknown {
  if (r === null) return null;
  if (typeof r === "number") return r;
  if (typeof r === "bigint") return Number.isSafeInteger(Number(r)) ? Number(r) : new RawJson(r.toString());
  if (r instanceof Status) return base64 && r.value !== "OK" ? b64(r.value) : r.value;
  if (typeof r === "string") return base64 ? b64(r) : r;
  return r.map((x) => encodeReply(x, base64));
}
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** Marker for integers that must be emitted verbatim to keep 64-bit precision. */
class RawJson {
  constructor(readonly text: string) {}
}
export function stringify(v: unknown): string {
  const marks: string[] = [];
  const json = JSON.stringify(v, (_k, x) => {
    if (x instanceof RawJson) {
      marks.push(x.text);
      return `__edgestash_raw_${marks.length - 1}__`;
    }
    return x;
  });
  return marks.length ? json.replace(/"__edgestash_raw_(\d+)__"/g, (_m, i) => marks[Number(i)]!) : json;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function toArgs(x: unknown): string[] | null {
  if (!Array.isArray(x) || x.length === 0) return null;
  return x.map((a) => (typeof a === "string" ? a : a === null || a === undefined ? "" : typeof a === "object" ? JSON.stringify(a) : String(a)));
}

let syncCounter = 0;

/**
 * Upstash Redis REST protocol handler. `path` is the part after the mount point,
 * for example "" (single command), "pipeline", "multi-exec" or "set/foo/bar".
 */
export async function handleRedisRest(req: Request, path: string, opts: RedisRestOptions): Promise<Response> {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : url.searchParams.get("_token") ?? "";
  const full = opts.tokens.includes(token);
  const readonly = !full && (opts.readonlyTokens ?? []).includes(token);
  if (!full && !readonly) return json(401, { error: "Unauthorized" });
  const base64 = (req.headers.get("upstash-encoding") ?? "").toLowerCase() === "base64";
  const sync = { "upstash-sync-token": String(++syncCounter) };

  const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
  const kind = segments[0] === "pipeline" ? "pipeline" : segments[0] === "multi-exec" ? "multi-exec" : "single";
  const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();

  let commands: string[][];
  if (kind === "single") {
    let args: string[] | null;
    if (segments.length > 0) {
      args = [...segments];
      if (bodyText !== "") args.push(bodyText);
    } else {
      try {
        args = toArgs(JSON.parse(bodyText || "null"));
      } catch {
        args = null;
      }
    }
    if (!args) return json(400, { error: "ERR failed to parse command" });
    commands = [args];
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText || "null");
    } catch {
      return json(400, { error: "ERR failed to parse pipeline request" });
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return json(400, { error: "ERR empty pipeline request" });
    const cmds = parsed.map(toArgs);
    if (cmds.some((c) => c === null)) return json(400, { error: "ERR pipeline request must be an array of arrays" });
    commands = cmds as string[][];
  }

  if (readonly && opts.isWrite) {
    const bad = commands.find((c) => opts.isWrite!(c[0]!));
    if (bad) return json(401, { error: `NOPERM this user has no permissions to run the '${bad[0]!.toLowerCase()}' command` });
  }

  let results: CommandResult[];
  try {
    results = await opts.backend.run(commands, kind === "multi-exec");
  } catch (e) {
    return json(500, { error: `ERR backend failure: ${e instanceof Error ? e.message : String(e)}` });
  }
  results.forEach((r, i) => opts.onCommand?.(commands[i]![0]!.toUpperCase(), !("error" in r)));
  const out = results.map((r) => ("error" in r ? { error: r.error } : { result: encodeReply(r.result, base64) }));
  if (kind === "single") {
    const r = out[0]!;
    return json("error" in r ? 400 : 200, r, sync);
  }
  return json(200, out, sync);
}
