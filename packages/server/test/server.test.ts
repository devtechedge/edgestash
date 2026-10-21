import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLOB_TOKEN, REDIS_TOKEN, start, type Running } from "./helpers.js";

let s: Running;
beforeAll(async () => { s = await start(); });
afterAll(async () => s.stop());

describe("HTTP surface", () => {
  it("health and metrics", async () => {
    expect(await (await fetch(`${s.url}/healthz`)).json()).toMatchObject({ ok: true });
    await fetch(`${s.url}/redis`, { method: "POST", headers: { authorization: `Bearer ${REDIS_TOKEN}` }, body: '["PING"]' });
    const m = await (await fetch(`${s.url}/metrics`)).text();
    expect(m).toContain('edgestash_redis_commands_total{command="PING",ok="true"}');
    expect(m).toContain("edgestash_uptime_seconds");
  });

  it("Upstash path-style commands and _token query auth", async () => {
    const r = await fetch(`${s.url}/redis/set/pathkey/pathval?_token=${REDIS_TOKEN}`, { method: "POST" });
    expect(await r.json()).toEqual({ result: "OK" });
    const g = await fetch(`${s.url}/redis/get/pathkey`, { method: "POST", headers: { authorization: `Bearer ${REDIS_TOKEN}` } });
    expect(await g.json()).toEqual({ result: "pathval" });
  });

  it("single command errors are HTTP 400 with an error field", async () => {
    const r = await fetch(`${s.url}/redis`, { method: "POST", headers: { authorization: `Bearer ${REDIS_TOKEN}` }, body: '["NOPE"]' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/^ERR unknown command/);
  });

  it("pipeline reports per-command errors", async () => {
    const r = await fetch(`${s.url}/redis/pipeline`, { method: "POST", headers: { authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify([["SET", "a", 1], ["HGET", "a", "x"]]) });
    const body = await r.json();
    expect(body[0]).toEqual({ result: "OK" });
    expect(body[1].error).toMatch(/WRONGTYPE/);
  });

  it("multi-exec aborts on unknown commands", async () => {
    const r = await fetch(`${s.url}/redis/multi-exec`, { method: "POST", headers: { authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify([["SET", "tx", 1], ["NOPE"]]) });
    const body = await r.json();
    expect(body[0].error).toMatch(/EXECABORT/);
  });

  it("returns upstash-sync-token headers", async () => {
    const r = await fetch(`${s.url}/redis`, { method: "POST", headers: { authorization: `Bearer ${REDIS_TOKEN}` }, body: '["PING"]' });
    expect(r.headers.get("upstash-sync-token")).toMatch(/^\d+$/);
  });

  it("admin API lists keys and blobs with the admin token only", async () => {
    expect((await fetch(`${s.url}/api/admin/stats`)).status).toBe(401);
    await fetch(`${s.url}/api/blob/?pathname=admin.txt`, { method: "PUT", headers: { authorization: `Bearer ${BLOB_TOKEN}`, "x-api-version": "13" }, body: "hi" });
    const stats = await (await fetch(`${s.url}/api/admin/stats`, { headers: { authorization: "Bearer admin" } })).json();
    expect(stats.blob.stores[0]).toMatchObject({ storeId: "teststore" });
    const keys = await (await fetch(`${s.url}/api/admin/keys?match=path*`, { headers: { authorization: "Bearer admin" } })).json();
    expect(keys.keys[0]).toMatchObject({ key: "pathkey", type: "string", ttlMs: -1 });
    const blobs = await (await fetch(`${s.url}/api/admin/blobs`, { headers: { authorization: "Bearer admin" } })).json();
    expect(blobs.blobs.map((b: { pathname: string }) => b.pathname)).toContain("admin.txt");
  });

  it("CORS preflight is allowed for browser uploads", async () => {
    const r = await fetch(`${s.url}/api/blob/`, { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("admin overview", () => {
  it("seeds an empty instance and returns stats, keys and blobs in one response", async () => {
    const fresh = await start();
    try {
      const o = await (await fetch(`${fresh.url}/api/admin/overview?seed=1`, { headers: { authorization: "Bearer admin" } })).json();
      expect(o.stats.redis.keys).toBeGreaterThanOrEqual(8);
      expect(o.keys.map((k: { key: string }) => k.key)).toContain("leaderboard");
      expect(o.blobs.map((b: { pathname: string }) => b.pathname)).toEqual(["samples/config.json", "samples/readme.txt"]);
    } finally {
      await fresh.stop();
    }
  });
});
