import { describe, expect, it } from "vitest";
import { RedisEngine } from "../src/redis/engine.js";
import { encodeReply, stringify } from "../src/redis/rest.js";
import { dump, load } from "../src/redis/snapshot.js";
import { Keyspace } from "../src/redis/keyspace.js";
import { Status } from "../src/redis/types.js";
import { formatFloat, globToRegExp, parseFloatArg } from "../src/redis/util.js";

const mk = () => {
  let t = 1_000_000;
  const e = new RedisEngine({ now: () => t });
  return { e, run: (...a: (string | number)[]) => e.exec(a.map(String)), advance: (ms: number) => { t += ms; } };
};

describe("embedded engine", () => {
  it("expires keys lazily using the injected clock", () => {
    const { run, advance } = mk();
    run("SET", "k", "v", "PX", 100);
    expect(run("PTTL", "k")).toBe(100);
    advance(99);
    expect(run("GET", "k")).toBe("v");
    advance(1);
    expect(run("GET", "k")).toBeNull();
    expect(run("TTL", "k")).toBe(-2);
  });

  it("keeps 64-bit integer precision", () => {
    const { run } = mk();
    run("SET", "n", "9007199254740993");
    expect(run("INCR", "n")).toBe(9007199254740994n);
    expect(() => run("INCRBY", "n", "9223372036854775807")).toThrow(/overflow/);
  });

  it("deletes empty containers automatically", () => {
    const { run } = mk();
    run("RPUSH", "l", "a");
    run("LPOP", "l");
    expect(run("EXISTS", "l")).toBe(0);
  });

  it("rejects nested EVAL and enforces arity", () => {
    const { run } = mk();
    expect(() => run("EVAL", "return redis.call('EVAL', 'return 1', 0)", 0)).toThrow(/not allowed from script/);
    expect(() => run("GET")).toThrow(/wrong number of arguments for 'get'/);
  });

  it("runs every @upstash/ratelimit Lua idiom: shebang, unpack, HGETALL loops, PEXPIRE", () => {
    const { run } = mk();
    const script = `#!lua flags=allow-key-locking
      local fields = redis.call("HGETALL", KEYS[1])
      local total = 0
      for i = 2, #fields, 2 do total = total + tonumber(fields[i]) end
      redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
      redis.call("PEXPIRE", KEYS[1], 1000)
      return {total, unpack({1, 2})}`;
    expect(run("EVAL", script, 1, "h", "a", 5)).toEqual([0, 1, 2]);
    expect(run("EVAL", script, 1, "h", "b", 7)).toEqual([5, 1, 2]);
    expect(run("PTTL", "h")).toBe(1000);
  });

  it("tracks per-command stats", () => {
    const { e, run } = mk();
    run("PING");
    run("PING");
    expect(e.stats.byCommand.PING).toBe(2);
  });
});

describe("helpers", () => {
  it("formats floats like Redis", () => {
    expect(formatFloat(3)).toBe("3");
    expect(formatFloat(1.5)).toBe("1.5");
    expect(formatFloat(Infinity)).toBe("inf");
    expect(formatFloat(1e21)).toBe("1e+21");
    expect(parseFloatArg("-inf")).toBe(-Infinity);
  });
  it("matches globs", () => {
    expect(globToRegExp("user:*").test("user:1")).toBe(true);
    expect(globToRegExp("h?llo").test("hello")).toBe(true);
    expect(globToRegExp("h[ae]llo").test("hillo")).toBe(false);
    expect(globToRegExp("h[^e]llo").test("hallo")).toBe(true);
    expect(globToRegExp("a\\*b").test("a*b")).toBe(true);
  });
  it("encodes replies as Upstash JSON with base64 except OK", () => {
    expect(encodeReply(new Status("OK"), true)).toBe("OK");
    expect(encodeReply(new Status("PONG"), true)).toBe(Buffer.from("PONG").toString("base64"));
    expect(encodeReply(["a", 1, null], true)).toEqual([Buffer.from("a").toString("base64"), 1, null]);
    expect(stringify({ result: encodeReply(12345678901234567890n, false) })).toBe('{"result":12345678901234567890}');
  });
  it("round-trips snapshots", () => {
    const { e, run } = mk();
    run("SET", "s", "v");
    run("HSET", "h", "f", "1");
    run("ZADD", "z", 2, "m");
    run("SADD", "set", "x");
    run("RPUSH", "l", "a", "b");
    const db = new Keyspace();
    db.now = () => 1_000_000;
    expect(load(db, dump(e.db))).toBe(5);
    expect(db.get("z")).toMatchObject({ type: "zset" });
    expect((db.get("h")!.value as Map<string, string>).get("f")).toBe("1");
  });
});
