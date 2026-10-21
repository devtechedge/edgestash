import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createEdgestash } from "../src/app.js";
import { BLOB_TOKEN, REDIS_TOKEN } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "edgestash-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cfg = { dataDir: dir, blobTokens: [BLOB_TOKEN], redisTokens: [REDIS_TOKEN], publicUrl: "http://x", snapshotIntervalMs: 0 };

describe("filesystem persistence", () => {
  it("blobs and redis keys survive a restart", async () => {
    const a = await createEdgestash(cfg);
    const put = await a.fetch(new Request("http://x/api/blob/?pathname=keep/me.txt", { method: "PUT", headers: { authorization: `Bearer ${BLOB_TOKEN}` }, body: "persisted" }));
    expect(put.status).toBe(200);
    await a.fetch(new Request("http://x/redis", { method: "POST", headers: { authorization: `Bearer ${REDIS_TOKEN}` }, body: '["HSET","h","f","v"]' }));
    await a.close();

    const b = await createEdgestash(cfg);
    const got = await b.fetch(new Request("http://x/s/teststore/keep/me.txt"));
    expect(await got.text()).toBe("persisted");
    const r = await b.fetch(new Request("http://x/redis", { method: "POST", headers: { authorization: `Bearer ${REDIS_TOKEN}` }, body: '["HGET","h","f"]' }));
    expect(await r.json()).toEqual({ result: "v" });
    await b.close();
  });
});
