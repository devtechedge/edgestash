"use client";

import { useState, useTransition } from "react";
import { runDemo, type Step } from "./actions";

export default function DemoPage() {
  const [text, setText] = useState("The quick brown fox jumps over the lazy dog");
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <div className="hero" style={{ paddingBottom: 10 }}>
        <h1>Live demo</h1>
        <p className="lead">
          A server action runs the official <code>@vercel/blob</code>, <code>@upstash/redis</code> and <code>@upstash/ratelimit</code> packages,
          unmodified, against the edgestash instance inside this deployment. Run it more than five times in 30 seconds to watch the rate limiter block you.
        </p>
      </div>
      <div className="row">
        <input style={{ flex: 1, minWidth: 260 }} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label="Text to store" />
        <button disabled={pending} onClick={() => start(async () => setSteps(await runDemo(text)))}>{pending ? "Running..." : "Run SDK calls"}</button>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Demo state is in memory on a single serverless instance and resets when the instance is recycled. Self-host it for persistence.</p>
      {steps && (
        <table style={{ marginTop: 20 }}>
          <thead><tr><th>API</th><th>SDK call</th><th>ms</th><th>Result</th></tr></thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={i}>
                <td><span className="pill">{s.api}</span></td>
                <td className="mono">{s.call}</td>
                <td>{s.ms}</td>
                <td>
                  <pre style={{ margin: 0, maxHeight: 220, borderColor: s.ok ? "var(--line)" : "var(--bad)" }}>{JSON.stringify(s.result, null, 2)}</pre>
                  {s.api === "blob" && s.ok && typeof s.result === "object" && s.result && "url" in s.result ? <a href={String((s.result as { url: string }).url)} target="_blank" rel="noreferrer">open blob</a> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
