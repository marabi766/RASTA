import { RastaError } from '@rasta/nest-common';
import type { ExtendedPrismaClient, PrismaService } from '../prisma/prisma.service';
import {
  IdempotencyStore,
  completedExpiryMs,
  idempotentRequest,
  optionalIdempotentRequest,
  parseReplayDeadline,
} from './idempotency';

const KEY = 'a-key-of-enough-length';
const details = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as RastaError).details;
  }
  throw new Error('did not refuse');
};

describe('parseReplayDeadline', () => {
  it('reads absence as no deadline, and one canonical integer as itself', () => {
    expect(parseReplayDeadline(undefined)).toBeUndefined();
    expect(parseReplayDeadline('1767225600000')).toBe(1767225600000);
  });

  it.each([
    [''],
    ['0'],
    ['-1'],
    ['+1'],
    [' 1'],
    ['1 '],
    ['01'],
    ['1e12'],
    ['1.5'],
    ['1, 2'],
    ['9007199254740992'],
    ['12345678901234567'],
    [['1', '2']],
  ])('refuses %j', (raw) => {
    expect(details(() => parseReplayDeadline(raw))).toEqual([
      expect.objectContaining({ path: 'Idempotency-Replay-Deadline', code: 'invalid' }),
    ]);
  });
});

describe('the one entry point', () => {
  it('a required key: reads the deadline with it; no key is refused even with a deadline', () => {
    expect(
      idempotentRequest({ 'idempotency-key': ` ${KEY} `, 'idempotency-replay-deadline': '5' }),
    ).toEqual({ key: KEY, replayDeadlineMs: 5 });
    expect(idempotentRequest({ 'idempotency-key': KEY })).toEqual({
      key: KEY,
      replayDeadlineMs: undefined,
    });
    expect(details(() => idempotentRequest({ 'idempotency-replay-deadline': '5' }))).toEqual([
      expect.objectContaining({ path: 'Idempotency-Key', code: 'required' }),
    ]);
  });

  it('an optional key: neither header is no request; a key reads its deadline', () => {
    expect(optionalIdempotentRequest({})).toBeUndefined();
    expect(
      optionalIdempotentRequest({ 'idempotency-key': KEY, 'idempotency-replay-deadline': '5' }),
    ).toEqual({ key: KEY, replayDeadlineMs: 5 });
  });

  it('an optional key: a deadline alone, or a blank key, is refused rather than ignored', () => {
    expect(
      details(() => optionalIdempotentRequest({ 'idempotency-replay-deadline': '5' })),
    ).toEqual([expect.objectContaining({ path: 'Idempotency-Key', code: 'required' })]);
    expect(details(() => optionalIdempotentRequest({ 'idempotency-key': '  ' }))).toEqual([
      expect.objectContaining({ path: 'Idempotency-Key', code: 'invalid' }),
    ]);
  });
});

describe('the fence’s two clocks', () => {
  /** The real store's checks, on no database: B = 67 s, TTL = 24 h. */
  class Exposed extends IdempotencyStore {
    constructor() {
      super({} as PrismaService, {
        MAINTENANCE_IDEMPOTENCY_TTL_HOURS: 24,
        MAINTENANCE_IDEMPOTENCY_CLAIM_LEASE_SECONDS: 120,
        MAINTENANCE_CLOCK_SKEW_SECONDS: 30,
      });
    }
    readClock(rows: unknown): Promise<Date> {
      return this.readDatabaseClock({
        $queryRaw: async () => rows,
      } as unknown as ExtendedPrismaClient);
    }
  }
  const NOW = 1_800_000_000_000;
  const LATEST = NOW + 24 * 3_600_000 - 67_000;
  const code = (replayDeadlineMs: number | undefined) => {
    try {
      new Exposed().assertAdmissible('POST /x', { replayDeadlineMs });
      return 'admitted';
    } catch (error) {
      return (error as RastaError).code;
    }
  };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('this replica’s clock: admits equality at both ends, refuses one millisecond past either', () => {
    expect(code(undefined)).toBe('admitted');
    expect(code(NOW)).toBe('admitted');
    expect(code(NOW - 1)).toBe('REPLAY_WINDOW_CLOSED');
    expect(code(LATEST)).toBe('admitted');
    expect(code(LATEST + 1)).toBe('VALIDATION_FAILED');
  });

  it('the database clock: a reading that is not a timestamp is an error, never a pass', async () => {
    const reading = new Date(NOW);
    await expect(new Exposed().readClock([{ now: reading }])).resolves.toBe(reading);
    for (const rows of [[], [{ now: null }], [{ now: 'soon' }], [{ now: new Date(Number.NaN) }]]) {
      await expect(new Exposed().readClock(rows)).rejects.toThrow(/did not return a timestamp/);
    }
  });
});

describe('completedExpiryMs', () => {
  const hour = 3_600_000;
  it('keeps the retention with no deadline, and the later of it and H + B with one', () => {
    expect(completedExpiryMs(0, 24, undefined, 67_000)).toBe(24 * hour);
    expect(completedExpiryMs(0, 1, hour, 67_000)).toBe(hour + 67_000);
    expect(completedExpiryMs(0, 24, hour, 67_000)).toBe(24 * hour);
  });
});
