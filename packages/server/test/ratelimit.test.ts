import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backends, REDIS_TOKEN, startWithBackend, type Running } from "./helpers.js";


describe.each(backends)("@upstash/ratelimit against edgestash (%s backend)", (backend) => {
  let s: Running;
  let redis: Redis;
  beforeAll(async () => {
    s = await startWithBackend(backend);
    redis = new Redis({ url: `${s.url}/redis`, token: REDIS_TOKEN, retry: false });
  });
  afterAll(async () => s.stop());

  const algos = {
    fixedWindow: () => Ratelimit.fixedWindow(3, "10 s"),
    slidingWindow: () => Ratelimit.slidingWindow(3, "10 s"),
    tokenBucket: () => Ratelimit.tokenBucket(1, "10 s", 3),
  };

  describe("suite", () => {
    for (const [name, limiter] of Object.entries(algos)) {
      it(`${name}: allows the limit then blocks`, async () => {
        const rl = new Ratelimit({ redis, limiter: limiter(), prefix: `rl:${name}`, analytics: false, ephemeralCache: false });
        const results = [];
        for (let i = 0; i < 5; i++) results.push(await rl.limit("user-1"));
        expect(results.map((r) => r.success)).toEqual([true, true, true, false, false]);
        expect(results[0]!.limit).toBe(3);
        expect(results[0]!.remaining).toBe(2);
        expect(results[3]!.remaining).toBe(0);
        expect(results[0]!.reset).toBeGreaterThan(Date.now());
        const other = await rl.limit("user-2");
        expect(other.success).toBe(true);
      });

      it(`${name}: getRemaining and resetUsedTokens`, async () => {
        const rl = new Ratelimit({ redis, limiter: limiter(), prefix: `rl2:${name}`, analytics: false, ephemeralCache: false });
        await rl.limit("u");
        const rem = await rl.getRemaining("u");
        expect(rem.remaining).toBe(2);
        await rl.resetUsedTokens("u");
        expect((await rl.getRemaining("u")).remaining).toBe(3);
      });

      it(`${name}: custom rate consumes several tokens`, async () => {
        const rl = new Ratelimit({ redis, limiter: limiter(), prefix: `rl3:${name}`, analytics: false, ephemeralCache: false });
        expect((await rl.limit("u", { rate: 2 })).success).toBe(true);
        expect((await rl.limit("u", { rate: 2 })).success).toBe(false);
      });
    }

    it("cachedFixedWindow works", async () => {
      const rl = new Ratelimit({ redis, limiter: Ratelimit.cachedFixedWindow(2, "10 s"), prefix: "rl:cached", analytics: false, ephemeralCache: new Map() });
      const r = [await rl.limit("x"), await rl.limit("x"), await rl.limit("x")];
      expect(r.map((x) => x.success)).toEqual([true, true, false]);
    });

    it("blockUntilReady resolves once allowed", async () => {
      const rl = new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(1, "1 s"), prefix: "rl:block", analytics: false, ephemeralCache: false });
      await rl.limit("b");
      const r = await rl.blockUntilReady("b", 3000);
      expect(r.success).toBe(true);
    });

    it("analytics mode records events without failing", async () => {
      const rl = new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(5, "10 s"), prefix: "rl:analytics", analytics: true, ephemeralCache: false });
      const r = await rl.limit("a");
      expect(r.success).toBe(true);
      await r.pending;
    });

    it("deny lists are checked with SMISMEMBER", async () => {
      const rl = new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(5, "10 s"), prefix: "rl:deny", analytics: false, ephemeralCache: false, enableProtection: true });
      await redis.sadd("rl:deny:denyList:all", "bad-user");
      const r = await rl.limit("bad-user");
      expect(r.success).toBe(false);
      expect(r.reason).toBe("denyList");
      await r.pending;
    });
  });
});
