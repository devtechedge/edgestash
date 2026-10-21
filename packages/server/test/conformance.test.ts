import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDifferential } from "../conformance/run.js";
import { hasRedisServer, startRedisServer } from "./helpers.js";

describe.skipIf(!hasRedisServer)("differential conformance vs real redis-server", () => {
  let rs: Awaited<ReturnType<typeof startRedisServer>>;
  beforeAll(async () => { rs = await startRedisServer(); });
  afterAll(() => rs?.stop());

  it("every curated case and 2000 fuzzed commands match redis-server", async () => {
    const { results, byGroup } = await runDifferential(rs.url, { fuzzOps: 2000, seed: 7 });
    const failures = results.filter((r) => !r.ok);
    if (failures.length) console.log(JSON.stringify(failures.slice(0, 20), null, 2));
    expect(Object.keys(byGroup)).toContain("fuzz");
    expect(failures).toEqual([]);
  }, 120_000);
});
