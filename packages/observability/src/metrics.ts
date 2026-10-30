/**
 * Minimal in-process metrics registry with Prometheus text exposition.
 *
 * This is the engineering-observability seam: counters/histograms/gauges are recorded
 * through this interface and can be scraped from `/metrics`. An OpenTelemetry metrics
 * exporter can later replace the implementation without touching call sites.
 */

type Labels = Record<string, string>;

function labelKey(labels: Labels | undefined): string {
  if (!labels) return '';
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');
}

interface CounterSeries {
  value: number;
}
interface HistogramSeries {
  count: number;
  sum: number;
  buckets: number[];
}

const DEFAULT_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000];

export class MetricsRegistry {
  private counters = new Map<string, { help: string; series: Map<string, CounterSeries> }>();
  private gauges = new Map<string, { help: string; series: Map<string, CounterSeries> }>();
  private histograms = new Map<
    string,
    { help: string; bounds: number[]; series: Map<string, HistogramSeries> }
  >();

  inc(name: string, labels?: Labels, by = 1, help = name): void {
    let metric = this.counters.get(name);
    if (!metric) {
      metric = { help, series: new Map() };
      this.counters.set(name, metric);
    }
    const key = labelKey(labels);
    const s = metric.series.get(key) ?? { value: 0 };
    s.value += by;
    metric.series.set(key, s);
  }

  set(name: string, value: number, labels?: Labels, help = name): void {
    let metric = this.gauges.get(name);
    if (!metric) {
      metric = { help, series: new Map() };
      this.gauges.set(name, metric);
    }
    metric.series.set(labelKey(labels), { value });
  }

  observe(name: string, value: number, labels?: Labels, help = name, bounds = DEFAULT_BUCKETS_MS): void {
    let metric = this.histograms.get(name);
    if (!metric) {
      metric = { help, bounds, series: new Map() };
      this.histograms.set(name, metric);
    }
    const key = labelKey(labels);
    let s = metric.series.get(key);
    if (!s) {
      s = { count: 0, sum: 0, buckets: metric.bounds.map(() => 0) };
      metric.series.set(key, s);
    }
    s.count += 1;
    s.sum += value;
    metric.bounds.forEach((b, i) => {
      if (value <= b) s.buckets[i] = (s.buckets[i] ?? 0) + 1;
    });
  }

  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, m] of this.counters)
      out[name] = Object.fromEntries([...m.series].map(([k, v]) => [k, v.value]));
    for (const [name, m] of this.gauges)
      out[name] = Object.fromEntries([...m.series].map(([k, v]) => [k, v.value]));
    for (const [name, m] of this.histograms)
      out[name] = Object.fromEntries([...m.series].map(([k, v]) => [k, { count: v.count, sum: v.sum }]));
    return out;
  }

  toPrometheus(): string {
    const lines: string[] = [];
    const fmt = (name: string, key: string, extra?: string) => {
      const parts = [key, extra].filter(Boolean).join(',');
      return parts ? `${name}{${parts}}` : name;
    };
    for (const [name, m] of this.counters) {
      lines.push(`# HELP ${name} ${m.help}`, `# TYPE ${name} counter`);
      for (const [key, s] of m.series) lines.push(`${fmt(name, key)} ${s.value}`);
    }
    for (const [name, m] of this.gauges) {
      lines.push(`# HELP ${name} ${m.help}`, `# TYPE ${name} gauge`);
      for (const [key, s] of m.series) lines.push(`${fmt(name, key)} ${s.value}`);
    }
    for (const [name, m] of this.histograms) {
      lines.push(`# HELP ${name} ${m.help}`, `# TYPE ${name} histogram`);
      for (const [key, s] of m.series) {
        m.bounds.forEach((b, i) =>
          lines.push(`${fmt(`${name}_bucket`, key, `le="${b}"`)} ${s.buckets[i] ?? 0}`),
        );
        lines.push(`${fmt(`${name}_bucket`, key, 'le="+Inf"')} ${s.count}`);
        lines.push(`${fmt(`${name}_sum`, key)} ${s.sum}`);
        lines.push(`${fmt(`${name}_count`, key)} ${s.count}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

/** Process-wide default registry. */
export const metrics = new MetricsRegistry();
