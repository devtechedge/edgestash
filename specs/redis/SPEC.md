# Upstash Redis REST API: behaviour spec (as consumed by `@upstash/redis` 1.39 and `@upstash/ratelimit` 2.2)

Derived from the MIT SDK bundles and REA static analysis. Evidence:
`evidence/digests/upstash-redis.digest.json`, `evidence/digests/upstash-ratelimit.digest.json`.
REA surfaced the config sources `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
`KV_REST_API_URL`, `KV_REST_API_TOKEN` and every Lua script literal used by ratelimit.

## Transport

- Every call is `POST <baseUrl>/<path...>` with `Content-Type: application/json`
  and `Authorization: Bearer <token>`. Body for a single command is the JSON array
  `["SET","k","v"]`; numbers are sent as JSON numbers and must be stringified server side.
- `/pipeline` and `/multi-exec`: body is an array of command arrays. Response is an array of
  `{result}` or `{error}` items. `multi-exec` is atomic.
- `Upstash-Encoding: base64` (SDK default): every string in the result is base64 encoded,
  except the status reply `OK`. Integers and null pass through. Nested arrays are decoded
  up to two levels by the SDK.
- `upstash-sync-token` request header is echoed back for read-your-writes; we return a monotonic counter.
- Telemetry headers `Upstash-Telemetry-Runtime|Platform|Sdk|Retry` are informational.
- Retries: 5 attempts with `exp(n) * 50` ms backoff, only on network errors.

## Responses

- Success: `200 {"result": <value>}`.
- Command error: `400 {"error": "ERR ..."}`; SDK throws `UpstashError("<error>, command was: ...")`.
- Auth failure: `401 {"error": "Unauthorized"}`.

## EVAL / EVALSHA (ratelimit)

`@upstash/ratelimit` runs scripts with `EVALSHA sha numkeys keys... args...` and falls back to
`EVAL` on an error containing `NOSCRIPT`. Scripts start with `#!lua flags=allow-key-locking`
(a shebang line Redis 7 accepts) and use `redis.call` with `GET`, `INCRBY`, `PEXPIRE`, `HSET`,
`HGETALL`, `HMGET`, `SMISMEMBER`, `TTL`, `SETEX`, `SCAN`, `DEL`, plus `unpack`, `tonumber`,
`math.floor`, `math.ceil`, `math.min`. Lua to Redis conversion rules: number becomes integer
(truncated), `false` becomes nil, table becomes array up to the first nil, `{ok=...}`/`{err=...}`.

## Unknowns

- Hosted Upstash error wording beyond the `ERR` prefix is matched to real Redis wording.
- `Upstash-Response-Format: resp2` raw mode and SSE `subscribe` streams are not implemented.
