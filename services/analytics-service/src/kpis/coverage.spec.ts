import { projectionCoversWindow } from './coverage';

const at = (iso: string) => new Date(iso);
const base = {
  consumerEnabled: true,
  coverageStart: at('2026-01-01T00:00:00.000Z'),
  readAt: at('2026-10-29T12:00:00.000Z'),
  from: at('2026-07-01T00:00:00.000Z'),
  to: at('2026-08-01T00:00:00.000Z'),
};

describe('projectionCoversWindow (fail closed)', () => {
  it('covers a window that starts after coverage and has ended', () => {
    expect(projectionCoversWindow(base)).toBe(true);
  });

  it('the coverage boundary is inclusive: from exactly at the coverage start is covered', () => {
    expect(projectionCoversWindow({ ...base, coverageStart: base.from })).toBe(true);
  });

  it('one millisecond before the coverage start is not covered', () => {
    expect(projectionCoversWindow({ ...base, coverageStart: at('2026-07-01T00:00:00.001Z') })).toBe(
      false,
    );
  });

  it('the end boundary is inclusive: to exactly at the read instant is covered', () => {
    expect(projectionCoversWindow({ ...base, readAt: base.to })).toBe(true);
  });

  it('one millisecond after the read instant is a window into the future', () => {
    expect(projectionCoversWindow({ ...base, readAt: at('2026-07-31T23:59:59.999Z') })).toBe(false);
  });

  it('never ran (no coverage start) is not covered', () => {
    expect(projectionCoversWindow({ ...base, coverageStart: null })).toBe(false);
  });

  it('a disabled consumer is not covered even with a recorded start', () => {
    expect(projectionCoversWindow({ ...base, consumerEnabled: false })).toBe(false);
  });
});
