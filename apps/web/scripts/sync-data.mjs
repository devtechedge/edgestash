// Copies conformance results into the app so pages can render them statically.
import { readFileSync, writeFileSync } from "node:fs";
const src = new URL("../../../packages/server/conformance/results.json", import.meta.url);
const r = JSON.parse(readFileSync(src, "utf8"));
const slim = { generatedAt: r.generatedAt, redisServer: r.redisServer, total: r.total, pass: r.pass, rate: r.rate, byGroup: r.byGroup };
writeFileSync(new URL("../lib/conformance.json", import.meta.url), JSON.stringify(slim, null, 2) + "\n");
