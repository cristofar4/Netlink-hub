import { Injectable } from '@nestjs/common';

type Counter = { help: string; values: Map<string, number> };
type Histogram = { help: string; buckets: number[]; series: Map<string, number[]> };

/**
 * Metrics, in Prometheus text format.
 *
 * Hand-rolled rather than `prom-client`, for one reason worth stating: the
 * entire surface needed here is a counter, a gauge and a latency histogram, and
 * a metrics endpoint is a thing that gets scraped by something outside the
 * trust boundary. A hundred lines that can be read in full is a better trade
 * than a dependency whose default registry exports the process's environment
 * shape and whose behaviour has to be configured *away* from its defaults.
 *
 * What is deliberately not here: nothing is labelled with a user id, an email,
 * an IP address, a Space id or a path parameter. A metrics endpoint is a
 * low-security surface by nature — it is scraped by monitoring, often
 * unauthenticated inside a network — and high-cardinality labels are both an
 * operational problem and a quiet way to leak who is using the system and when.
 * Routes are recorded as their *templates*, never as the paths that were hit.
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly startedAt = Date.now();

  /** Latency buckets, in seconds. Chosen around what a person notices. */
  private static readonly LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

  increment(name: string, help: string, labels: Record<string, string> = {}, by = 1): void {
    const counter = this.counters.get(name) ?? { help, values: new Map() };
    const key = serialiseLabels(labels);
    counter.values.set(key, (counter.values.get(key) ?? 0) + by);
    this.counters.set(name, counter);
  }

  setGauge(name: string, help: string, value: number, labels: Record<string, string> = {}): void {
    const gauge = this.gauges.get(name) ?? { help, values: new Map() };
    gauge.values.set(serialiseLabels(labels), value);
    this.gauges.set(name, gauge);
  }

  observe(name: string, help: string, seconds: number, labels: Record<string, string> = {}): void {
    const histogram = this.histograms.get(name) ?? {
      help,
      buckets: MetricsService.LATENCY_BUCKETS,
      series: new Map(),
    };
    const key = serialiseLabels(labels);
    // One slot per bucket, plus a count and a sum on the end.
    const counts = histogram.series.get(key) ?? new Array(histogram.buckets.length + 2).fill(0);

    for (let index = 0; index < histogram.buckets.length; index += 1) {
      if (seconds <= histogram.buckets[index]) counts[index] += 1;
    }
    counts[histogram.buckets.length] += 1;
    counts[histogram.buckets.length + 1] += seconds;

    histogram.series.set(key, counts);
    this.histograms.set(name, histogram);
  }

  /** Renders everything in the Prometheus exposition format. */
  render(): string {
    const lines: string[] = [];

    lines.push('# HELP netlink_uptime_seconds Seconds since this instance started.');
    lines.push('# TYPE netlink_uptime_seconds gauge');
    lines.push(`netlink_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`);

    for (const [name, counter] of this.counters) {
      lines.push(`# HELP ${name} ${counter.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [labels, value] of counter.values) {
        lines.push(`${name}${labels} ${value}`);
      }
    }

    for (const [name, gauge] of this.gauges) {
      lines.push(`# HELP ${name} ${gauge.help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const [labels, value] of gauge.values) {
        lines.push(`${name}${labels} ${value}`);
      }
    }

    for (const [name, histogram] of this.histograms) {
      lines.push(`# HELP ${name} ${histogram.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const [labels, counts] of histogram.series) {
        const inner = labels === '' ? '' : labels.slice(1, -1);
        histogram.buckets.forEach((bound, index) => {
          const le = inner ? `{${inner},le="${bound}"}` : `{le="${bound}"}`;
          lines.push(`${name}_bucket${le} ${counts[index]}`);
        });
        const infinite = inner ? `{${inner},le="+Inf"}` : '{le="+Inf"}';
        lines.push(`${name}_bucket${infinite} ${counts[histogram.buckets.length]}`);
        lines.push(`${name}_count${labels} ${counts[histogram.buckets.length]}`);
        lines.push(`${name}_sum${labels} ${counts[histogram.buckets.length + 1]}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  /** Used by tests, so one case cannot see another's counters. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

/**
 * Renders a label set, sorted so the same labels always produce the same key.
 *
 * Values are escaped rather than rejected, because a label that breaks the
 * exposition format would corrupt every metric after it in the response — a
 * scrape failure caused by one odd value is worse than an ugly one.
 */
function serialiseLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return '';
  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(',');
  return `{${rendered}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
