import type { Logger } from '@rasta/logging';
import { ulid } from 'ulid';
import {
  securityEventAggregationsTotal,
  securityEventCapturesTotal,
  SECURITY_EVENT_CAPTURE_OUTCOMES,
  type SecurityEventCaptureOutcome,
} from '../observability/security-event.metrics';
import type { SecurityEventRecord } from './audit-trail-envelope';
import {
  aggregationOutcomeOf,
  assertAggregationWindowSeconds,
  type CapturedOccurrence,
} from './refusal-aggregation';
import { decideCapture, type RefusalObservation } from './refusal-capture';
import type { CaptureWriteOptions } from './security-event-outbox.store';

/** The one store method the recorder needs. */
export interface SecurityEventWriter {
  capture(draft: SecurityEventRecord, options: CaptureWriteOptions): Promise<CapturedOccurrence>;
}

export interface RefusalAuditRecorderOptions {
  store: SecurityEventWriter;
  /** `SECURITY_EVENT_CAPTURE_TIMEOUT_MS`. */
  timeoutMs: number;
  /** `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS`. */
  aggregationWindowSeconds: number;
  producerVersion: string;
  logger: Pick<Logger, 'warn' | 'error'>;
  /** Injection seams for tests. */
  now?: () => Date;
  newId?: () => string;
}

/** An error class name, which is code-authored rather than data-derived. */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** A Prisma error code — `P` and four digits, never a message. */
const PRISMA_ERROR_CODE = /^P\d{4}$/;
/** A PostgreSQL SQLSTATE. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Prisma: interactive transaction timeout, operation timeout, pool timeout. */
const PRISMA_TIMEOUT_CODES = new Set(['P2028', 'P1008', 'P2024']);
/** PostgreSQL: `query_canceled` (statement_timeout) and `lock_not_available`. */
const POSTGRES_TIMEOUT_STATES = new Set(['57014', '55P03']);

interface ErrorShape {
  name?: unknown;
  code?: unknown;
  meta?: { code?: unknown };
  message?: unknown;
}

const shapeOf = (error: unknown): ErrorShape =>
  (typeof error === 'object' && error !== null ? error : {}) as ErrorShape;

/**
 * Whether a failed write was a timeout. The message is read for this decision
 * only — it is never logged, counted or stored, because a driver message can
 * quote the statement's arguments.
 */
function isTimeout(error: unknown): boolean {
  const shape = shapeOf(error);
  if (typeof shape.code === 'string' && PRISMA_TIMEOUT_CODES.has(shape.code)) return true;
  if (typeof shape.meta?.code === 'string' && POSTGRES_TIMEOUT_STATES.has(shape.meta.code)) {
    return true;
  }
  return (
    typeof shape.message === 'string' &&
    /statement timeout|lock timeout|canceling statement/i.test(shape.message)
  );
}

/** Class name and codes only. Never the message. */
export function describeCaptureFailure(error: unknown): {
  errorClass: string;
  errorCode?: string;
} {
  const shape = shapeOf(error);
  const errorClass =
    typeof shape.name === 'string' && SAFE_ERROR_NAME.test(shape.name) ? shape.name : 'Error';
  const code =
    typeof shape.code === 'string' && PRISMA_ERROR_CODE.test(shape.code)
      ? shape.code
      : typeof shape.meta?.code === 'string' && SQLSTATE.test(shape.meta.code)
        ? shape.meta.code
        : undefined;
  return code === undefined ? { errorClass } : { errorClass, errorCode: code };
}

type WriteResult =
  | { outcome: typeof SECURITY_EVENT_CAPTURE_OUTCOMES.RECORDED; captured: CapturedOccurrence }
  | { outcome: typeof SECURITY_EVENT_CAPTURE_OUTCOMES.TIMEOUT; error?: unknown }
  | { outcome: typeof SECURITY_EVENT_CAPTURE_OUTCOMES.FAILED; error: unknown };

/**
 * Writes refusal evidence into `security_event_outbox`, best-effort and
 * time-bounded (ADR-053 § 4).
 *
 * ## The contract with the exception filter
 *
 * `record()` never throws and always settles within `timeoutMs`. Success,
 * timeout and failure are distinguishable only in a counter and a log line —
 * never in the HTTP response, which the filter sends unchanged in every case.
 * The authorization decision was made before this runs and nothing here can
 * revisit it: Kafka and audit-service are not reachable from this path at all.
 *
 * ## What a log line here may carry
 *
 * The site key, the outcome, a closed skip reason, the configured timeout, an
 * error class name and a Prisma/SQLSTATE code. Never the exception message, the
 * draft, the user agent, the IP or anything from the request. (The platform
 * logger's context mixin adds the correlation id to every line, as it does for
 * every other log line in the service.)
 *
 * ## Aggregation (Phase C2)
 *
 * "Recorded" means the refusal was counted: into a new row or into the open
 * row of its window. Which one is a store decision made by the database, and
 * shows up only in `rasta_security_event_aggregations_total{result}` — the
 * response, the log and the capture outcome are the same either way.
 */
