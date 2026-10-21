#!/usr/bin/env node
import { createEdgestash, VERSION } from "./app.js";
import { serve } from "./node.js";

const app = await createEdgestash();
const server = await serve(app);
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : app.config.port;
const c = app.config;
console.log(`edgestash ${VERSION} listening on http://${c.host}:${port}`);
console.log(`  Blob API   VERCEL_BLOB_API_URL=${c.publicUrl}/api/blob  (storage: ${app.blob.opts.storage.kind}${c.dataDir ? `, ${c.dataDir}` : ""})`);
console.log(`  Redis REST UPSTASH_REDIS_REST_URL=${c.publicUrl}/redis  (backend: ${app.backend.kind})`);
if (c.blobTokens[0]?.includes("edgestashdevsecret")) console.log(`  Using dev tokens. Set BLOB_READ_WRITE_TOKEN and EDGESTASH_REDIS_TOKEN in production.`);
const stop = async () => {
  server.close();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
