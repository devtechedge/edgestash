export interface EdgestashConfig {
  port: number;
  host: string;
  /** Public origin used in blob URLs. */
  publicUrl: string;
  /** Directory for blobs and Redis snapshots; empty string means in-memory only. */
  dataDir: string;
  blobTokens: string[];
  redisTokens: string[];
  redisReadonlyTokens: string[];
  adminToken: string;
  /** "embedded" (default) or a redis:// URL to proxy to a real Redis. */
  redisBackend: string;
  snapshotIntervalMs: number;
  maxBlobSizeBytes?: number;
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const DEV_BLOB_TOKEN = "vercel_blob_rw_local_edgestashdevsecret";
export const DEV_REDIS_TOKEN = "edgestash-dev-token";

/** Load configuration from EDGESTASH_* environment variables with dev-friendly defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): EdgestashConfig {
  const port = Number(env.EDGESTASH_PORT ?? env.PORT ?? 3333);
  const host = env.EDGESTASH_HOST ?? "0.0.0.0";
  const redisTokens = list(env.EDGESTASH_REDIS_TOKENS ?? env.EDGESTASH_REDIS_TOKEN);
  return {
    port,
    host,
    publicUrl: env.EDGESTASH_PUBLIC_URL ?? `http://localhost:${port}`,
    dataDir: env.EDGESTASH_DATA_DIR ?? ".data",
    blobTokens: list(env.EDGESTASH_BLOB_TOKENS ?? env.BLOB_READ_WRITE_TOKEN).length ? list(env.EDGESTASH_BLOB_TOKENS ?? env.BLOB_READ_WRITE_TOKEN) : [DEV_BLOB_TOKEN],
    redisTokens: redisTokens.length ? redisTokens : [DEV_REDIS_TOKEN],
    redisReadonlyTokens: list(env.EDGESTASH_REDIS_READONLY_TOKENS),
    adminToken: env.EDGESTASH_ADMIN_TOKEN ?? (redisTokens[0] ?? DEV_REDIS_TOKEN),
    redisBackend: env.EDGESTASH_REDIS_BACKEND ?? "embedded",
    snapshotIntervalMs: Number(env.EDGESTASH_SNAPSHOT_INTERVAL_MS ?? 5000),
    maxBlobSizeBytes: env.EDGESTASH_MAX_BLOB_BYTES ? Number(env.EDGESTASH_MAX_BLOB_BYTES) : undefined,
  };
}
