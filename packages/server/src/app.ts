import { join } from "node:path";
import { BlobApi } from "./blob/handler.js";
import { FsBlobStorage, MemoryBlobStorage, type BlobStorage } from "./blob/storage.js";
import { configFromEnv, type EdgestashConfig } from "./config.js";
import { Metrics } from "./metrics.js";
import { EmbeddedBackend, ProxyBackend, type RedisBackend } from "./redis/backend.js";
import { RedisEngine } from "./redis/engine.js";
import { handleRedisRest } from "./redis/rest.js";
import { loadFrom, saveTo } from "./redis/snapshot.js";
import { globToRegExp } from "./redis/util.js";

export const VERSION = "0.1.0";

export interface Edgestash {
  config: EdgestashConfig;
  engine?: RedisEngine;
  backend: RedisBackend;
  blob: BlobApi;
  metrics: Metrics;
  /** Web-standard request handler: mount it in Node, Next.js route handlers, Bun or Deno. */
  fetch(req: Request): Promise<Response>;
  close(): Promise<void>;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,PUT,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
};

function withCors(res: Response): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function createEdgestash(partial: Partial<EdgestashConfig> = {}, deps: { storage?: BlobStorage; now?: () => number } = {}): Promise<Edgestash> {
  const config: EdgestashConfig = { ...configFromEnv(), ...partial };
  const metrics = new Metrics();
  const storage = deps.storage ?? (config.dataDir ? new FsBlobStorage(join(config.dataDir, "blobs")) : new MemoryBlobStorage());
  await storage.init();

  let engine: RedisEngine | undefined;
  let backend: RedisBackend;
  let snapshotTimer: NodeJS.Timeout | undefined;
  const snapshotFile = config.dataDir ? join(config.dataDir, "redis.json") : "";
  if (config.redisBackend.startsWith("redis://") || config.redisBackend.startsWith("rediss://")) {
    backend = new ProxyBackend(config.redisBackend);
  } else {
    engine = new RedisEngine({ now: deps.now, sweepIntervalMs: 1000 });
    if (snapshotFile) await loadFrom(engine.db, snapshotFile);
    backend = new EmbeddedBackend(engine);
    if (snapshotFile && config.snapshotIntervalMs > 0) {
      let dirty = false;
      const orig = engine.exec.bind(engine);
      engine.exec = (argv, inScript) => {
        const r = orig(argv, inScript);
        if (engine!.isWrite(argv[0] ?? "")) dirty = true;
        return r;
      };
      snapshotTimer = setInterval(() => {
        if (!dirty) return;
        dirty = false;
        void saveTo(engine!.db, snapshotFile);
      }, config.snapshotIntervalMs);
      snapshotTimer.unref();
    }
  }

  const blob = new BlobApi({
    storage,
    tokens: config.blobTokens,
    publicUrl: config.publicUrl,
    maxSizeBytes: config.maxBlobSizeBytes,
    onEvent: (e) => metrics.inc("edgestash_blob_events_total", { event: e }),
  });

  metrics.gauge("edgestash_uptime_seconds", () => Math.round((Date.now() - metrics.startedAt) / 1000));
  if (engine) metrics.gauge("edgestash_redis_keys", () => engine!.db.keys().length);
  metrics.gauge("edgestash_blob_count", () => config.blobTokens.reduce((n, t) => n + storage.list(t.split("_")[3] ?? "").length, 0));

  const adminOk = (req: Request) => {
    const h = req.headers.get("authorization") ?? "";
    const tok = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : new URL(req.url).searchParams.get("token") ?? "";
    return tok === config.adminToken;
  };

  async function admin(req: Request, path: string): Promise<Response> {
    if (!adminOk(req)) return json({ error: "Unauthorized" }, 401);
    const q = new URL(req.url).searchParams;
    if (path === "seed" && req.method === "POST") {
      await seed();
      return json({ ok: true });
    }
    if (path === "overview") {
      // One consistent snapshot for dashboards; ?seed=1 fills an empty instance with sample data.
      if (q.get("seed") === "1" && engine && engine.db.keys().length === 0) await seed();
      const [stats, keys, blobs] = await Promise.all([
        admin(new Request(new URL("/api/admin/stats", req.url), { headers: req.headers }), "stats").then((r) => r.json()),
        admin(new Request(new URL(`/api/admin/keys?match=${encodeURIComponent(q.get("match") ?? "*")}`, req.url), { headers: req.headers }), "keys").then((r) => r.json()),
        admin(new Request(new URL("/api/admin/blobs", req.url), { headers: req.headers }), "blobs").then((r) => r.json()),
      ]);
      return json({ stats, keys: keys.keys ?? [], blobs: blobs.blobs ?? [] });
    }
    if (path === "stats") {
      return json({
        version: VERSION,
        uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1000),
        redis: { backend: backend.kind, keys: engine?.db.keys().length ?? null, commands: engine?.stats.commands ?? null, errors: engine?.stats.errors ?? null, byCommand: engine?.stats.byCommand ?? {} },
        blob: { storage: storage.kind, stores: config.blobTokens.map((t) => { const id = t.split("_")[3] ?? ""; const all = storage.list(id); return { storeId: id, count: all.length, bytes: all.reduce((n, m) => n + m.size, 0) }; }) },
        metrics: metrics.snapshot(),
      });
    }
    if (path === "keys") {
      if (!engine) return json({ error: "key browser requires the embedded backend" }, 400);
      const re = globToRegExp(q.get("match") ?? "*");
      const keys = engine.db.keys().filter((k) => re.test(k)).sort().slice(0, Number(q.get("limit") ?? 200));
      return json({ keys: keys.map((k) => { const e = engine!.db.get(k)!; const size = e.type === "string" ? e.value.length : e.type === "list" ? e.value.length : e.value.size; return { key: k, type: e.type, ttlMs: e.expireAt === undefined ? -1 : e.expireAt - engine!.db.now(), size }; }) });
    }
    if (path === "key") {
      if (!engine) return json({ error: "key browser requires the embedded backend" }, 400);
      const e = engine.db.get(q.get("k") ?? "");
      if (!e) return json({ error: "not found" }, 404);
      const value = e.type === "string" || e.type === "list" ? e.value : e.type === "set" ? [...e.value] : Object.fromEntries(e.value);
      return json({ type: e.type, ttlMs: e.expireAt === undefined ? -1 : e.expireAt - engine.db.now(), value });
    }
    if (path === "blobs") {
      const storeId = q.get("store") ?? config.blobTokens[0]!.split("_")[3] ?? "";
      const prefix = q.get("prefix") ?? "";
      return json({ storeId, blobs: storage.list(storeId).filter((m) => m.pathname.startsWith(prefix)).map((m) => ({ ...m, url: blob.blobUrl(m.storeId, m.pathname) })) });
    }
    return json({ error: "not found" }, 404);
  }

  /** Sample data for demos: a few keys of every type and two blobs. */
  async function seed(): Promise<void> {
    const cmds: string[][] = [
      ["SET", "greeting", "hello from edgestash"],
      ["SET", "session:abc", JSON.stringify({ user: "ada", plan: "pro" }), "EX", "3600"],
      ["INCRBY", "stats:visits", "42"],
      ["HSET", "user:1", "name", "Ada", "email", "ada@example.com", "plan", "pro"],
      ["RPUSH", "queue:emails", "welcome", "digest", "reminder"],
      ["SADD", "tags:post:1", "redis", "blob", "self-hosted"],
      ["ZADD", "leaderboard", "120", "ada", "95", "linus", "87", "grace"],
      ["SET", "ratelimit:demo:1", "3", "PX", "60000"],
    ];
    await backend.run(cmds, false);
    const storeId = config.blobTokens[0]?.split("_")[3] ?? "";
    const tok = config.blobTokens[0] ?? "";
    for (const [p, body, type] of [["samples/readme.txt", "edgestash sample blob", "text/plain"], ["samples/config.json", '{"theme":"dark"}', "application/json"]] as const) {
      if (storage.head(storeId, p)) continue;
      await blob.handle(new Request(`http://local/api/blob/?pathname=${encodeURIComponent(p)}`, { method: "PUT", headers: { authorization: `Bearer ${tok}`, "x-content-type": type }, body }), "/");
    }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (p === "/healthz") return json({ ok: true, version: VERSION });
    if (p === "/metrics") return new Response(metrics.render(), { headers: { "content-type": "text/plain; version=0.0.4" } });
    if (p === "/api/blob" || p.startsWith("/api/blob/")) {
      metrics.inc("edgestash_http_requests_total", { api: "blob" });
      return withCors(await blob.handle(req, p.slice("/api/blob".length)));
    }
    if (p === "/redis" || p.startsWith("/redis/")) {
      metrics.inc("edgestash_http_requests_total", { api: "redis" });
      return withCors(await handleRedisRest(req, p.slice("/redis".length), {
        backend,
        tokens: config.redisTokens,
        readonlyTokens: config.redisReadonlyTokens,
        isWrite: (c) => (engine ? engine.isWrite(c) : !/^(GET|MGET|EXISTS|TTL|PTTL|TYPE|SCAN|KEYS|H(GET|MGET|GETALL|KEYS|VALS|LEN|EXISTS|SCAN)|L(RANGE|LEN|INDEX|POS)|S(MEMBERS|ISMEMBER|MISMEMBER|CARD|SCAN)|Z(SCORE|MSCORE|CARD|COUNT|RANGE.*|RANK|REVRANK|SCAN)|PING|ECHO|DBSIZE|STRLEN|GETRANGE)$/i.test(c)),
        onCommand: (c, ok) => metrics.inc("edgestash_redis_commands_total", { command: c, ok: String(ok) }),
      }));
    }
    if ((req.method === "GET" || req.method === "HEAD") && p.startsWith("/s/")) {
      const [, , storeId = "", ...rest] = p.split("/");
      metrics.inc("edgestash_http_requests_total", { api: "download" });
      return withCors(await blob.serve(req, storeId, rest.map(decodeURIComponent).join("/")));
    }
    if (p.startsWith("/api/admin/")) return withCors(await admin(req, p.slice("/api/admin/".length)));
    if (p === "/") return json({ name: "edgestash", version: VERSION, blobApi: "/api/blob", redisApi: "/redis", docs: "https://github.com/devtechedge/edgestash" });
    return json({ error: "not found" }, 404);
  }

  return {
    config,
    engine,
    backend,
    blob,
    metrics,
    async fetch(req) {
      try {
        return await handle(req);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    },
    async close() {
      if (snapshotTimer) clearInterval(snapshotTimer);
      if (engine && snapshotFile) await saveTo(engine.db, snapshotFile);
      engine?.close();
      backend.close?.();
    },
  };
}
