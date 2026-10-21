import { createHash, randomBytes } from "node:crypto";
import { contentTypeFor } from "./mime.js";
import type { BlobMeta, BlobStorage } from "./storage.js";
import { hmacHex, storeIdFromToken, verifyClientToken, type ClientTokenPayload } from "./tokens.js";

export interface BlobApiOptions {
  storage: BlobStorage;
  /** Accepted read-write tokens (`vercel_blob_rw_<storeId>_<secret>`). */
  tokens: string[];
  /** Public origin used to build blob URLs, e.g. http://localhost:3333. */
  publicUrl: string;
  maxSizeBytes?: number;
  fetchImpl?: typeof fetch;
  onEvent?: (event: string) => void;
}

const DEFAULT_MAX_AGE = 2592000; // one month, matching the hosted default
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const err = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json", ...headers } });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

export function randomSuffix(len = 21): string {
  const bytes = randomBytes(len);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export function withRandomSuffix(pathname: string): string {
  const slash = pathname.lastIndexOf("/");
  const dir = pathname.slice(0, slash + 1);
  const file = pathname.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const [name, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ""];
  return `${dir}${name}-${randomSuffix()}${ext}`;
}

type Auth =
  | { kind: "rw"; storeId: string; token: string }
  | { kind: "client"; storeId: string; token: string; payload: ClientTokenPayload; rwToken: string };

interface MpuState { storeId: string; pathname: string; headers: Record<string, string>; parts: Map<number, { etag: string; data: Uint8Array }>; client?: ClientTokenPayload }

export class BlobApi {
  private uploads = new Map<string, MpuState>();
  constructor(readonly opts: BlobApiOptions) {}

  blobUrl(storeId: string, pathname: string): string {
    return `${this.opts.publicUrl.replace(/\/$/, "")}/s/${storeId}/${pathname.split("/").map(encodeURIComponent).join("/")}`;
  }
  downloadUrl(storeId: string, pathname: string): string {
    return `${this.blobUrl(storeId, pathname)}?download=1`;
  }

  /** Accepts a full blob URL (ours) or a bare pathname. */
  pathnameFrom(urlOrPathname: string): string {
    try {
      const u = new URL(urlOrPathname);
      const parts = u.pathname.split("/").filter((p, i) => i > 0 || p);
      // ours: /s/<storeId>/<path...>; hosted style: /<path...>
      const p = parts[0] === "s" ? parts.slice(2) : parts;
      return p.map(decodeURIComponent).join("/");
    } catch {
      return urlOrPathname;
    }
  }

  private authenticate(req: Request): Auth | Response {
    const h = req.headers.get("authorization") ?? "";
    const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (!token) return err(403, "forbidden", "Access denied, please provide a valid token for this resource.");
    if (token.startsWith("vercel_blob_client_")) {
      const storeId = storeIdFromToken(token);
      const rwToken = this.opts.tokens.find((t) => storeIdFromToken(t) === storeId);
      const payload = rwToken ? verifyClientToken(token, rwToken) : null;
      if (!rwToken || !payload) return err(403, "forbidden", "Access denied, please provide a valid token for this resource.");
      if (payload.validUntil !== undefined && payload.validUntil < Date.now()) return err(403, "forbidden", "Token expired");
      return { kind: "client", storeId, token, payload, rwToken };
    }
    if (!this.opts.tokens.includes(token)) return err(403, "forbidden", "Access denied, please provide a valid token for this resource.");
    return { kind: "rw", storeId: storeIdFromToken(token), token };
  }

  private toPutResult(m: BlobMeta) {
    return {
      url: this.blobUrl(m.storeId, m.pathname),
      downloadUrl: this.downloadUrl(m.storeId, m.pathname),
      pathname: m.pathname,
      contentType: m.contentType,
      contentDisposition: m.contentDisposition,
      etag: m.etag,
    };
  }
  private toHeadResult(m: BlobMeta) {
    return { ...this.toPutResult(m), size: m.size, cacheControl: m.cacheControl, uploadedAt: m.uploadedAt };
  }
  private toListItem(m: BlobMeta) {
    return { url: this.blobUrl(m.storeId, m.pathname), downloadUrl: this.downloadUrl(m.storeId, m.pathname), pathname: m.pathname, size: m.size, uploadedAt: m.uploadedAt, etag: m.etag };
  }

  async handle(req: Request, subpath: string): Promise<Response> {
    const auth = this.authenticate(req);
    if (auth instanceof Response) return auth;
    const url = new URL(req.url);
    const q = url.searchParams;
    const route = subpath.replace(/^\/+|\/+$/g, "");
    const clientAllowed = (route === "" && req.method === "PUT" && !q.has("fromUrl")) || route === "mpu";
    if (auth.kind === "client" && !clientAllowed) {
      return err(403, "client_token_not_allowed", "This operation is not available when using a client token. Use a read\u2013write or OIDC token on the server.");
    }
    try {
      if (route === "" && req.method === "GET") return q.has("url") ? this.head(auth, q.get("url")!) : this.list(auth, q);
      if (route === "" && req.method === "PUT") {
        if (q.has("fromUrl")) return await this.copy(auth, q.get("fromUrl")!, q.get("pathname") ?? "", req.headers, false);
        return await this.put(auth, q.get("pathname") ?? "", req);
      }
      if (route === "delete" && req.method === "POST") return await this.del(auth, req);
      if (route === "rename" && req.method === "POST") return await this.copy(auth, q.get("fromUrl")!, q.get("pathname") ?? "", req.headers, true);
      if (route === "mpu" && req.method === "POST") return await this.mpu(auth, q.get("pathname") ?? "", req);
      if (route === "put-optimized" || route === "put-from-url" || route === "signed-token") {
        return err(400, "bad_request", `Vercel Blob: ${route} is not supported by edgestash`);
      }
      return err(404, "not_found", "The requested blob does not exist");
    } catch (e) {
      return err(500, "unknown_error", e instanceof Error ? e.message : String(e));
    }
  }

  private validatePathname(p: string): Response | null {
    if (!p) return err(400, "bad_request", "pathname is required");
    if (p.length > 950) return err(400, "bad_request", "pathname is too long, maximum length is 950");
    return null;
  }

  private buildMeta(storeId: string, pathname: string, headers: Headers, data: Uint8Array, client?: ClientTokenPayload): BlobMeta | Response {
    const contentType = headers.get("x-content-type") || contentTypeFor(pathname);
    if (client?.allowedContentTypes?.length) {
      const allowed = client.allowedContentTypes.some((t) => (t.endsWith("/*") ? contentType.startsWith(t.slice(0, -1)) : t === contentType));
      if (!allowed) return err(400, "bad_request", `contentType ${contentType} is not allowed`);
    }
    const max = client?.maximumSizeInBytes ?? this.opts.maxSizeBytes;
    if (max !== undefined && data.length > max) return err(400, "bad_request", `File is too large, the file length cannot be greater than ${max} bytes`);
    const maxAgeHeader = headers.get("x-cache-control-max-age") ?? (client?.cacheControlMaxAge !== undefined ? String(client.cacheControlMaxAge) : null);
    const maxAge = maxAgeHeader !== null ? Number(maxAgeHeader) : DEFAULT_MAX_AGE;
    const filename = pathname.split("/").pop() ?? pathname;
    return {
      storeId,
      pathname,
      size: data.length,
      contentType,
      contentDisposition: `inline; filename="${filename.replace(/"/g, "")}"`,
      cacheControl: `public, max-age=${maxAge}`,
      access: headers.get("x-vercel-blob-access") === "private" ? "private" : "public",
      uploadedAt: new Date().toISOString(),
      etag: `"${createHash("sha256").update(data).digest("hex").slice(0, 32)}"`,
    };
  }

  /** Resolve final pathname plus overwrite and If-Match checks shared by put, copy and multipart. */
  private resolveTarget(auth: Auth, requested: string, headers: Headers): { pathname: string } | Response {
    const client = auth.kind === "client" ? auth.payload : undefined;
    if (client?.pathname !== undefined && client.pathname !== requested) {
      return err(400, "bad_request", `"pathname" ${requested} does not match the token payload`);
    }
    const suffixHeader = headers.get("x-add-random-suffix");
    const addSuffix = suffixHeader !== null ? suffixHeader === "1" : client?.addRandomSuffix === true;
    const overwriteHeader = headers.get("x-allow-overwrite");
    const allowOverwrite = overwriteHeader !== null ? overwriteHeader === "1" : client?.allowOverwrite === true;
    const pathname = addSuffix ? withRandomSuffix(requested) : requested;
    const existing = this.opts.storage.head(auth.storeId, pathname);
    const ifMatch = headers.get("x-if-match") ?? client?.ifMatch;
    if (ifMatch && (!existing || existing.etag !== ifMatch)) return err(412, "precondition_failed", "Precondition failed: ETag mismatch");
    if (existing && !allowOverwrite && !ifMatch) {
      return err(400, "bad_request", "Vercel Blob: This blob already exists, use `allowOverwrite: true` if you want to overwrite it. Or `addRandomSuffix: true` to generate a unique filename.");
    }
    return { pathname };
  }

  private async put(auth: Auth, requested: string, req: Request): Promise<Response> {
    const bad = this.validatePathname(requested);
    if (bad) return bad;
    const target = this.resolveTarget(auth, requested, req.headers);
    if (target instanceof Response) return target;
    const data = new Uint8Array(await req.arrayBuffer());
    const meta = this.buildMeta(auth.storeId, target.pathname, req.headers, data, auth.kind === "client" ? auth.payload : undefined);
    if (meta instanceof Response) return meta;
    await this.opts.storage.put(meta, data);
    this.opts.onEvent?.("blob.put");
    const result = this.toPutResult(meta);
    if (auth.kind === "client") await this.notifyUploadCompleted(auth, result);
    return ok(result);
  }

  private async notifyUploadCompleted(auth: Extract<Auth, { kind: "client" }>, blob: ReturnType<BlobApi["toPutResult"]>): Promise<void> {
    const cb = auth.payload.onUploadCompleted;
    if (!cb?.callbackUrl) return;
    const body = JSON.stringify({ type: "blob.upload-completed", payload: { blob, tokenPayload: cb.tokenPayload ?? null } });
    try {
      await (this.opts.fetchImpl ?? fetch)(cb.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vercel-signature": hmacHex(body, auth.rwToken) },
        body,
      });
      this.opts.onEvent?.("blob.callback");
    } catch {
      this.opts.onEvent?.("blob.callback_failed");
    }
  }

  private head(auth: Auth, urlOrPathname: string): Response {
    const m = this.opts.storage.head(auth.storeId, this.pathnameFrom(urlOrPathname));
    if (!m) return err(404, "not_found", "The requested blob does not exist");
    return ok(this.toHeadResult(m));
  }

  private list(auth: Auth, q: URLSearchParams): Response {
    const limit = Math.min(Math.max(Number(q.get("limit") ?? 1000) || 1000, 1), 1000);
    const prefix = q.get("prefix") ?? "";
    const cursor = q.get("cursor");
    const after = cursor ? Buffer.from(cursor, "base64url").toString("utf8") : null;
    const folded = q.get("mode") === "folded";
    const all = this.opts.storage.list(auth.storeId).filter((m) => m.pathname.startsWith(prefix));
    type Item = { sortKey: string; blob?: BlobMeta; folder?: string };
    let items: Item[] = all.map((m) => ({ sortKey: m.pathname, blob: m }));
    if (folded) {
      const folders = new Set<string>();
      const out: Item[] = [];
      for (const m of all) {
        const rest = m.pathname.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0 && slash < rest.length - 1) folders.add(prefix + rest.slice(0, slash + 1));
        else if (slash === rest.length - 1 && rest.length > 0) folders.add(m.pathname);
        else out.push({ sortKey: m.pathname, blob: m });
      }
      for (const f of folders) out.push({ sortKey: f, folder: f });
      items = out.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    }
    if (after !== null) items = items.filter((i) => i.sortKey > after);
    const page = items.slice(0, limit);
    const hasMore = items.length > limit;
    const body: Record<string, unknown> = {
      blobs: page.filter((i) => i.blob).map((i) => this.toListItem(i.blob!)),
      cursor: hasMore ? Buffer.from(page[page.length - 1]!.sortKey).toString("base64url") : undefined,
      hasMore,
    };
    if (folded) body.folders = page.filter((i) => i.folder).map((i) => i.folder!);
    return ok(body);
  }

  private async del(auth: Auth, req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { urls?: string[] } | null;
    if (!body || !Array.isArray(body.urls)) return err(400, "bad_request", "urls is required");
    const ifMatch = req.headers.get("x-if-match");
    if (ifMatch && body.urls.length === 1) {
      const m = this.opts.storage.head(auth.storeId, this.pathnameFrom(body.urls[0]!));
      if (!m || m.etag !== ifMatch) return err(412, "precondition_failed", "Precondition failed: ETag mismatch");
    }
    for (const u of body.urls) await this.opts.storage.delete(auth.storeId, this.pathnameFrom(u));
    this.opts.onEvent?.("blob.delete");
    return ok({});
  }

  private async copy(auth: Auth, from: string, to: string, headers: Headers, move: boolean): Promise<Response> {
    const bad = this.validatePathname(to);
    if (bad) return bad;
    const src = await this.opts.storage.get(auth.storeId, this.pathnameFrom(from));
    if (!src) return err(404, "not_found", "The requested blob does not exist");
    const target = this.resolveTarget(auth, to, headers);
    if (target instanceof Response) return target;
    const h = new Headers(headers);
    if (!h.has("x-content-type")) h.set("x-content-type", src.meta.contentType);
    if (!h.has("x-cache-control-max-age")) h.set("x-cache-control-max-age", src.meta.cacheControl.replace(/.*max-age=/, ""));
    const meta = this.buildMeta(auth.storeId, target.pathname, h, src.data);
    if (meta instanceof Response) return meta;
    await this.opts.storage.put(meta, src.data);
    if (move && src.meta.pathname !== meta.pathname) await this.opts.storage.delete(auth.storeId, src.meta.pathname);
    this.opts.onEvent?.(move ? "blob.rename" : "blob.copy");
    return ok(this.toPutResult(meta));
  }

  private async mpu(auth: Auth, requested: string, req: Request): Promise<Response> {
    const action = req.headers.get("x-mpu-action");
    if (action === "create") {
      const bad = this.validatePathname(requested);
      if (bad) return bad;
      const target = this.resolveTarget(auth, requested, req.headers);
      if (target instanceof Response) return target;
      const uploadId = randomSuffix(32);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { if (k.startsWith("x-")) headers[k] = v; });
      this.uploads.set(uploadId, { storeId: auth.storeId, pathname: target.pathname, headers, parts: new Map(), client: auth.kind === "client" ? auth.payload : undefined });
      return ok({ key: target.pathname, uploadId });
    }
    const uploadId = req.headers.get("x-mpu-upload-id") ?? "";
    const state = this.uploads.get(uploadId);
    if (!state || state.storeId !== auth.storeId) return err(404, "not_found", "The multipart upload does not exist");
    if (action === "upload") {
      const n = Number(req.headers.get("x-mpu-part-number"));
      if (!Number.isInteger(n) || n < 1 || n > 10000) return err(400, "bad_request", "invalid part number");
      const data = new Uint8Array(await req.arrayBuffer());
      const etag = `"${createHash("md5").update(data).digest("hex")}"`;
      state.parts.set(n, { etag, data });
      return ok({ etag });
    }
    if (action === "complete") {
      const parts = (await req.json().catch(() => null)) as Array<{ partNumber: number; etag: string }> | null;
      if (!Array.isArray(parts) || parts.length === 0) return err(400, "bad_request", "parts are required");
      const chunks: Uint8Array[] = [];
      for (const p of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
        const stored = state.parts.get(p.partNumber);
        if (!stored || stored.etag !== p.etag) return err(400, "bad_request", `part ${p.partNumber} is missing or its etag does not match`);
        chunks.push(stored.data);
      }
      const data = Buffer.concat(chunks);
      const meta = this.buildMeta(state.storeId, state.pathname, new Headers(state.headers), data, state.client);
      if (meta instanceof Response) return meta;
      await this.opts.storage.put(meta, data);
      this.uploads.delete(uploadId);
      this.opts.onEvent?.("blob.mpu_complete");
      const result = this.toPutResult(meta);
      if (auth.kind === "client") await this.notifyUploadCompleted(auth, result);
      return ok(result);
    }
    return err(400, "bad_request", "unknown x-mpu-action");
  }

  /** Serve blob bytes at /s/<storeId>/<pathname> with hosted-like headers and Range support. */
  async serve(req: Request, storeId: string, pathname: string): Promise<Response> {
    const found = await this.opts.storage.get(storeId, pathname);
    if (!found) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
    const { meta, data } = found;
    if (meta.access === "private") {
      const h = req.headers.get("authorization") ?? "";
      const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
      if (!this.opts.tokens.includes(token) || storeIdFromToken(token) !== storeId) return new Response("Forbidden", { status: 403 });
    }
    const url = new URL(req.url);
    const filename = pathname.split("/").pop() ?? pathname;
    const headers: Record<string, string> = {
      "content-type": meta.contentType,
      etag: meta.etag,
      "last-modified": new Date(meta.uploadedAt).toUTCString(),
      "cache-control": meta.cacheControl,
      "accept-ranges": "bytes",
      "content-disposition": url.searchParams.get("download") === "1" ? `attachment; filename="${filename.replace(/"/g, "")}"` : meta.contentDisposition,
      "x-content-type-options": "nosniff",
    };
    if (req.headers.get("if-none-match") === meta.etag) return new Response(null, { status: 304, headers });
    const range = req.headers.get("range");
    const m = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : data.length - Number(m[2]);
      let end = m[1] && m[2] ? Number(m[2]) : data.length - 1;
      start = Math.max(0, start);
      end = Math.min(end, data.length - 1);
      if (start > end) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${data.length}` } });
      const slice = data.subarray(start, end + 1);
      return new Response(req.method === "HEAD" ? null : (slice as Uint8Array<ArrayBuffer>), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${data.length}`, "content-length": String(slice.length) } });
    }
    return new Response(req.method === "HEAD" ? null : (data as Uint8Array<ArrayBuffer>), { status: 200, headers: { ...headers, "content-length": String(data.length) } });
  }
}
