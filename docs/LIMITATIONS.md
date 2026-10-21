# Limitations and unknowns

- **Single node.** No replication or clustering. The embedded engine is single threaded per process.
- **Persistence is snapshot based.** Writes between the last snapshot and a crash are lost (default cadence 5 s). Use the proxy backend with a real Redis for AOF durability.
- **Multipart parts live in memory** until completion.
- **Blob `get()` helper** cannot target self-hosted servers because the SDK validates the hostname. `fetch(blob.url)` works.
- **Not implemented:** image optimisation (`putImage`), `put-from-url`, presigned delegation tokens, OIDC auth, Redis blocking commands, Pub/Sub over SSE, streams, RedisJSON, search, bitmaps, HyperLogLog, geo, `Upstash-Response-Format: resp2`.
- **Hosted details we could not observe:** the exact hosted random suffix alphabet, list cursor format and some error wording. Ours are documented in `specs/blob/SPEC.md` and chosen to satisfy the SDK's parsing.
- **Lua is 5.3 (fengari), Redis uses 5.1.** Integer division and `tostring` of floats can differ for exotic scripts; every script shipped by @upstash/ratelimit is covered by tests and the differential suite.
- **The Vercel demo is per instance.** State lives in memory on one serverless instance and resets when it is recycled.
