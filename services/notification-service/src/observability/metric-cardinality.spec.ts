import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registry } from '@rasta/observability';
import * as metrics from './metrics';

/**
 * `docs/13` § 13.3 and ADR-054 § 12: no metric here carries an identifying
 * or unbounded label. Asserted against the registry — the same object the
 * `/metrics` endpoint would scrape — rather than against this file's text, so
 * a metric registered elsewhere in the service is caught too.
 */

const FORBIDDEN_LABELS = [
  'user_id',
  'userid',
  'organization_id',
  'organizationid',
  'tenant_id',
  'asset_id',
  'policy_id',
  'event_id',
  'correlation_id',
  'email',
  'address',
  'intent_id',
  'subject_id',
];

const ALLOWED_LABELS = new Set(['event_name', 'rule_key', 'channel', 'status', 'reason']);

describe('notification metrics carry no identifying labels', () => {
  const ours = () =>
    registry.getMetricsAsArray().filter((metric) => metric.name.startsWith('rasta_notification_'));

  it('registers the ADR-054 § 12 metrics this story owns', () => {
    const names = ours().map((metric) => metric.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'rasta_notification_intents_total',
        'rasta_notification_deliveries_total',
        'rasta_notification_deduped_total',
        'rasta_notification_suppressed_total',
        'rasta_notification_recipient_truncated_total',
        'rasta_notification_recipient_resolution_failures_total',
        'rasta_notification_intents_pending',
      ]),
    );
  });

  it('uses only labels drawn from deploy-time sets', () => {
    for (const metric of ours()) {
      const labels = (metric as unknown as { labelNames?: string[] }).labelNames ?? [];
      for (const label of labels) {
        expect(FORBIDDEN_LABELS).not.toContain(label.toLowerCase());
        expect(ALLOWED_LABELS.has(label)).toBe(true);
      }
    }
  });

  it('keeps every reason vocabulary closed', () => {
    for (const vocabulary of [
      metrics.SUPPRESSION_REASONS,
      metrics.DISCARD_REASONS,
      metrics.RESOLUTION_FAILURE_REASONS,
    ]) {
      for (const [key, value] of Object.entries(vocabulary)) {
        expect(value).toBe(key);
        expect(value).toMatch(/^[A-Z_]+$/);
      }
    }
  });

  it('never calls inc/dec on a gauge: gauges are sampled', () => {
    const source = readFileSync(
      join(__dirname, '..', 'resolution', 'resolution.worker.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/notificationIntentsPending\.(inc|dec)\(/);
    expect(source).not.toMatch(/notificationOldestPendingAgeSeconds\.(inc|dec)\(/);
    expect(source).toMatch(/notificationIntentsPending\.set\(/);
  });
});