export class RefusalAuditRecorder {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: RefusalAuditRecorderOptions) {
    // Fail at boot on a window the store would refuse on every refusal.
    assertAggregationWindowSeconds(options.aggregationWindowSeconds);
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? ulid;
  }

  /**
   * Captures one refusal if it is an allowlisted, attributable one.
   *
   * Resolves `undefined` for every exception that is not a marked refusal —
   * the overwhelming majority — without counting or logging anything.
   */
  async record(observation: RefusalObservation): Promise<SecurityEventCaptureOutcome | undefined> {
    let decision: ReturnType<typeof decideCapture>;
    try {
      decision = decideCapture(observation, {
        now: this.now(),
        newId: this.newId,
        producerVersion: this.options.producerVersion,
      });
    } catch (error) {
      this.count(SECURITY_EVENT_CAPTURE_OUTCOMES.FAILED);
      this.log(
        'error',
        { outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.FAILED, ...describeCaptureFailure(error) },
        'Refusal audit capture could not be evaluated; the refusal was returned unchanged',
      );
      return SECURITY_EVENT_CAPTURE_OUTCOMES.FAILED;
    }

    if (decision.kind === 'NOT_A_REFUSAL_SITE') return undefined;

    if (decision.kind === 'SKIP') {
      this.count(SECURITY_EVENT_CAPTURE_OUTCOMES.SKIPPED);
      this.log(
        'warn',
        {
          site: decision.site.key,
          outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.SKIPPED,
          skipReason: decision.reason,
        },
        'Refusal was not captured for audit; the refusal was returned unchanged',
      );
      return SECURITY_EVENT_CAPTURE_OUTCOMES.SKIPPED;
    }

    const result = await this.write(decision.draft);
    this.count(result.outcome);

    if (result.outcome === SECURITY_EVENT_CAPTURE_OUTCOMES.RECORDED) {
      this.countAggregation(result.captured);
    } else {
      this.log(
        'error',
        {
          site: decision.site.key,
          outcome: result.outcome,
          timeoutMs: this.options.timeoutMs,
          ...(result.error !== undefined ? describeCaptureFailure(result.error) : {}),
        },
        'Refusal audit capture did not complete; the refusal was returned unchanged ' +
          'and this refusal may be missing from the audit trail',
      );
    }
    return result.outcome;
  }

  private count(outcome: SecurityEventCaptureOutcome): void {
    try {
      securityEventCapturesTotal.inc({ outcome });
    } catch {
      // Telemetry must never reach the response path.
    }
  }

  private countAggregation(captured: CapturedOccurrence): void {
    try {
      securityEventAggregationsTotal.inc({ result: aggregationOutcomeOf(captured) });
    } catch {
      // Telemetry must never reach the response path.
    }
  }

  private log(level: 'warn' | 'error', fields: Record<string, unknown>, message: string): void {
    try {
      this.options.logger[level](fields, message);
    } catch {
      // Neither may logging.
    }
  }

  /**
   * The capture, raced against a hard deadline.
   *
   * The deadline is what bounds the response; the store's own
   * `statement_timeout` is what stops the database work. A write that commits
   * after its deadline has passed is still a durable count and will be
   * published — it was merely not confirmed in time, and is counted as a
   * timeout.
   */
  private write(draft: SecurityEventRecord): Promise<WriteResult> {
    return new Promise<WriteResult>((resolve) => {
      let settled = false;
      const settle = (result: WriteResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      };

      const deadline = setTimeout(
        () => settle({ outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.TIMEOUT }),
        this.options.timeoutMs,
      );
      deadline.unref?.();

      let pending: Promise<CapturedOccurrence>;
      try {
        pending = this.options.store.capture(draft, {
          timeoutMs: this.options.timeoutMs,
          windowSeconds: this.options.aggregationWindowSeconds,
        });
      } catch (error) {
        settle({ outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.FAILED, error });
        return;
      }

      pending.then(
        (captured) => settle({ outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.RECORDED, captured }),
        (error: unknown) =>
          settle(
            isTimeout(error)
              ? { outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.TIMEOUT, error }
              : { outcome: SECURITY_EVENT_CAPTURE_OUTCOMES.FAILED, error },
          ),
      );
    });
  }
}
