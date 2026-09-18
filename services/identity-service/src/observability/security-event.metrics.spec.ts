import { metricsText } from '@rasta/observability';
import {
  initializeSecurityEventAlertSeries,
  SECURITY_EVENT_CAPTURE_OUTCOMES,
  SECURITY_EVENT_PUBLISH_FAILURE_REASONS,
  securityEventCapturesTotal,
  securityEventPublishFailuresTotal,
} from './security-event.metrics';

/**
 * The zero series behind `RastaSecurityEventCaptureGap` and
 * `RastaSecurityEventPublishFailure`, read from the exposition `/metrics`
 * serves.
 *
 * Both alerts are `increase(...[5m]) > 0`. prom-client exports a labelled
 * series only once it has a value, so a series first exported at 1 has no
 * earlier sample and its first real increment is invisible to `increase`.
 */
describe('refusal-audit alert series exported at zero', () => {
  interface ExposedSample {
    labels: Record<string, string>;
    value: number;
  }

  async function exposed(name: string): Promise<ExposedSample[]> {
    const text = await metricsText();
    return text
      .split('\n')
      .filter((line) => line.startsWith(`${name}{`))
      .map((line) => {
        const match = /^[a-z_]+\{(.*)\} (\S+)$/.exec(line);
        if (!match) throw new Error(`Unparseable exposition line: ${line}`);
        const labels: Record<string, string> = {};
        for (const pair of (match[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)) {
          labels[pair[1] ?? ''] = pair[2] ?? '';
        }
        return { labels, value: Number(match[2]) };
      });
  }

  const CAPTURES = 'rasta_security_event_captures_total';
  const PUBLISH_FAILURES = 'rasta_security_event_publish_failures_total';

  /** Values that must never reach a label. */
  const FORBIDDEN_VALUES = [
    'ORG_SECURITY_METRIC_TENANT',
    'USR_SECURITY_METRIC_ACTOR',
    'corr-security-metric-spec',
    'broker refused the batch',
  ];

  async function assertStartupExposition(): Promise<void> {
    const captures = await exposed(CAPTURES);
    // Only the outcomes the capture-gap alert selects. `recorded` and `skipped`
    // drive no alert, so nothing creates them before a real capture.
    expect(captures).toEqual([
      { labels: { outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.FAILED }, value: 0 },
      { labels: { outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.TIMEOUT }, value: 0 },
    ]);

    const failures = await exposed(PUBLISH_FAILURES);
    expect(failures.map((sample) => sample.labels.reason).sort()).toEqual(
      Object.values(SECURITY_EVENT_PUBLISH_FAILURE_REASONS).sort(),
    );
    expect(failures).toHaveLength(2);
    for (const sample of failures) {
      expect(Object.keys(sample.labels)).toEqual(['reason']);
      expect(sample.value).toBe(0);
    }
  }

  afterEach(() => {
    // Leave the singletons as a fresh process has them, whatever a test did.
    securityEventCapturesTotal.reset();
    securityEventPublishFailuresTotal.reset();
    initializeSecurityEventAlertSeries();
  });

  it('exports failed, timeout and every publish-failure reason at zero on module load', async () => {
    // Nothing in this file resets or increments these counters before this
    // test, so this is the exposition the first scrape of a new process sees.
    await assertStartupExposition();
  });

  it('seeds exactly the alert-driving closed sets, and nothing identifying', async () => {
    securityEventCapturesTotal.reset();
    securityEventPublishFailuresTotal.reset();
    expect(await exposed(CAPTURES)).toEqual([]);
    expect(await exposed(PUBLISH_FAILURES)).toEqual([]);

    initializeSecurityEventAlertSeries();

    await assertStartupExposition();
    const text = await metricsText();
    expect(text).not.toMatch(/outcome="(recorded|skipped)"/);
    for (const forbidden of FORBIDDEN_VALUES) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('never erases a real increment when seeded again', async () => {
    securityEventCapturesTotal.inc({ outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.TIMEOUT });
    securityEventCapturesTotal.inc({ outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.RECORDED });
    securityEventPublishFailuresTotal.inc({
      reason: SECURITY_EVENT_PUBLISH_FAILURE_REASONS.PUBLISH_ERROR,
    });

    initializeSecurityEventAlertSeries();

    const captures = await exposed(CAPTURES);
    expect(captures).toEqual(
      expect.arrayContaining([
        { labels: { outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.FAILED }, value: 0 },
        { labels: { outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.TIMEOUT }, value: 1 },
        { labels: { outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.RECORDED }, value: 1 },
      ]),
    );
    expect(captures).toHaveLength(3);
    expect(await exposed(PUBLISH_FAILURES)).toEqual(
      expect.arrayContaining([
        { labels: { reason: SECURITY_EVENT_PUBLISH_FAILURE_REASONS.CONTRACT_VIOLATION }, value: 0 },
        { labels: { reason: SECURITY_EVENT_PUBLISH_FAILURE_REASONS.PUBLISH_ERROR }, value: 1 },
      ]),
    );
  });
});
