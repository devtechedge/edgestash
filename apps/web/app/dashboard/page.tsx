"use client";

import { useCallback, useEffect, useState } from "react";

type Stats = {
  version: string; uptimeSeconds: number;
  redis: { backend: string; keys: number | null; commands: number | null; errors: number | null; byCommand: Record<string, number> };
  blob: { storage: string; stores: { storeId: string; count: number; bytes: number }[] };
};
type KeyRow = { key: string; type: string; ttlMs: number; size: number };
type BlobRow = { pathname: string; size: number; contentType: string; uploadedAt: string; url: string; access: string };

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtTtl = (ms: number) => (ms < 0 ? "no expiry" : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);

export default function Dashboard() {
  const [token, setToken] = useState("demo");
  const [match, setMatch] = useState("*");
  const [stats, setStats] = useState<Stats | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [blobs, setBlobs] = useState<BlobRow[]>([]);
  const [selected, setSelected] = useState<{ key: string; data: unknown } | null>(null);
  const [error, setError] = useState("");

  const api = useCallback(async (path: string) => {
    const r = await fetch(`/api/admin/${path}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${(await r.json().catch(() => ({}))).error ?? ""}`);
    return r.json();
  }, [token]);

  const refresh = useCallback(async () => {
    try {
      setError("");
      const [s, k, b] = await Promise.all([api("stats"), api(`keys?match=${encodeURIComponent(match)}`), api("blobs")]);
      setStats(s); setKeys(k.keys); setBlobs(b.blobs);
    } catch (e) { setError(String(e)); }
  }, [api, match]);

  useEffect(() => { void refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);

  const topCommands = stats ? Object.entries(stats.redis.byCommand).sort((a, b) => b[1] - a[1]).slice(0, 8) : [];
  return (
    <>
      <div className="hero" style={{ paddingBottom: 10 }}>
        <h1>Dashboard</h1>
        <div className="row">
          <label className="muted">Admin token <input value={token} onChange={(e) => setToken(e.target.value)} style={{ width: 160 }} /></label>
          <button className="secondary" onClick={refresh}>Refresh</button>
          {error && <span className="bad">{error}</span>}
        </div>
      </div>
      {stats && (
        <div className="grid">
          <div className="card"><div className="muted">Redis keys</div><div className="stat">{stats.redis.keys ?? "n/a"}</div><div className="muted">backend: {stats.redis.backend}</div></div>
          <div className="card"><div className="muted">Commands served</div><div className="stat">{stats.redis.commands ?? "n/a"}</div><div className="muted">{stats.redis.errors ?? 0} errors</div></div>
          <div className="card"><div className="muted">Blobs</div><div className="stat">{stats.blob.stores.reduce((n, s) => n + s.count, 0)}</div><div className="muted">{fmtBytes(stats.blob.stores.reduce((n, s) => n + s.bytes, 0))} on {stats.blob.storage}</div></div>
          <div className="card"><div className="muted">Uptime</div><div className="stat">{stats.uptimeSeconds}s</div><div className="muted">v{stats.version}</div></div>
        </div>
      )}
      <section className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}><h3>Keys</h3><input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="match glob" style={{ width: 160 }} /></div>
          <table>
            <thead><tr><th>Key</th><th>Type</th><th>Size</th><th>TTL</th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.key} style={{ cursor: "pointer" }} onClick={async () => setSelected({ key: k.key, data: await api(`key?k=${encodeURIComponent(k.key)}`) })}>
                  <td className="mono">{k.key}</td><td><span className="pill">{k.type}</span></td><td>{k.size}</td><td>{fmtTtl(k.ttlMs)}</td>
                </tr>
              ))}
              {keys.length === 0 && <tr><td colSpan={4} className="muted">No keys yet. Run the demo.</td></tr>}
            </tbody>
          </table>
          {selected && <pre>{selected.key}{"\n"}{JSON.stringify(selected.data, null, 2)}</pre>}
        </div>
        <div className="card">
          <h3>Blobs</h3>
          <table>
            <thead><tr><th>Pathname</th><th>Size</th><th>Type</th></tr></thead>
            <tbody>
              {blobs.map((b) => (
                <tr key={b.pathname}><td className="mono"><a href={b.url} target="_blank" rel="noreferrer">{b.pathname}</a> {b.access === "private" && <span className="pill">private</span>}</td><td>{fmtBytes(b.size)}</td><td className="muted">{b.contentType}</td></tr>
              ))}
              {blobs.length === 0 && <tr><td colSpan={3} className="muted">No blobs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {topCommands.length > 0 && (
        <section className="card">
          <h3>Top commands</h3>
          <table><tbody>{topCommands.map(([c, n]) => <tr key={c}><td className="mono">{c}</td><td>{n}</td></tr>)}</tbody></table>
        </section>
      )}
    </>
  );
}
