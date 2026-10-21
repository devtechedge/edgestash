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
