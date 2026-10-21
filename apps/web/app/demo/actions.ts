"use server";

import { headers } from "next/headers";
import { DEMO, getEdgestash, getLocalUrl, originFrom } from "@/lib/edgestash";

export interface Step { api: string; call: string; ms: number; ok: boolean; result: unknown }

async function step(steps: Step[], api: string, call: string, fn: () => Promise<unknown>) {
  const t = performance.now();
  try {
    const result = await fn();
    steps.push({ api, call, ms: Math.round(performance.now() - t), ok: true, result });
  } catch (e) {
    steps.push({ api, call, ms: Math.round(performance.now() - t), ok: false, result: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
}

/** Runs the official, unmodified SDKs against this instance of edgestash over HTTP. */
export async function runDemo(text: string): Promise<Step[]> {
  const app = await getEdgestash();
  if (!process.env.EDGESTASH_PUBLIC_URL) app.blob.opts.publicUrl = originFrom(await headers());
  const local = await getLocalUrl();
  process.env.VERCEL_BLOB_API_URL = `${local}/api/blob`;
  process.env.VERCEL_BLOB_RETRIES = "0";
  const blob = await import("@vercel/blob");
  const { Redis } = await import("@upstash/redis");
  const { Ratelimit } = await import("@upstash/ratelimit");
  const token = DEMO.blobToken;
  const redis = new Redis({ url: `${local}/redis`, token: DEMO.redisToken, retry: false });
  const steps: Step[] = [];
  const body = (text || "hello from the edgestash demo").slice(0, 2000);

  let url = "";
  await step(steps, "blob", `put("demo/note.txt", { addRandomSuffix: true })`, async () => {
    const r = await blob.put("demo/note.txt", body, { access: "public", addRandomSuffix: true, contentType: "text/plain", token });
    url = r.url;
    return r;
  });
  await step(steps, "blob", "head(url)", () => blob.head(url, { token }));
  await step(steps, "blob", `copy(url, "demo/copy.txt")`, () => blob.copy(url, "demo/copy.txt", { access: "public", allowOverwrite: true, token }));
  await step(steps, "blob", `list({ prefix: "demo/", mode: "folded" })`, async () => {
    const r = await blob.list({ prefix: "demo/", token });
    return { count: r.blobs.length, hasMore: r.hasMore, first: r.blobs.slice(0, 3).map((b) => b.pathname) };
  });
  await step(steps, "redis", `set("demo:last", { text, at })`, () => redis.set("demo:last", { text: body.slice(0, 80), at: new Date().toISOString() }, { ex: 3600 }));
  await step(steps, "redis", `get("demo:last")`, () => redis.get("demo:last"));
  await step(steps, "redis", `incr("demo:runs")`, () => redis.incr("demo:runs"));
  await step(steps, "redis", `zincrby("demo:words", 1, word) for each word`, async () => {
    const p = redis.pipeline();
    for (const w of body.toLowerCase().split(/\W+/).filter(Boolean).slice(0, 20)) p.zincrby("demo:words", 1, w);
    await p.exec();
    return redis.zrange("demo:words", 0, 4, { rev: true, withScores: true });
  });
  await step(steps, "redis", "multi().hset().hincrby().exec()", () => redis.multi().hset("demo:visitor", { seen: "yes" }).hincrby("demo:visitor", "count", 1).exec());
  const rl = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, "30 s"), prefix: "demo:rl", analytics: false, ephemeralCache: false });
  await step(steps, "ratelimit", `slidingWindow(5, "30 s").limit("visitor")`, async () => {
    const r = await rl.limit("visitor");
    return { success: r.success, limit: r.limit, remaining: r.remaining, reset: new Date(r.reset).toISOString() };
  });
  return steps;
}
