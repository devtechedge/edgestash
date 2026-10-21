import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createEdgestash, type Edgestash } from "../src/app.js";
import { MemoryBlobStorage } from "../src/blob/storage.js";
import { serve } from "../src/node.js";

export const BLOB_TOKEN = "vercel_blob_rw_teststore_supersecret";
export const REDIS_TOKEN = "test-redis-token";
export const READONLY_TOKEN = "test-readonly-token";

export interface Running {
  app: Edgestash;
  server: Server;
  url: string;
  stop(): Promise<void>;
}

/** Boot an in-memory edgestash on a random port. */
export async function start(extra: Parameters<typeof createEdgestash>[0] = {}): Promise<Running> {
  const app = await createEdgestash(
    { dataDir: "", blobTokens: [BLOB_TOKEN], redisTokens: [REDIS_TOKEN], redisReadonlyTokens: [READONLY_TOKEN], adminToken: "admin", host: "127.0.0.1", port: 0, ...extra },
    { storage: new MemoryBlobStorage() },
  );
  const server = await serve(app, 0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  app.blob.opts.publicUrl = url;
  return {
    app,
    server,
    url,
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
      await app.close();
    },
  };
}

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect, createServer as netServer } from "node:net";

export const hasRedisServer = spawnSync("redis-server", ["--version"]).status === 0;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = netServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** Spawn a throwaway redis-server (no persistence) for differential tests. */
export async function startRedisServer(): Promise<{ url: string; stop(): void }> {
  const port = await freePort();
  const proc: ChildProcess = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no", "--bind", "127.0.0.1"], { stdio: "ignore" });
  const url = `redis://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => { sock.end(); resolve(true); });
      sock.once("error", () => resolve(false));
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { url, stop: () => proc.kill("SIGKILL") };
}

/** Backends to run SDK suites against: always embedded, plus proxy when redis-server exists. */
export const backends: Array<"embedded" | "proxy"> = hasRedisServer ? ["embedded", "proxy"] : ["embedded"];

export async function startWithBackend(kind: "embedded" | "proxy"): Promise<Running & { redisStop?: () => void }> {
  if (kind === "embedded") return start();
  const rs = await startRedisServer();
  const s = await start({ redisBackend: rs.url });
  return { ...s, redisStop: rs.stop, async stop() { await s.stop(); rs.stop(); } };
}
