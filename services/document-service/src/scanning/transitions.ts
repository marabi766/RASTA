import type { MalwareScanner, ScanResult, ScanVerdict } from './scanner.port';

/**
 * Which scan state may follow which, as a pure function.
 *
 * Separated from the worker for the same reason `canDownload` is separated
 * from `DocumentService`: this is the rule that decides whether a private
 * object becomes reachable, so every input and every output should be
 * enumerable in a test with no database, no bucket and no scanner.
 *
 * ## The shape of the lifecycle
 *
 *   PENDING ──▶ CLEAN        a validated pass from an engine that looked
 *           ──▶ INFECTED     a match, quarantined in the same write
 *           ──▶ FAILED       terminal: the retry budget is spent, or the
 *                            failure is one a retry cannot fix
 *           ──▶ PENDING      a retryable failure, rescheduled
 *
 * `CLEAN`, `INFECTED`, `FAILED` and `NOT_SCANNED` are terminal. Re-examining a
 * document that already has a verdict is a deliberate operator action — a
 * backfill after a signature release, described in `docs/runbooks` — and it
 * runs as its own job rather than as a transition the worker can take on its
 * own. A worker that could move `CLEAN` back to `PENDING` could also move
 * `INFECTED` there.
 *
 * ## Why `NOT_SCANNED` has no outgoing edge either
 *
 * It is a historical record: documents registered while Q-18 was open, whose
 * bytes nothing ever opened. Those need re-examining, and that is exactly why
 * the state was never allowed to be `CLEAN` (Q-18, ADR-049). But the
 * re-examination is the operator's backfill, which sets `PENDING` explicitly;
 * having the worker sweep them up silently would erase the distinction between
 * "never looked at" and "looked at and passed" the moment it ran.
 */

export type ScanState = 'PENDING' | 'NOT_SCANNED' | 'CLEAN' | 'INFECTED' | 'FAILED';

export const TERMINAL_SCAN_STATES: readonly ScanState[] = [
  'CLEAN',
  'INFECTED',
  'FAILED',
  'NOT_SCANNED',
];

/** The only state a worker may move a document out of. */
export const CLAIMABLE_SCAN_STATE: ScanState = 'PENDING';

/**
 * Whether the worker may make this move.
 *
 * `PENDING → PENDING` is allowed and is not a no-op: it is the retry, which
 * rewrites the attempt count and the next-attempt time while leaving the state
 * where a caller can see it. Every other self-transition is refused, because
 * re-writing a terminal state is how one worker's stale result overwrites
 * another's fresh one.
 */
export function canTransition(from: ScanState, to: ScanState): boolean {
  if (from !== 'PENDING') return false;
  return to === 'PENDING' || to === 'CLEAN' || to === 'INFECTED' || to === 'FAILED';
}

export type TransitionDecision =
  | { readonly kind: 'CLEAN' }
  | { readonly kind: 'INFECTED'; readonly signature: string }
  | { readonly kind: 'RETRY'; readonly attempt: number }
  | { readonly kind: 'FAILED'; readonly reason: string };

export interface DecisionInput {
  readonly result: ScanResult;
  readonly scanner: Pick<MalwareScanner, 'inspectsContent'>;
  /** Attempts already completed, before this one is counted. */
  readonly previousAttempts: number;
  readonly maxAttempts: number;
}

/**
 * Turns one scan result into the move the worker should make.
 *
 * Every branch that does not end in `CLEAN` ends in a state `canDownload`
 * refuses, and there is exactly one branch that ends in `CLEAN`.
 */
export function decideTransition(input: DecisionInput): TransitionDecision {
  const { result, scanner, previousAttempts, maxAttempts } = input;
  const attempt = previousAttempts + 1;

  switch (result.verdict) {
    case 'CLEAN': {
      // The check that cannot be reached by any scanner in this repository,
      // and is here anyway. A `CLEAN` from something that never opened the
      // file is the one bug whose consequence is serving unexamined bytes
      // under a status column that says they were checked — the exact failure
      // ADR-014 and Q-18 exist to prevent. It fails closed and names itself.
      if (!scanner.inspectsContent) {
        return { kind: 'FAILED', reason: 'SCANNER_DOES_NOT_INSPECT' };
      }
      return { kind: 'CLEAN' };
    }

    case 'INFECTED': {
      // An infection with no signature name is not a finding anybody can act
      // on, and `VIRUS_DETECTED` requires one. Recorded as a failed scan
      // rather than as a nameless threat: it is still undownloadable, and it
      // does not put a fabricated security finding on a Kafka topic that
      // notification-service treats as critical.
      if (!result.signature || result.signature.trim().length === 0) {
        return { kind: 'FAILED', reason: 'MALFORMED_RESPONSE' };
      }
      return { kind: 'INFECTED', signature: result.signature };
    }

    case 'FAILED': {
      const reason = result.failureReason ?? 'PROTOCOL_ERROR';
      if (result.retryable && attempt < maxAttempts) {
        return { kind: 'RETRY', attempt };
      }
      return { kind: 'FAILED', reason };
    }

    case 'NOT_SCANNED':
      // A scanner that inspects nothing was bound and a document was fed to
      // it. Recorded as a failure rather than as `NOT_SCANNED`, because
      // `NOT_SCANNED` is the pre-ADR-049 historical record and a row written
      // today should not be indistinguishable from one written then.
      return { kind: 'FAILED', reason: 'SCANNER_DOES_NOT_INSPECT' };
  }
}

/** The state a decision writes. Kept beside the decision so they cannot drift. */
export function stateOf(decision: TransitionDecision): ScanState {
  switch (decision.kind) {
    case 'CLEAN':
      return 'CLEAN';
    case 'INFECTED':
      return 'INFECTED';
    case 'RETRY':
      return 'PENDING';
    case 'FAILED':
      return 'FAILED';
  }
}

/**
 * How long to wait before the next attempt, in milliseconds.
 *
 * Exponential with a ceiling, and jittered by the caller if it needs to be.
 * The ceiling matters more than the growth: without one, the fifth retry of a
 * document that arrived during a scanner outage would be scheduled hours out,
 * long after the outage ended, and the backlog would drain on a schedule
 * nobody chose.
 */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  // Bounded before the shift so a large attempt count cannot overflow into a
  // negative delay — which would schedule the retry in the past and spin.
  const growth = 2 ** Math.min(exponent, 16);
  return Math.min(maxMs, baseMs * growth);
}

/** Verdicts that authorize a download. There is one, and this names it. */
export const DOWNLOADABLE_VERDICTS: readonly ScanVerdict[] = ['CLEAN'];
