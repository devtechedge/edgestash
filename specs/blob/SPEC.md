# Vercel Blob API: behaviour spec (as consumed by `@vercel/blob` 2.8.x)

Derived from the Apache-2.0 SDK bundle (`dist/chunk-*.js`, `dist/index.js`, `dist/client.js`)
and REA static analysis. Evidence: `evidence/digests/vercel-blob.digest.json`
(raw Evidence SHA-256 recorded in `evidence/SHA256SUMS`). No traffic against the
hosted service was recorded; items that could only be observed live are listed under Unknowns.

## Base URL and configuration

| Variable | Effect (SDK) |
| --- | --- |
| `VERCEL_BLOB_API_URL` / `NEXT_PUBLIC_VERCEL_BLOB_API_URL` | Overrides `https://vercel.com/api/blob`. This is the only change needed to target edgestash. |
| `BLOB_READ_WRITE_TOKEN` | Bearer token. Store id is `token.split("_")[3]`, so tokens look like `vercel_blob_rw_<storeId>_<secret>`. |
| `VERCEL_BLOB_API_VERSION_OVERRIDE` | Replaces the `x-api-version` value (default `13`). |
| `VERCEL_BLOB_RETRIES` | Retry count (default 10) for `unknown_error`, `service_unavailable`, `internal_server_error` and network errors. |
| `VERCEL_BLOB_USE_X_CONTENT_LENGTH` | When `1`, SDK sends `x-content-length`. |

## Common request headers

`authorization: Bearer <token>`, `x-api-version: 13`, `x-api-blob-request-id: <storeId>:<ms>:<hex>`,
`x-api-blob-request-attempt: <n>`, `x-vercel-blob-store-id: <storeId>`.

## Endpoints (paths relative to the API URL)

| SDK call | Method and path | Notes |
| --- | --- | --- |
| `put` | `PUT /?pathname=<p>` body = bytes | headers `x-vercel-blob-access`, `x-add-random-suffix` (`1`/`0`), `x-allow-overwrite`, `x-content-type`, `x-cache-control-max-age`, `x-if-match` |
| `createFolder` | `PUT /?pathname=<p>/` no body | `x-add-random-suffix: 0` |
| `head` | `GET /?url=<urlOrPathname>` | returns metadata JSON |
| `list` | `GET /?limit&prefix&cursor&mode` | `mode=folded` adds `folders[]` |
| `del` | `POST /delete` JSON `{urls: []}` | optional `x-if-match` for a single url |
| `copy` | `PUT /?pathname=<to>&fromUrl=<from>` | same option headers as put |
| `rename` | `POST /rename?pathname=<to>&fromUrl=<from>` | |
| multipart create | `POST /mpu?pathname=` `x-mpu-action: create` | returns `{key, uploadId}` |
| multipart part | `POST /mpu?pathname=` `x-mpu-action: upload`, `x-mpu-key` (URI-encoded), `x-mpu-upload-id`, `x-mpu-part-number` | returns `{etag}` |
| multipart complete | `POST /mpu?pathname=` `x-mpu-action: complete`, JSON body `[{partNumber, etag}]` | returns put result |
| client token (server side) | none: `generateClientTokenFromReadWriteToken` signs locally with HMAC-SHA256 | token = `vercel_blob_client_<storeId>_<base64(hmac.payload)>` |
| `put-optimized`, `put-from-url`, `signed-token` | image optimisation and delegation | not implemented (see Unknowns) |

## Response shapes

Put/copy/rename/complete: `{url, downloadUrl, pathname, contentType, contentDisposition, etag}`.
Head: adds `size`, `cacheControl`, `uploadedAt` (ISO string). List: `{blobs: [{url, downloadUrl, pathname, size, uploadedAt, etag}], cursor, hasMore, folders?}`.

## Errors

Non-2xx with JSON `{error: {code, message}}`. Codes mapped by the SDK: `store_suspended`, `forbidden`,
`content_type_not_allowed`, `client_token_pathname_mismatch`, `client_token_expired` (message `Token expired`),
`file_too_large`, `not_found`, `store_not_found`, `bad_request`, `service_unavailable` (retried),
`rate_limited` (reads `retry-after`), `precondition_failed`, `unknown_error` (retried). Messages
containing `contentType ... is not allowed` and `"pathname" ... does not match the token payload`
are re-mapped client side, so the server should use those wordings.

## Quirks

- `get()` refuses URLs that are not on `*.blob.vercel-storage.com` and builds one from the store id
  for pathnames, so `get()` cannot target a self-hosted server; fetch `blob.url` directly instead.
- `head` uses GET because HEAD responses have no body.
- Random suffix is 21 alphanumeric characters appended before the extension on the hosted service.
- Without `allowOverwrite`, putting an existing pathname fails (`bad_request`, "This blob already exists").

## Unknowns

- Exact hosted random suffix alphabet and length (we use 21 chars `[A-Za-z0-9]`).
- Exact hosted cursor format (ours is opaque base64url).
- Image optimisation pipeline (`put-optimized`), OIDC, presigned delegation tokens.
