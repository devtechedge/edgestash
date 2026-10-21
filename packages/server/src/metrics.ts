/** Tiny Prometheus text-format registry (counters and gauges). */
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, () => number>();
  readonly startedAt = Date.now();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}${fmt(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }
  gauge(name: string, fn: () => number): void {
    this.gauges.set(name, fn);
  }
  snapshot(): Record<string, number> {
    const out: Record<string, number> = Object.fromEntries(this.counters);
    for (const [k, fn] of this.gauges) out[k] = fn();
    return out;
  }
  render(): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const [k, v] of [...this.counters].sort()) {
      const base = k.split("{")[0]!;
      if (!seen.has(base)) { lines.push(`# TYPE ${base} counter`); seen.add(base); }
      lines.push(`${k} ${v}`);
    }
    for (const [k, fn] of [...this.gauges].sort()) lines.push(`# TYPE ${k} gauge`, `${k} ${fn()}`);
    return lines.join("\n") + "\n";
  }
}
function fmt(labels: Record<string, string>): string {
  const e = Object.entries(labels);
  return e.length ? `{${e.map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(",")}}` : "";
}
