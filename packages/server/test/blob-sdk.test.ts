import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLOB_TOKEN, start, type Running } from "./helpers.js";

// The official SDK reads the API base URL from the environment at call time.
let s: Running;
let blob: typeof import("@vercel/blob");
beforeAll(async () => {
  s = await start();
  process.env.VERCEL_BLOB_API_URL = `${s.url}/api/blob`;
  process.env.VERCEL_BLOB_RETRIES = "0";
  blob = await import("@vercel/blob");
});
afterAll(async () => s.stop());
const opts = { token: BLOB_TOKEN } as const;

describe("@vercel/blob against edgestash", () => {
  it("put returns url, downloadUrl, pathname, contentType, etag", async () => {
    const r = await blob.put("hello/world.txt", "hello world", { access: "public", ...opts });
    expect(r.pathname).toBe("hello/world.txt");
    expect(r.url).toBe(`${s.url}/s/teststore/hello/world.txt`);
    expect(r.downloadUrl).toBe(`${r.url}?download=1`);
    expect(r.contentType).toBe("text/plain");
    expect(r.etag).toMatch(/^".+"$/);
    const res = await fetch(r.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello world");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("cache-control")).toBe("public, max-age=2592000");
    const dl = await fetch(r.downloadUrl);
    expect(dl.headers.get("content-disposition")).toBe('attachment; filename="world.txt"');
  });

  it("refuses to overwrite unless allowOverwrite is set", async () => {
    await blob.put("dup.txt", "a", { access: "public", ...opts });
    await expect(blob.put("dup.txt", "b", { access: "public", ...opts })).rejects.toThrow(/already exists/);
    const r = await blob.put("dup.txt", "c", { access: "public", allowOverwrite: true, ...opts });
    expect(await (await fetch(r.url)).text()).toBe("c");
  });

  it("addRandomSuffix inserts a 21 character suffix before the extension", async () => {
    const r = await blob.put("photos/cat.png", Buffer.from([1, 2, 3]), { access: "public", addRandomSuffix: true, ...opts });
    expect(r.pathname).toMatch(/^photos\/cat-[A-Za-z0-9]{21}\.png$/);
    expect(r.contentType).toBe("image/png");
  });

  it("honours contentType and cacheControlMaxAge", async () => {
    const r = await blob.put("data.bin", "{}", { access: "public", contentType: "application/json", cacheControlMaxAge: 60, ...opts });
    const h = await blob.head(r.url, opts);
    expect(h.contentType).toBe("application/json");
    expect(h.cacheControl).toBe("public, max-age=60");
    expect(h.size).toBe(2);
    expect(h.uploadedAt).toBeInstanceOf(Date);
  });

  it("head by pathname and BlobNotFoundError for missing blobs", async () => {
    await blob.put("head-me.txt", "x", { access: "public", ...opts });
    expect((await blob.head("head-me.txt", opts)).pathname).toBe("head-me.txt");
    await expect(blob.head("nope.txt", opts)).rejects.toBeInstanceOf(blob.BlobNotFoundError);
  });

  it("lists with prefix, limit and cursor pagination", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) await blob.put(`page/${n}.txt`, n, { access: "public", ...opts });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await blob.list({ prefix: "page/", limit: 2, cursor, ...opts });
      seen.push(...r.blobs.map((b) => b.pathname));
      cursor = r.cursor;
      if (r.hasMore) expect(r.cursor).toBeTruthy();
    } while (cursor);
    expect(seen).toEqual(["page/a.txt", "page/b.txt", "page/c.txt", "page/d.txt", "page/e.txt"]);
  });

  it("list folded mode returns folders", async () => {
    await blob.put("tree/x/1.txt", "1", { access: "public", ...opts });
    await blob.put("tree/y/2.txt", "2", { access: "public", ...opts });
    await blob.put("tree/root.txt", "r", { access: "public", ...opts });
    const r = await blob.list({ prefix: "tree/", mode: "folded", ...opts });
    expect(r.folders).toEqual(["tree/x/", "tree/y/"]);
    expect(r.blobs.map((b) => b.pathname)).toEqual(["tree/root.txt"]);
  });

  it("del removes one or many blobs by url or pathname", async () => {
    const a = await blob.put("del/a.txt", "a", { access: "public", ...opts });
    await blob.put("del/b.txt", "b", { access: "public", ...opts });
    await blob.del([a.url, "del/b.txt"], opts);
    expect((await blob.list({ prefix: "del/", ...opts })).blobs).toHaveLength(0);
    expect((await fetch(a.url)).status).toBe(404);
  });

  it("copy duplicates a blob and keeps content type", async () => {
    const src = await blob.put("copy/src.json", '{"a":1}', { access: "public", ...opts });
    const c = await blob.copy(src.url, "copy/dst.json", { access: "public", ...opts });
    expect(c.pathname).toBe("copy/dst.json");
    expect(c.contentType).toBe("application/json");
    expect(await (await fetch(c.url)).text()).toBe('{"a":1}');
  });

  it("multipart upload via put({ multipart: true }) reassembles parts", async () => {
    const big = Buffer.alloc(12 * 1024 * 1024, 7);
    big[0] = 1;
    big[big.length - 1] = 9;
    const r = await blob.put("big/file.bin", big, { access: "public", multipart: true, ...opts });
    const res = await fetch(r.url);
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.length).toBe(big.length);
    expect(got.equals(big)).toBe(true);
  });

  it("manual multipart API: createMultipartUpload, uploadPart, completeMultipartUpload", async () => {
    const { key, uploadId } = await blob.createMultipartUpload("manual/mpu.txt", { access: "public", ...opts });
    const p1 = await blob.uploadPart("manual/mpu.txt", "x".repeat(5 * 1024 * 1024), { access: "public", key, uploadId, partNumber: 1, ...opts });
    const p2 = await blob.uploadPart("manual/mpu.txt", "tail", { access: "public", key, uploadId, partNumber: 2, ...opts });
    const r = await blob.completeMultipartUpload("manual/mpu.txt", [p1, p2], { access: "public", key, uploadId, ...opts });
    const text = await (await fetch(r.url)).text();
    expect(text.length).toBe(5 * 1024 * 1024 + 4);
    expect(text.endsWith("tail")).toBe(true);
  });

  it("rejects bad tokens with BlobAccessError", async () => {
    await expect(blob.put("x.txt", "x", { access: "public", token: "vercel_blob_rw_teststore_wrong" })).rejects.toBeInstanceOf(blob.BlobAccessError);
  });

  it("serves Range requests and conditional GETs", async () => {
    const r = await blob.put("range.txt", "0123456789", { access: "public", ...opts });
    const part = await fetch(r.url, { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("2345");
    const nm = await fetch(r.url, { headers: { "if-none-match": r.etag } });
    expect(nm.status).toBe(304);
  });

  it("private blobs require the read-write token to download", async () => {
    const r = await blob.put("secret.txt", "s3cr3t", { access: "private", ...opts });
    expect((await fetch(r.url)).status).toBe(403);
    const ok = await fetch(r.url, { headers: { authorization: `Bearer ${BLOB_TOKEN}` } });
    expect(await ok.text()).toBe("s3cr3t");
  });

  it("ifMatch conditional overwrite fails with BlobPreconditionFailedError on mismatch", async () => {
    const r = await blob.put("cond.txt", "v1", { access: "public", ...opts });
    await expect(blob.put("cond.txt", "v2", { access: "public", ifMatch: '"nope"', ...opts })).rejects.toBeInstanceOf(blob.BlobPreconditionFailedError);
    const r2 = await blob.put("cond.txt", "v2", { access: "public", ifMatch: r.etag, ...opts });
    expect(r2.etag).not.toBe(r.etag);
  });

  it("createFolder creates a zero byte folder marker", async () => {
    const r = await blob.createFolder("folder-a", opts);
    expect(r.pathname).toBe("folder-a/");
  });
});
