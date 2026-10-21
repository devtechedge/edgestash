import Link from "next/link";
import conformance from "@/lib/conformance.json";

const blobRows: [string, string][] = [
  ["put (single, multipart, addRandomSuffix, contentType, cacheControlMaxAge, allowOverwrite, ifMatch)", "yes"],
  ["head, list (prefix, limit, cursor, mode: folded), del, copy, createFolder", "yes"],
  ["createMultipartUpload, uploadPart, completeMultipartUpload", "yes"],
  ["handleUpload, upload (client tokens, signed onUploadCompleted callback)", "yes"],
  ["public and private access, download URLs, Range, ETag, 304", "yes"],
  ["get() helper (hard-codes *.blob.vercel-storage.com)", "fetch blob.url instead"],
  ["image optimisation, presigned delegation tokens, OIDC", "not yet"],
];
const redisRows: [string, string][] = [
  ["Strings, INCR family, SET options, GETEX, SETRANGE", "yes"],
  ["Hashes, lists, sets, sorted sets (BYSCORE, BYLEX, REV, LIMIT)", "yes"],
  ["TTL family with NX XX GT LT, SCAN, HSCAN, SSCAN, ZSCAN", "yes"],
  ["/pipeline, /multi-exec, auto pipelining, base64 encoding", "yes"],
  ["EVAL, EVALSHA, SCRIPT (Lua 5.3 via fengari)", "yes"],
  ["@upstash/ratelimit: fixed, sliding, token bucket, cached, deny lists", "yes"],
  ["Pub/Sub over SSE, streams, JSON, search", "not yet"],
];

export default function Home() {
  return (
    <>
      <div className="hero">
        <span className="pill">v0.1.0 · MIT · self-hostable</span>
        <h1>Your own Vercel Blob and Upstash Redis.<br />Same SDKs. One URL change.</h1>
        <p className="lead">
          edgestash is one small TypeScript server with two API surfaces. Unmodified <code>@vercel/blob</code>,{" "}
          <code>@upstash/redis</code> and <code>@upstash/ratelimit</code> talk to it after you change a base URL and token.
          Behaviour was derived from the open source SDK bundles with REA static analysis and checked against a real redis-server.
        </p>
        <div className="row" style={{ marginTop: 20 }}>
          <Link href="/demo" className="btn">Run the live demo</Link>
          <Link href="/dashboard"><button className="secondary">Open dashboard</button></Link>
          <a href="https://github.com/devtechedge/edgestash"><button className="secondary">Source on GitHub</button></a>
        </div>
      </div>

      <div className="grid">
        <div className="card"><div className="muted">Redis differential conformance</div><div className="stat ok">{conformance.rate}%</div><div className="muted">{conformance.pass} of {conformance.total} cases match redis-server {conformance.redisServer}</div></div>
        <div className="card"><div className="muted">Command groups</div><div className="stat">{Object.keys(conformance.byGroup).length}</div><div className="muted">strings, keys, hashes, lists, sets, zsets, scan, scripting, fuzz</div></div>
        <div className="card"><div className="muted">Runtime deps</div><div className="stat">1</div><div className="muted">fengari for Lua. Storage on local disk or memory.</div></div>
      </div>

      <section>
        <h2>Point the SDKs at it</h2>
        <pre>{`# Vercel Blob
VERCEL_BLOB_API_URL=http://localhost:3333/api/blob
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_local_edgestashdevsecret

# Upstash Redis
UPSTASH_REDIS_REST_URL=http://localhost:3333/redis
UPSTASH_REDIS_REST_TOKEN=edgestash-dev-token`}</pre>
        <pre>{`docker compose up -d     # or: npx edgestash`}</pre>
      </section>

      <section className="grid">
        <div className="card">
          <h3>Blob API</h3>
          <table><tbody>{blobRows.map(([f, s]) => <tr key={f}><td>{f}</td><td className={s === "yes" ? "ok" : "warn"}>{s}</td></tr>)}</tbody></table>
        </div>
        <div className="card">
          <h3>Redis REST API</h3>
          <table><tbody>{redisRows.map(([f, s]) => <tr key={f}><td>{f}</td><td className={s === "yes" ? "ok" : "warn"}>{s}</td></tr>)}</tbody></table>
        </div>
      </section>

      <section>
        <h2>Conformance by group</h2>
        <table>
          <thead><tr><th>Group</th><th>Pass</th><th>Total</th></tr></thead>
          <tbody>{Object.entries(conformance.byGroup).map(([g, v]) => <tr key={g}><td>{g}</td><td className="ok">{v.pass}</td><td>{v.total}</td></tr>)}</tbody>
        </table>
      </section>
    </>
  );
}
