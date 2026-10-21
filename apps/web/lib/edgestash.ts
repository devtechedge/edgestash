import "server-only";
import type { AddressInfo } from "node:net";
import { createEdgestash, serve, type Edgestash } from "edgestash";

export const DEMO = {
  blobToken: process.env.BLOB_READ_WRITE_TOKEN ?? "vercel_blob_rw_demo_publicdemosecret",
  redisToken: process.env.EDGESTASH_REDIS_TOKEN ?? "edgestash-demo-token",
  adminToken: process.env.EDGESTASH_ADMIN_TOKEN ?? "demo",
};

type Holder = { app?: Promise<Edgestash>; local?: Promise<string> };
const g = globalThis as unknown as { __edgestash?: Holder };
const holder: Holder = (g.__edgestash ??= {});

/** One edgestash instance per server process (per warm serverless instance on Vercel). */
export function getEdgestash(): Promise<Edgestash> {
  holder.app ??= createEdgestash({
    dataDir: process.env.EDGESTASH_DATA_DIR ?? "",
    publicUrl: process.env.EDGESTASH_PUBLIC_URL ?? "http://localhost:3000",
    blobTokens: [DEMO.blobToken],
    redisTokens: [DEMO.redisToken],
    adminToken: DEMO.adminToken,
    maxBlobSizeBytes: Number(process.env.EDGESTASH_MAX_BLOB_BYTES ?? 1024 * 1024),
    snapshotIntervalMs: 0,
  });
  return holder.app;
}

/**
 * Loopback listener for the same instance, so the demo can call it with the unmodified SDKs
 * over real HTTP and always reach the same in-memory state.
 */
export function getLocalUrl(): Promise<string> {
  holder.local ??= getEdgestash().then(async (app) => {
    const server = await serve(app, 0, "127.0.0.1");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  return holder.local;
}

export function originFrom(headers: Headers): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost:3000";
  const proto = headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
