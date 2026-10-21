// Builds small, reviewable digests from raw REA Evidence and writes SHA256SUMS.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawDir = join(root, "evidence", "raw");
const outDir = join(root, "evidence", "digests");
mkdirSync(outDir, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sums = [];

const INTEREST = /^(x-|authorization|upstash-|content-|cache-control|bearer|\/|https?:|evalsha|eval|pipeline|multi-exec|redis\.call|EVAL|NOSCRIPT)/i;

for (const file of readdirSync(rawDir).filter((f) => f.endsWith(".json.gz")).sort()) {
  const gz = readFileSync(join(rawDir, file));
  const raw = gunzipSync(gz);
  const ev = JSON.parse(raw.toString("utf8"));
  const nr = ev.normalized_result ?? {};
  const sg = nr.semantic_graph ?? { nodes: [] };
  const loc = (n) => {
    const v = n.evidence?.location?.value;
    return v ? `${v.source}:${v.start?.line}` : undefined;
  };
  const byKind = (k) => sg.nodes.filter((n) => n.kind === k);
  const configSources = [...new Map(byKind("config-source").map((n) => [n.label, { key: n.properties?.key ?? n.label, at: loc(n) }])).values()].sort((a, b) => a.key.localeCompare(b.key));
  const literals = [...new Set(byKind("literal").map((n) => String(n.properties?.value ?? n.label)))].filter((v) => INTEREST.test(v) || v.length > 3).sort();
  const functions = [...new Set(byKind("function").map((n) => n.label).filter(Boolean))].sort();
  const propertySlots = [...new Set(byKind("property-slot").map((n) => n.label).filter((l) => l && INTEREST.test(l)))].sort();
  const digest = {
    schema: "edgestash.evidence-digest/v1",
    source: `evidence/raw/${file}`,
    raw_sha256: sha(raw),
    gzip_sha256: sha(gz),
    rea: { evidence_id: ev.evidence_id, operation: ev.operation, provider: ev.provider, confidence: ev.confidence, authority: ev.authority },
    subject: { name: ev.subject?.name, sha256: ev.subject?.digest?.sha256, format: ev.subject?.format },
    statistics: nr.statistics,
    semantic_counts: { nodes: sg.nodes.length, relations: sg.relations?.length, unknowns: sg.unknowns?.length },
    limitations: ev.limitations,
    config_sources: configSources,
    interesting_literals: literals,
    interesting_property_slots: propertySlots,
    functions,
  };
  const name = file.replace(/\.json\.gz$/, "");
  const body = JSON.stringify(digest, null, 2) + "\n";
  writeFileSync(join(outDir, `${name}.digest.json`), body);
  sums.push(`${sha(gz)}  raw/${file}`, `${sha(body)}  digests/${name}.digest.json`);
}
writeFileSync(join(root, "evidence", "SHA256SUMS"), sums.join("\n") + "\n");
console.log(sums.join("\n"));
