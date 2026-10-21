# Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EDGESTASH_PORT` (or `PORT`) | `3333` | Listen port |
| `EDGESTASH_HOST` | `0.0.0.0` | Listen address |
| `EDGESTASH_PUBLIC_URL` | `http://localhost:<port>` | Origin used in blob URLs |
| `EDGESTASH_DATA_DIR` | `.data` | Blob files and Redis snapshot. Empty string = memory only |
| `BLOB_READ_WRITE_TOKEN` / `EDGESTASH_BLOB_TOKENS` | dev token | Comma separated `vercel_blob_rw_<storeId>_<secret>` tokens. One store per token |
| `EDGESTASH_REDIS_TOKEN` / `EDGESTASH_REDIS_TOKENS` | `edgestash-dev-token` | Full access REST tokens |
| `EDGESTASH_REDIS_READONLY_TOKENS` | none | Tokens limited to read commands |
| `EDGESTASH_ADMIN_TOKEN` | first Redis token | Dashboard and `/api/admin/*` |
| `EDGESTASH_REDIS_BACKEND` | `embedded` | Or `redis://[user:pass@]host:port` to proxy |
| `EDGESTASH_SNAPSHOT_INTERVAL_MS` | `5000` | Redis snapshot cadence when dirty (0 disables periodic saves) |
| `EDGESTASH_MAX_BLOB_BYTES` | unlimited | Upload size cap |

Token format matters: the Blob SDK reads the store id from the fourth `_` separated segment, so
store ids must not contain `_`.

## Endpoints

| Path | Purpose |
| --- | --- |
| `/api/blob/*` | Vercel Blob API |
| `/s/<storeId>/<pathname>` | Blob downloads (`?download=1` for attachment) |
| `/redis`, `/redis/pipeline`, `/redis/multi-exec`, `/redis/<cmd>/<args...>` | Upstash REST |
| `/api/admin/stats`, `/keys`, `/key`, `/blobs` | Dashboard API (admin token) |
| `/metrics` | Prometheus text format |
| `/healthz` | Liveness |

## Embedding

```ts
import { createEdgestash } from "edgestash";
const app = await createEdgestash({ dataDir: "", blobTokens: ["vercel_blob_rw_app_secret"] });
export default { fetch: (req: Request) => app.fetch(req) }; // any Fetch API runtime
```
