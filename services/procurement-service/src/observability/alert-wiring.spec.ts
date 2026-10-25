import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registry } from '@rasta/observability';
import { parse } from 'yaml';
import { DEFAULT_PORT } from '../config/env';
import './metrics';

/**
 * The alert rules read series this service exposes, from a target Prometheus scrapes (PR-338 r1
 * F2). promtool's rule tests feed the rules synthetic series, so they pass whether or not anything
 * real ever produces them; this checks the wiring they cannot see:
 *
 * - the local Prometheus loads the rule file and scrapes this service, in its own job, on its port;
 * - every `rasta_procurement_*` series a rule reads is one this service registers;
 * - losing the target is an alert of its own, on that job;
 * - the rule tests model the real scrape (the job the series arrive under).
 */
const PROMETHEUS = join(__dirname, '../../../../infrastructure/docker/prometheus');
const RULES = 'rules/rasta-procurement-alerts.yml';
const JOB = 'procurement-service';

interface ScrapeConfig {
  job_name: string;
  metrics_path?: string;
  static_configs?: { targets?: string[] }[];
}
interface Rule {
  alert: string;
  expr: string;
}

const read = (path: string): unknown => parse(readFileSync(join(PROMETHEUS, path), 'utf8'));
const config = read('prometheus.yml') as { rule_files: string[]; scrape_configs: ScrapeConfig[] };
const rules = (read(RULES) as { groups: { rules: Rule[] }[] }).groups.flatMap((g) => g.rules);
const seriesOf = (text: string): string[] => [
  ...new Set(text.match(/rasta_procurement_[a-z0-9_]+/g) ?? []),
];

/** The port a local run listens on: `.env.example`'s `PORT_PROCUREMENT`, the env default too. */
function localPort(): string {
  const example = readFileSync(join(__dirname, '../../../../.env.example'), 'utf8');
  return /^PORT_PROCUREMENT=(\d+)$/m.exec(example)?.[1] ?? '';
}

describe('the procurement alert rules are wired to a scraped target', () => {
  it('Prometheus loads the rule file', () => {
    expect(config.rule_files).toContain(RULES);
  });

  it(`scrapes this service in its own job, ${JOB}, at /metrics on its local port`, () => {
    expect(localPort()).toBe(DEFAULT_PORT);
    const jobs = config.scrape_configs.filter((job) => job.job_name === JOB);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.metrics_path).toBe('/metrics');
    expect(jobs[0]?.static_configs?.flatMap((c) => c.targets ?? [])).toEqual([
      `host.docker.internal:${DEFAULT_PORT}`,
    ]);
    // In no other job as well: the alerts' job selector would then miss half of its samples.
    const elsewhere = config.scrape_configs
      .filter((job) => job.job_name !== JOB)
      .flatMap((job) => job.static_configs?.flatMap((c) => c.targets ?? []) ?? []);
    expect(elsewhere).not.toContain(`host.docker.internal:${DEFAULT_PORT}`);
  });

  it('reads only series this service registers', async () => {
    const read = seriesOf(rules.map((rule) => rule.expr).join('\n'));
    expect(read.length).toBeGreaterThan(0);
    const registered = (await registry.getMetricsAsJSON()).map((metric) => metric.name);
    expect(read.filter((name) => !registered.includes(name))).toEqual([]);
  });

  it('alerts on the target itself being down or missing, by its job', () => {
    const unavailable = rules.filter((rule) => rule.expr.includes(`up{job="${JOB}"}`));
    expect(unavailable.map((rule) => rule.alert)).toEqual([
      'RastaProcurementServiceMetricsUnavailable',
    ]);
    expect(unavailable[0]?.expr).toContain(`absent(up{job="${JOB}"})`);
  });

  it('tests the rules on series as the scrape labels them', () => {
    const tests = readFileSync(join(PROMETHEUS, 'tests/rasta-procurement-alerts.test.yml'), 'utf8');
    const inputs = [...tests.matchAll(/series: '(rasta_procurement_[^']+)'/g)].map((m) => m[1]);
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) expect(input).toContain(`job="${JOB}"`);
  });
});
