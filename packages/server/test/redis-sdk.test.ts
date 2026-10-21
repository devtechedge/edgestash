import { Redis } from "@upstash/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { READONLY_TOKEN, REDIS_TOKEN, start, type Running } from "./helpers.js";

let s: Running;
let redis: Redis;
beforeAll(async () => {
  s = await start();
  redis = new Redis({ url: `${s.url}/redis`, token: REDIS_TOKEN, retry: false });
});
afterAll(async () => s.stop());

describe("@upstash/redis against edgestash", () => {
  it("strings with automatic JSON (de)serialisation", async () => {
    expect(await redis.set("greeting", "hello")).toBe("OK");
    expect(await redis.get("greeting")).toBe("hello");
    await redis.set("obj", { a: 1, b: [1, 2] });
    expect(await redis.get("obj")).toEqual({ a: 1, b: [1, 2] });
    expect(await redis.set("greeting", "x", { nx: true })).toBeNull();
    expect(await redis.set("tmp", "v", { ex: 100 })).toBe("OK");
    expect(await redis.ttl("tmp")).toBeGreaterThan(98);
    expect(await redis.mget("greeting", "missing")).toEqual(["hello", null]);
    expect(await redis.getdel("greeting")).toBe("hello");
    expect(await redis.exists("greeting")).toBe(0);
  });

  it("unicode survives base64 encoding", async () => {
    await redis.set("uni", "नमस्ते 🌏 café");
    expect(await redis.get("uni")).toBe("नमस्ते 🌏 café");
  });

  it("INCR family", async () => {
    expect(await redis.incr("n")).toBe(1);
    expect(await redis.incrby("n", 10)).toBe(11);
    expect(await redis.decr("n")).toBe(10);
    expect(await redis.incrbyfloat("f", 1.5)).toBe(1.5);
    await redis.set("notnum", "abc");
    await expect(redis.incr("notnum")).rejects.toThrow(/not an integer/);
  });

  it("hashes", async () => {
    expect(await redis.hset("user:1", { name: "Dev", age: 30 })).toBe(2);
    expect(await redis.hget("user:1", "name")).toBe("Dev");
    expect(await redis.hgetall("user:1")).toEqual({ name: "Dev", age: 30 });
    expect(await redis.hincrby("user:1", "age", 1)).toBe(31);
    expect(await redis.hkeys("user:1")).toEqual(["name", "age"]);
    expect(await redis.hdel("user:1", "age")).toBe(1);
    expect(await redis.hlen("user:1")).toBe(1);
  });

  it("lists", async () => {
    expect(await redis.rpush("q", "a", "b", "c")).toBe(3);
    expect(await redis.lpush("q", "z")).toBe(4);
    expect(await redis.lrange("q", 0, -1)).toEqual(["z", "a", "b", "c"]);
    expect(await redis.lpop("q")).toBe("z");
    expect(await redis.rpop("q")).toBe("c");
    expect(await redis.llen("q")).toBe(2);
  });

  it("sets", async () => {
    expect(await redis.sadd("tags", "a", "b", "c")).toBe(3);
    expect(await redis.sismember("tags", "a")).toBe(1);
    expect((await redis.smembers("tags")).sort()).toEqual(["a", "b", "c"]);
    expect(await redis.srem("tags", "a")).toBe(1);
    expect(await redis.scard("tags")).toBe(2);
  });

  it("sorted sets", async () => {
    expect(await redis.zadd("lb", { score: 10, member: "ann" }, { score: 20, member: "bob" }, { score: 15, member: "cy" })).toBe(3);
    expect(await redis.zrange("lb", 0, -1)).toEqual(["ann", "cy", "bob"]);
    expect(await redis.zrange("lb", 0, -1, { rev: true, withScores: true })).toEqual(["bob", 20, "cy", 15, "ann", 10]);
    expect(await redis.zscore("lb", "cy")).toBe(15);
    expect(await redis.zincrby("lb", 10, "ann")).toBe(20);
    expect(await redis.zrank("lb", "cy")).toBe(0);
    expect(await redis.zrange("lb", 16, 100, { byScore: true })).toEqual(["ann", "bob"]);
  });

  it("expiry", async () => {
    await redis.set("short", "1", { px: 50 });
    expect(await redis.get("short")).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(await redis.get("short")).toBeNull();
    await redis.set("persist", "1");
    expect(await redis.expire("persist", 100)).toBe(1);
    expect(await redis.persist("persist")).toBe(1);
    expect(await redis.ttl("persist")).toBe(-1);
  });

  it("scan iterates the whole keyspace", async () => {
    for (let i = 0; i < 25; i++) await redis.set(`scan:${i}`, i);
    const found: string[] = [];
    let cursor: string | number = 0;
    do {
      const [next, keys]: [string | number, string[]] = await redis.scan(cursor, { match: "scan:*", count: 7 });
      found.push(...keys);
      cursor = next;
    } while (String(cursor) !== "0");
    expect(found.length).toBe(25);
  });

  it("pipeline and multi-exec", async () => {
    const p = redis.pipeline();
    p.set("p1", "a");
    p.incr("p2");
    p.get("p1");
    expect(await p.exec()).toEqual(["OK", 1, "a"]);
    const tx = redis.multi();
    tx.incr("p2");
    tx.incr("p2");
    expect(await tx.exec()).toEqual([2, 3]);
  });

  it("auto pipelining", async () => {
    const r = new Redis({ url: `${s.url}/redis`, token: REDIS_TOKEN, enableAutoPipelining: true, retry: false });
    const [a, b] = await Promise.all([r.set("ap", "1"), r.get("ap")]);
    expect(a).toBe("OK");
    expect(b).toBe(1);
  });

  it("eval and evalsha with scripts", async () => {
    expect(await redis.eval("return redis.call('SET', KEYS[1], ARGV[1])", ["ek"], ["ev"])).toBe("OK");
    expect(await redis.eval("return {KEYS[1], ARGV[1], 42}", ["k"], ["v"])).toEqual(["k", "v", 42]);
    const sha = await redis.scriptLoad("return redis.call('GET', KEYS[1])");
    expect(await redis.evalsha(sha, ["ek"], [])).toBe("ev");
    await expect(redis.evalsha("0".repeat(40), [], [])).rejects.toThrow(/NOSCRIPT/);
    const script = redis.createScript<string>("return ARGV[1] .. '!'");
    expect(await script.exec([], ["hi"])).toBe("hi!");
  });

  it("errors surface as UpstashError with the Redis message", async () => {
    await redis.hset("h-wrong", { a: 1 });
    await expect(redis.get("h-wrong")).rejects.toThrow(/WRONGTYPE/);
  });

  it("rejects bad tokens and enforces read-only tokens", async () => {
    const bad = new Redis({ url: `${s.url}/redis`, token: "nope", retry: false });
    await expect(bad.get("x")).rejects.toThrow(/Unauthorized/);
    const ro = new Redis({ url: `${s.url}/redis`, token: READONLY_TOKEN, retry: false });
    await redis.set("ro-key", "v");
    expect(await ro.get("ro-key")).toBe("v");
    await expect(ro.set("ro-key", "w")).rejects.toThrow(/NOPERM/);
  });

  it("works with responseEncoding disabled", async () => {
    const plain = new Redis({ url: `${s.url}/redis`, token: REDIS_TOKEN, responseEncoding: false, retry: false });
    await plain.set("plain", "text value");
    expect(await plain.get("plain")).toBe("text value");
  });
});
