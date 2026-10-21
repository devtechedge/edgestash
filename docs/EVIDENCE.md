# Evidence format

Behaviour was derived from the published SDK bundles, never from hosted service internals.
REA (`rea-agents` 6.7.0, "Reverse Engineer Anything") statically analysed each package:

```bash
rea analyze-javascript-application node_modules/@vercel/blob --artifact-format directory --format json
```

`scripts/collect-evidence.sh` runs this for `@vercel/blob`, `@upstash/redis` and `@upstash/ratelimit`,
gzips each raw Evidence document into `evidence/raw/` (2.5 to 24 MB, attached to GitHub releases rather
than committed) and calls `scripts/digest-evidence.mjs`, which writes `evidence/digests/<sdk>.digest.json`
and `evidence/SHA256SUMS`.

## Digest schema (`edgestash.evidence-digest/v1`)

| Field | Meaning |
| --- | --- |
| `raw_sha256`, `gzip_sha256` | SHA-256 of the raw REA JSON and of its gzip file |
| `rea.evidence_id` | REA's content-addressed Evidence id |
| `subject.sha256` | Digest REA computed over the analysed package root |
| `statistics` | Files parsed, AST nodes visited, findings |
| `config_sources` | Environment variables the SDK reads, with source locations |
| `interesting_literals` | String literals such as headers, paths and full Lua scripts |
| `functions` | Function names in the semantic graph |
| `limitations` | REA's own stated limits for the run |

## What the evidence established

- Blob: `VERCEL_BLOB_API_URL` override, `x-api-version` 13, retry env vars, every `x-*` option header,
  error code mapping and the message substrings the SDK re-maps client side.
- Redis: `UPSTASH_REDIS_REST_URL`/`KV_REST_API_URL` sources, base64 response decoding rules.
- Ratelimit: the complete set of Lua scripts and the Redis commands they call, including the
  `#!lua flags=allow-key-locking` shebang that stock Redis rejects.

Verify a release asset: `sha256sum -c evidence/SHA256SUMS` from the `evidence` folder after
downloading the `raw/*.json.gz` files.
