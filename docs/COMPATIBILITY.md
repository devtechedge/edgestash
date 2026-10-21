# Compatibility matrix

Tested with `@vercel/blob` 2.8.2, `@upstash/redis` 1.39.0 and `@upstash/ratelimit` 2.2.0 using the
unmodified packages in `packages/server/test`. "Yes" means an SDK-level test covers it.

## @vercel/blob

| SDK function / option | Status | Notes |
| --- | --- | --- |
| `put` string, Buffer, Blob, stream | Yes | |
| `access: "public"` | Yes | Served at `/s/<storeId>/<pathname>` |
| `access: "private"` | Yes | Download needs the read-write bearer token |
| `addRandomSuffix` | Yes | 21 chars `[A-Za-z0-9]` before the extension |
| `allowOverwrite`, `ifMatch` | Yes | 400 `already exists`, 412 `precondition_failed` |
| `contentType`, `cacheControlMaxAge` | Yes | Default `public, max-age=2592000`; type inferred from extension |
| `multipart: true` | Yes | Tested with 12 MB |
| `createMultipartUpload`, `uploadPart`, `completeMultipartUpload` | Yes | |
| `head` (URL or pathname) | Yes | `BlobNotFoundError` on 404 |
| `list` prefix, limit, cursor, `mode: "folded"` | Yes | |
| `del` single or array, URL or pathname | Yes | |
| `copy`, `rename` | Yes | |
| `createFolder` | Yes | |
| `upload` + `handleUpload` (client uploads) | Yes | Signed completion callback included |
| `generateClientTokenFromReadWriteToken` limits | Yes | pathname, content types, size, expiry |
| Error classes | Yes | Access, NotFound, PreconditionFailed, PathnameMismatch, ClientTokenExpired |
| `get()` helper | No | The SDK refuses non `*.blob.vercel-storage.com` URLs. Use `fetch(blob.url)` |
| `putImage`, `put-from-url`, presigned URLs, OIDC | No | Returns `bad_request` |
| `onUploadProgress` | Yes | Client side only |

## @upstash/redis

| Area | Status |
| --- | --- |
| Single command `POST /`, path style `POST /set/k/v`, `_token` query auth | Yes |
| `/pipeline`, `/multi-exec`, `enableAutoPipelining` | Yes |
| `Upstash-Encoding: base64` (SDK default) and `responseEncoding: false` | Yes |
| `upstash-sync-token` read-your-writes header | Yes (monotonic counter) |
| Read-only tokens | Yes (`NOPERM` on writes) |
| Strings: GET SET (EX PX EXAT PXAT NX XX KEEPTTL GET) SETNX SETEX PSETEX MGET MSET MSETNX GETSET GETDEL GETEX APPEND STRLEN INCR DECR INCRBY DECRBY INCRBYFLOAT GETRANGE SETRANGE SUBSTR | Yes |
| Keys: DEL UNLINK EXISTS TOUCH TYPE EXPIRE PEXPIRE EXPIREAT PEXPIREAT (NX XX GT LT) TTL PTTL EXPIRETIME PEXPIRETIME PERSIST KEYS SCAN (MATCH COUNT TYPE) RENAME RENAMENX COPY RANDOMKEY DBSIZE FLUSHDB FLUSHALL PING ECHO TIME | Yes |
| Hashes: HSET HSETNX HMSET HGET HMGET HGETALL HKEYS HVALS HLEN HEXISTS HSTRLEN HDEL HINCRBY HINCRBYFLOAT HRANDFIELD HSCAN | Yes |
| Lists: LPUSH RPUSH LPUSHX RPUSHX LPOP RPOP (count) LLEN LRANGE LINDEX LSET LREM LTRIM LINSERT LPOS LMOVE RPOPLPUSH | Yes |
| Sets: SADD SREM SMEMBERS SISMEMBER SMISMEMBER SCARD SPOP SRANDMEMBER SINTER SUNION SDIFF SINTERCARD SINTERSTORE SUNIONSTORE SDIFFSTORE SMOVE SSCAN | Yes |
| Sorted sets: ZADD (NX XX GT LT CH INCR) ZINCRBY ZSCORE ZMSCORE ZCARD ZCOUNT ZLEXCOUNT ZRANGE (BYSCORE BYLEX REV LIMIT WITHSCORES) ZREVRANGE ZRANGEBYSCORE ZREVRANGEBYSCORE ZRANGEBYLEX ZRANK ZREVRANK (WITHSCORE) ZREM ZREMRANGEBYRANK ZREMRANGEBYSCORE ZPOPMIN ZPOPMAX ZRANDMEMBER ZSCAN | Yes |
| Scripting: EVAL EVALSHA EVAL_RO EVALSHA_RO SCRIPT LOAD/EXISTS/FLUSH, `createScript` | Yes |
| Blocking commands (BLPOP...), Pub/Sub over SSE, streams, JSON, bitmaps, HyperLogLog, geo | Not yet (`ERR unknown command`) |

With `EDGESTASH_REDIS_BACKEND=redis://...` every command your Redis supports passes through.

## @upstash/ratelimit

| Feature | Status |
| --- | --- |
| `fixedWindow`, `slidingWindow`, `tokenBucket` | Yes (limit, remaining, reset, custom `rate`) |
| `cachedFixedWindow` | Yes |
| `getRemaining`, `resetUsedTokens`, `blockUntilReady` | Yes |
| `analytics: true` | Yes |
| `enableProtection` deny lists | Yes (SMISMEMBER script path) |
| Multi-region `MultiRegionRatelimit` | Untested |
