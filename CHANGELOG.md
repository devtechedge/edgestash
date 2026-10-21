# Changelog

## 0.1.0 (2026-10-21)

First release.

- Vercel Blob compatible API: put (single and multipart), head, list (cursor, folded), del, copy, rename, createFolder, client uploads with signed completion callbacks, public and private downloads with Range and ETag.
- Upstash Redis REST compatible API: single, path style, pipeline, multi-exec, base64 encoding, read-only tokens.
- Embedded Redis engine in TypeScript: strings, hashes, lists, sets, sorted sets, TTLs, SCAN family, EVAL and EVALSHA on Lua (fengari).
- Proxy backend for a real Redis, with ratelimit shebang rewriting.
- Works with unmodified @vercel/blob 2.8, @upstash/redis 1.39 and @upstash/ratelimit 2.2.
- Differential conformance against redis-server 8.0.2: 2381 of 2381 cases.
- Filesystem storage and JSON snapshots, Prometheus metrics, Docker image and compose file.
- Next.js dashboard and live demo.
- REA evidence digests with SHA-256 manifest, and per API behaviour specs.
