import { baseDelaySeconds, jitteredDelaySeconds, nextResolutionAt } from './backoff';

describe('resolution backoff', () => {
  it('follows the platform ladder and then holds at its last rung', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map((n) => baseDelaySeconds(n, 3600))).toEqual([
      1, 5, 30, 120, 600, 600, 600,
    ]);
  });

  it('is capped by the configured ceiling', () => {
    expect(baseDelaySeconds(4, 90)).toBe(90);
    expect(baseDelaySeconds(0, 90)).toBe(1);
  });

  it('jitters within [delay / 2, delay] and never below', () => {
    expect(jitteredDelaySeconds(2, 3600, () => 0)).toBe(15);
    expect(jitteredDelaySeconds(2, 3600, () => 1)).toBe(30);
    expect(jitteredDelaySeconds(2, 3600, () => 0.5)).toBe(22.5);
    for (let i = 0; i < 200; i += 1) {
      const value = jitteredDelaySeconds(3, 3600);
      expect(value).toBeGreaterThanOrEqual(60);
      expect(value).toBeLessThanOrEqual(120);
    }
  });

  it('schedules the next attempt relative to the given clock', () => {
    const now = new Date('2026-09-17T10:00:00.000Z');
    expect(nextResolutionAt(0, 3600, now, () => 1).toISOString()).toBe('2026-09-17T10:00:01.000Z');
    expect(nextResolutionAt(1, 3600, now, () => 0).toISOString()).toBe('2026-09-17T10:00:02.500Z');
  });

  it('treats a negative attempt count as the first attempt', () => {
    expect(baseDelaySeconds(-3, 3600)).toBe(1);
  });
});
