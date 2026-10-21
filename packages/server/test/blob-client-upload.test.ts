import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLOB_TOKEN, start, type Running } from "./helpers.js";

let s: Running;
let route: Server;
let routeUrl = "";
const completed: unknown[] = [];

beforeAll(async () => {
  s = await start();
  process.env.VERCEL_BLOB_API_URL = `${s.url}/api/blob`;
  process.env.VERCEL_BLOB_RETRIES = "0";
  const { handleUpload } = await import("@vercel/blob/client");
  // A tiny "app route" using the unmodified handleUpload helper.
  route = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const request = new Request(`http://127.0.0.1${req.url}`, { method: "POST", headers: req.headers as Record<string, string>, body });
    try {
      const json = await handleUpload({
        body: JSON.parse(body),
        request,
        token: BLOB_TOKEN,
        onBeforeGenerateToken: async (pathname) => ({
          allowedContentTypes: ["text/plain", "image/*"],
          maximumSizeInBytes: 1024,
          callbackUrl: routeUrl,
          tokenPayload: JSON.stringify({ user: "dev", pathname }),
        }),
        onUploadCompleted: async (payload) => { completed.push(payload); },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  await new Promise<void>((r) => route.listen(0, "127.0.0.1", () => r()));
  routeUrl = `http://127.0.0.1:${(route.address() as AddressInfo).port}/api/upload`;
});
afterAll(async () => {
  route.close();
  await s.stop();
});

describe("client uploads (handleUpload + upload)", () => {
  it("uploads through a client token and fires the signed completion callback", async () => {
    const { upload } = await import("@vercel/blob/client");
    const r = await upload("client/hello.txt", new Blob(["from the browser"], { type: "text/plain" }), { access: "public", handleUploadUrl: routeUrl, contentType: "text/plain" });
    expect(r.pathname).toBe("client/hello.txt");
    expect(await (await fetch(r.url)).text()).toBe("from the browser");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ blob: { pathname: "client/hello.txt" }, tokenPayload: JSON.stringify({ user: "dev", pathname: "client/hello.txt" }) });
  });

  it("enforces allowedContentTypes from the token", async () => {
    const { upload } = await import("@vercel/blob/client");
    await expect(upload("client/bad.json", new Blob(["{}"], { type: "application/json" }), { access: "public", handleUploadUrl: routeUrl, contentType: "application/json" })).rejects.toThrow(/not allowed/);
  });

  it("enforces maximumSizeInBytes from the token", async () => {
    const { upload } = await import("@vercel/blob/client");
    await expect(upload("client/big.txt", new Blob(["x".repeat(2048)], { type: "text/plain" }), { access: "public", handleUploadUrl: routeUrl, contentType: "text/plain" })).rejects.toThrow(/too large|cannot be greater/);
  });

  it("client tokens cannot list or delete", async () => {
    const { generateClientTokenFromReadWriteToken } = await import("@vercel/blob/client");
    const { list } = await import("@vercel/blob");
    const token = await generateClientTokenFromReadWriteToken({ token: BLOB_TOKEN, pathname: "x.txt" });
    await expect(list({ token })).rejects.toThrow(/client token/);
  });

  it("rejects a client token for a different pathname", async () => {
    const { generateClientTokenFromReadWriteToken, put } = await import("@vercel/blob/client");
    const token = await generateClientTokenFromReadWriteToken({ token: BLOB_TOKEN, pathname: "only-this.txt" });
    await expect(put("other.txt", "x", { access: "public", token })).rejects.toBeInstanceOf((await import("@vercel/blob")).BlobPathnameMismatchError);
  });

  it("rejects expired client tokens", async () => {
    const { generateClientTokenFromReadWriteToken, put } = await import("@vercel/blob/client");
    const token = await generateClientTokenFromReadWriteToken({ token: BLOB_TOKEN, pathname: "late.txt", validUntil: Date.now() - 1000 });
    await expect(put("late.txt", "x", { access: "public", token })).rejects.toBeInstanceOf((await import("@vercel/blob")).BlobClientTokenExpiredError);
  });
});
