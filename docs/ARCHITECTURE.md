# Architecture

```
            @vercel/blob                     @upstash/redis, @upstash/ratelimit
                 |                                        |
     VERCEL_BLOB_API_URL=/api/blob           UPSTASH_REDIS_REST_URL=/redis
                 v                                        v
 +-----------------------------------------------------------------------------+
 |  createEdgestash().fetch(Request) -> Response     (Web Fetch API, no framework)|
 |                                                                             |
 |  /api/blob/*   BlobApi        /redis/*  handleRedisRest      /s/<store>/*   |
 |   auth: rw + client tokens     auth: bearer or _token          downloads    |
 |   put/head/list/del/copy       single, /pipeline, /multi-exec  Range, ETag  |
 |   rename/mpu/callbacks         base64 encoding, sync token     private auth |
 |        |                              |                                     |
 |   BlobStorage                    RedisBackend                               |
 |   memory | fs (sha256 files       EmbeddedBackend -> RedisEngine (TS)       |
 |   + JSON sidecars)                ProxyBackend    -> RESP2 -> redis-server  |
 |                                                                             |
 |  /api/admin/*  dashboard API     /metrics Prometheus     /healthz           |
 +-----------------------------------------------------------------------------+
        |                       |                           |
   Node http adapter       Next.js route handler      any Fetch runtime
   (CLI, Docker)           (apps/web on Vercel)
```

## Packages

| Path | Role |
| --- | --- |
| `packages/server` | The `edgestash` package: engine, both APIs, Node adapter, CLI, tests, conformance harness |
| `apps/web` | Next.js landing page, live demo and dashboard. Mounts the same fetch handler through rewrites |
| `examples` | Stock SDK scripts configured only through environment variables |
| `evidence` | REA analysis digests and SHA-256 manifest |
| `specs` | Behaviour specs for each API surface |

## Redis engine

- `Keyspace` holds `Map<string, Entry>`; each entry is a tagged union (string, hash, list, set, zset) with an optional absolute `expireAt` in ms. Expiry is lazy on access plus a 1 s background sweep, like Redis.
- Commands are registered in a table with Redis arity rules (`define(name, arity, run, write)`), so arity errors match Redis wording.
- Integers use `BigInt` for the INCR family to keep signed 64-bit semantics and overflow errors. Floats are formatted with Redis rules (`inf`, no trailing `.0`).
- Execution is synchronous and single threaded, so every command, pipeline and `EVAL` is atomic, matching Redis's model.
- Scripting runs Lua 5.3 on fengari. The bridge exposes `redis.call`, `redis.pcall`, `redis.error_reply`, `redis.status_reply`, `redis.sha1hex`, `redis.log`, a 5.1 style `unpack`, and strips `io`, `os`, `require`, `loadfile`, `dofile`. Reply conversion follows the Redis Lua rules (numbers truncate, `false` is nil, `{ok=}` and `{err=}` tables).
- Persistence is a JSON snapshot (`<dataDir>/redis.json`) written atomically when the keyspace is dirty and on shutdown.

## Proxy backend

`EDGESTASH_REDIS_BACKEND=redis://host:6379` swaps the engine for a pipelining RESP2 client. Requests are serialised per connection so `/multi-exec` maps onto `MULTI ... EXEC` without interleaving. Upstash's `#!lua flags=allow-key-locking` shebang (used by every @upstash/ratelimit script) is rewritten because stock Redis rejects that flag, and the SDK's SHA of the original body is mapped so `EVALSHA` keeps working.

## Blob storage

`MemoryBlobStorage` keeps bytes and metadata in maps. `FsBlobStorage` writes `<dir>/<storeId>/<sha256(pathname)>.bin` plus a `.json` metadata sidecar and rebuilds the in-memory index on start. Listing is lexicographic with an opaque base64url cursor; `mode=folded` groups by the next `/`.

Multipart uploads keep parts in memory until `complete`, verify every part's ETag, then write one object. Client uploads verify the HMAC-SHA256 signed client token with the store's read-write token, enforce `pathname`, `allowedContentTypes`, `maximumSizeInBytes` and `validUntil`, and POST a signed `blob.upload-completed` callback (`x-vercel-signature`) the unmodified `handleUpload` helper accepts.
