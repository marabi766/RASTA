import {
  CLAIMABLE_SCAN_STATE,
  DOWNLOADABLE_VERDICTS,
  TERMINAL_SCAN_STATES,
  backoffMs,
  canTransition,
  decideTransition,
  stateOf,
  type ScanState,
} from './transitions';
import { SCAN_FAILURE_REASONS, type ScanResult } from './scanner.port';

/**
 * The scan state machine, enumerated.
 *
 * This is the rule that decides whether a private object becomes reachable, so
 * every input and every output is listed here rather than sampled — including
 * the pairs that must be refused, which are the ones an integration test can
 * never demonstrate because nothing tries them.
 */

const ALL_STATES: ScanState[] = ['PENDING', 'NOT_SCANNED', 'CLEAN', 'INFECTED', 'FAILED'];

const INSPECTING = { inspectsContent: true };
const NOT_INSPECTING = { inspectsContent: false };

function result(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    verdict: 'CLEAN',
    engine: 'clamav',
    engineVersion: '1.5.4',
    signatureVersion: '28108',
    signatureAgeSeconds: 120,
    signature: null,
    failureReason: null,
    retryable: false,
    scannedAt: new Date('2026-08-31T12:00:00.000Z'),
    ...overrides,
  };
}

describe('which transitions are permitted', () => {
  it('allows exactly the four moves out of PENDING', () => {
    const allowed = ALL_STATES.filter((to) => canTransition('PENDING', to));

    expect(allowed.sort()).toEqual(['CLEAN', 'FAILED', 'INFECTED', 'PENDING']);
  });

  it('refuses every move out of a terminal state', () => {
    // The property that matters most. A worker that could move CLEAN back to
    // PENDING could also move INFECTED there, and re-examination after a
    // signature release is an operator backfill rather than something a
    // background timer decides to do.
    for (const from of TERMINAL_SCAN_STATES) {
      for (const to of ALL_STATES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('refuses to reopen NOT_SCANNED, which is a historical record', () => {
    // Documents registered while Q-18 was open, whose bytes nothing ever
    // opened. Sweeping them up silently would erase the distinction between
    // "never looked at" and "looked at and passed" — the distinction the whole
    // open question turned on.
    for (const to of ALL_STATES) {
      expect(canTransition('NOT_SCANNED', to)).toBe(false);
    }
  });

  it('allows PENDING to PENDING, which is the retry rather than a no-op', () => {
    expect(canTransition('PENDING', 'PENDING')).toBe(true);
  });

  it('claims only from PENDING', () => {
    expect(CLAIMABLE_SCAN_STATE).toBe('PENDING');
  });
});

describe('deciding what a scan result means', () => {
  describe('the one path to CLEAN', () => {
    it('is a clean verdict from a scanner that inspects content', () => {
      const decision = decideTransition({
        result: result({ verdict: 'CLEAN' }),
        scanner: INSPECTING,
        previousAttempts: 0,
        maxAttempts: 5,
      });

      expect(decision).toEqual({ kind: 'CLEAN' });
      expect(stateOf(decision)).toBe('CLEAN');
    });

    it('is refused when the scanner does not inspect content', () => {
      // Unreachable through any implementation in this repository, and checked
      // anyway: a CLEAN from something that never opened the file is the one
      // bug whose consequence is serving unexamined bytes under a status
      // column that says they were checked.
      const decision = decideTransition({
        result: result({ verdict: 'CLEAN' }),
        scanner: NOT_INSPECTING,
        previousAttempts: 0,
        maxAttempts: 5,
      });

      expect(decision).toEqual({ kind: 'FAILED', reason: 'SCANNER_DOES_NOT_INSPECT' });
      expect(stateOf(decision)).toBe('FAILED');
    });

    it('is the only decision kind that maps to a downloadable state', () => {
      expect(DOWNLOADABLE_VERDICTS).toEqual(['CLEAN']);
    });
  });

  describe('an infection', () => {
    it('carries the signature through to the transition', () => {
      const decision = decideTransition({
        result: result({ verdict: 'INFECTED', signature: 'Eicar-Test-Signature' }),
        scanner: INSPECTING,
        previousAttempts: 0,
        maxAttempts: 5,
      });

      expect(decision).toEqual({ kind: 'INFECTED', signature: 'Eicar-Test-Signature' });
    });

    it('is refused when the scanner does not inspect content', () => {
      // A finding from something that never opened the file is fabricated, and
      // fabricated is worse than absent: VIRUS_DETECTED reaches
      // notification-service, which treats it as critical.
      const decision = decideTransition({
        result: result({ verdict: 'INFECTED', signature: 'FABRICATED' }),
        scanner: NOT_INSPECTING,
        previousAttempts: 0,
        maxAttempts: 5,
      });

      expect(decision).toEqual({ kind: 'FAILED', reason: 'SCANNER_DOES_NOT_INSPECT' });
    });

    it.each([
      ['no signature at all', null],
      ['an empty signature', ''],
      ['a signature of whitespace', '   '],
    ])('is refused with %s, rather than published as a nameless threat', (_label, signature) => {
      // VIRUS_DETECTED reaches notification-service, which treats it as
      // critical and puts it in front of a person. A finding with no name is
      // not something anybody can act on, so it is recorded as a failed scan —
      // still undownloadable, and without a fabricated security finding.
      const decision = decideTransition({
        result: result({ verdict: 'INFECTED', signature }),
        scanner: INSPECTING,
        previousAttempts: 0,
        maxAttempts: 5,
      });

      expect(decision).toEqual({ kind: 'FAILED', reason: 'MALFORMED_RESPONSE' });
    });
  });

  describe('a failure', () => {
    it('retries when the failure is retryable and budget remains', () => {
      const decision = decideTransition({
        result: result({ verdict: 'FAILED', failureReason: 'TIMEOUT', retryable: true }),
        scanner: INSPECTING,
        previousAttempts: 1,
        maxAttempts: 5,
      });

      expect(decision).toEqual({ kind: 'RETRY', attempt: 2 });
      expect(stateOf(decision)).toBe('PENDING');
    });

    it('gives up on the last attempt rather than retrying forever', () => {
      const decision = decideTransition({
        result: result({ verdict: 'FAILED', failureReason: 'TIMEOUT', retryable: true }),
        scanner: INSPECTING,
        previousAttempts: 4,
        maxAttempts: 5,
      });

      expect(decision).toEqual({ kind: 'FAILED', reason: 'TIMEOUT' });
    });

    it('does not retry a failure a retry cannot fix', () => {
      const decision = decideTransition({
        result: result({
          verdict: 'FAILED',
          failureReason: 'SIZE_LIMIT_EXCEEDED',
          retryable: false,
        }),
        scanner: INSPECTING,
        previousAttempts: 0,
        maxAttempts: 5,
      });

      expect(decision).toEqual({ kind: 'FAILED', reason: 'SIZE_LIMIT_EXCEEDED' });
    });

    it('names a reason even when the result forgot to supply one', () => {
      // The database refuses a FAILED row with no reason
      // (`ck_document_failure_reason_only_when_failed`), so a missing one has
      // to become something rather than propagate as null.
      const decision = decideTransition({
        result: result({ verdict: 'FAILED', failureReason: null, retryable: false }),
        scanner: INSPECTING,
        previousAttempts: 0,
        maxAttempts: 5,
      });

      expect(decision).toEqual({ kind: 'FAILED', reason: 'PROTOCOL_ERROR' });
    });

    it('never reaches CLEAN for any failure reason the port defines', () => {
      // The table that keeps the invariant honest as reasons are added: there
      // is no failure reason that authorizes a download, and a new one cannot
      // become an exception without this failing.
      for (const reason of SCAN_FAILURE_REASONS) {
        for (const retryable of [true, false]) {
          const decision = decideTransition({
            result: result({ verdict: 'FAILED', failureReason: reason, retryable }),
            scanner: INSPECTING,
            previousAttempts: 0,
            maxAttempts: 1,
          });

          expect(stateOf(decision)).not.toBe('CLEAN');
        }
      }
    });
  });

  describe('a scanner that inspected nothing', () => {
    it('records a failure rather than a NOT_SCANNED written today', () => {
      // NOT_SCANNED is the pre-ADR-049 historical record. A row written now
      // must not be indistinguishable from one written while Q-18 was open.
      const decision = decideTransition({
        result: result({ verdict: 'NOT_SCANNED', engine: 'no-op-stub' }),
        scanner: NOT_INSPECTING,
        previousAttempts: 0,
        maxAttempts: 5,
      });

      expect(decision).toEqual({ kind: 'FAILED', reason: 'SCANNER_DOES_NOT_INSPECT' });
    });
  });

  it('never produces a decision that is not one of the four states', () => {
    const kinds = (['CLEAN', 'INFECTED', 'FAILED', 'NOT_SCANNED'] as const).map((verdict) =>
      stateOf(
        decideTransition({
          result: result({ verdict, signature: verdict === 'INFECTED' ? 'X' : null }),
          scanner: INSPECTING,
          previousAttempts: 0,
          maxAttempts: 5,
        }),
      ),
    );

    for (const state of kinds) {
      expect(ALL_STATES).toContain(state);
    }
  });
});

describe('the retry backoff', () => {
  it('doubles per attempt', () => {
    expect(backoffMs(1, 1000, 60_000)).toBe(1000);
    expect(backoffMs(2, 1000, 60_000)).toBe(2000);
    expect(backoffMs(3, 1000, 60_000)).toBe(4000);
    expect(backoffMs(4, 1000, 60_000)).toBe(8000);
  });

  it('stops at the ceiling', () => {
    // Without one, the fifth retry of a document that arrived during an outage
    // is scheduled hours out, long after the outage ended, and the backlog
    // drains on a schedule nobody chose.
    expect(backoffMs(20, 1000, 60_000)).toBe(60_000);
  });

  it('never schedules a retry in the past', () => {
    // A large attempt count must not overflow the shift into a negative delay,
    // which would schedule the retry before now and spin.
    for (const attempt of [0, 1, 50, 1000, Number.MAX_SAFE_INTEGER]) {
      const delay = backoffMs(attempt, 5000, 300_000);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(300_000);
    }
  });
});
