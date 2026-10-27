import { Logger } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { ERROR_CODES } from '@rasta/contracts';
import type { ServiceName } from '../config/routes';
import { circuitStateGauge } from './circuit.metrics';

/**
 * The gateway's circuit breaker: one explicit state machine per downstream
 * service (#381 r4 F2).
 *
 *   CLOSED     every request is forwarded. `failureThreshold` consecutive
 *              failures open it.
 *   OPEN       every request is refused without contacting the service, with
 *              `Retry-After` = the cooldown's remaining time. The first request
 *              after `resetAfterMs` moves it to HALF_OPEN and is its probe.
 *   HALF_OPEN  exactly ONE request — the probe — is in flight. Every other
 *              request is refused fast, `Retry-After` = 1 s. The probe's
 *              success closes the circuit; its failure or timeout opens it
 *              again for a fresh cooldown; a probe that proves nothing
 *              (`release`) frees the slot for the next request and leaves the
 *              circuit exactly as it was.
 *
 * Three rules keep a response from deciding more than it saw:
 *
 *  - **Generations.** Every transition starts a new generation, and a request
 *    carries the generation that admitted it. Its outcome — success, failure
 *    or release — is applied only while that generation is still current. A
 *    request admitted before the circuit opened cannot close it with a late
 *    200; a request admitted before the probe cannot reopen, decide or release
 *    the probe.
 *  - **The probe is one permit, not one generation.** HALF_OPEN remembers the
 *    permit holding the slot; only that permit can decide or release it, so a
 *    released probe's late callback cannot touch its successor.
 *  - **Exactly once.** A permit settles once; anything after is ignored. The
 *    caller settles in `finally` — every exit path gives the slot back.
 *
 * Inside CLOSED, a success clears the failure count only if no failure was
 * recorded after the request was admitted: an older success is no evidence
 * against newer failures.
 *
 * Classification is the caller's (ProxyService.forward), made once the
 * response body is complete: 2xx–4xx `success` (a 4xx is the service
 * answering, not the service failing), 5xx / malformed / truncated / upstream
 * timeout / network error `failure`, client cancellation and gateway-local
 * faults (token issuance) `release`. An expected per-request refusal exempted
 * from counting (#381's identity refusals) is a `release` too: it frees the
 * probe slot without changing the failure state.
 */

export type CircuitStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** What one forwarded request proved about its service, decided once. */
export type CircuitOutcome = 'success' | 'failure' | 'release';

/** One admitted request's right to report on its service's circuit. */
export interface CircuitPermit {
  readonly service: ServiceName;
  /** The generation that admitted it; its outcome counts only while it is current. */
  readonly generation: number;
  /** Whether it holds HALF_OPEN's single probe slot. */
  readonly probe: boolean;
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetAfterMs: number;
  /** Milliseconds on a monotonic clock: a wall-clock step must not end or stretch a cooldown. */
  now: () => number;
}

/** How the breaker shows on the gateway's readiness endpoint. */
export interface CircuitStateView {
  failures: number;
  open: boolean;
  state: CircuitStateName;
}

/**
 * `Retry-After` for a request refused by an open circuit: the breaker's
 * remaining open time, rounded up to whole seconds and clamped to 1..3600.
 */
export function circuitRetryAfterSeconds(remainingMs: number): number {
  return Math.min(3600, Math.max(1, Math.ceil(remainingMs / 1000)));
}

/**
 * `Retry-After` while a probe is in flight. Fixed, not computed: the probe ends
 * within its own deadline, and a refusal costs nothing, so a short wait is right.
 */
export const HALF_OPEN_RETRY_AFTER_SECONDS = 1;

interface Circuit {
  state: CircuitStateName;
  generation: number;
  /** Consecutive failures, as reported; cleared by a success that saw them all. */
  failures: number;
  /** Every failure ever recorded here; tells an older success from a newer failure. */
  failureSeq: number;
  openedAt: number | null;
  /** HALF_OPEN's probe; null while the slot is free. */
  probe: Permit | null;
}

interface Permit extends CircuitPermit {
  /** `failureSeq` when it was admitted. */
  readonly failuresSeen: number;
  settled: boolean;
}

const STATE_VALUE: Record<CircuitStateName, number> = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 };

export class CircuitBreakers {
  private readonly logger = new Logger('CircuitBreaker');
  /** Created on a service's first failure; a service never failed is CLOSED at generation 0. */
  private readonly circuits = new Map<ServiceName, Circuit>();

  constructor(private readonly options: CircuitBreakerOptions) {}

  /**
   * Admits one request to `service`, or refuses it with the 503
   * `UPSTREAM_UNAVAILABLE` envelope and a typed `Retry-After`. Every permit
   * returned must be settled exactly once.
   */
  admit(service: ServiceName): CircuitPermit {
    const circuit = this.circuits.get(service);
    if (!circuit || circuit.state === 'CLOSED') {
      return this.permit(service, circuit, false);
    }

    if (circuit.state === 'OPEN') {
      const elapsed = this.options.now() - (circuit.openedAt ?? 0);
      if (elapsed < this.options.resetAfterMs) {
        const remainingMs = this.options.resetAfterMs - elapsed;
        throw refusal(service, 'circuit-open', circuitRetryAfterSeconds(remainingMs), remainingMs);
      }
      this.transition(service, circuit, 'HALF_OPEN');
    }

    if (circuit.probe) {
      throw refusal(service, 'circuit-half-open', HALF_OPEN_RETRY_AFTER_SECONDS);
    }
    const probe = this.permit(service, circuit, true);
    circuit.probe = probe;
    this.logger.log(`Circuit for ${service} is half-open; probing`);
    return probe;
  }

  /** Applies what one request proved. Stale, repeated or foreign permits change nothing. */
  settle(permit: CircuitPermit, outcome: CircuitOutcome): void {
    const own = permit as Permit;
    if (own.settled) return;
    own.settled = true;

    const circuit = this.circuits.get(own.service);
    if (own.generation !== (circuit?.generation ?? 0)) return;

    if (own.probe) {
      // Only the permit holding the slot decides it (a released probe's
      // successor is in the same generation).
      if (!circuit || circuit.state !== 'HALF_OPEN' || circuit.probe !== own) return;
      circuit.probe = null;
      if (outcome === 'success') {
        circuit.failures = 0;
        this.transition(own.service, circuit, 'CLOSED');
      } else if (outcome === 'failure') {
        this.addFailure(circuit);
        this.open(own.service, circuit);
      }
      return;
    }

    // A non-probe permit is current only while its circuit is CLOSED: every
    // other state began with a transition, a new generation.
    if (outcome === 'success') {
      if (circuit && circuit.failures > 0 && circuit.failureSeq === own.failuresSeen) {
        circuit.failures = 0;
      }
    } else if (outcome === 'failure') {
      const current = circuit ?? this.create(own.service);
      this.addFailure(current);
      if (current.failures >= this.options.failureThreshold) this.open(own.service, current);
    }
  }

  /** Current breaker state per service that has ever failed. */
  states(): Record<string, CircuitStateView> {
    const result: Record<string, CircuitStateView> = {};
    for (const [service, circuit] of this.circuits) {
      result[service] = {
        failures: circuit.failures,
        open: circuit.state === 'OPEN',
        state: circuit.state,
      };
    }
    return result;
  }

  // -------------------------------------------------------------------------

  private permit(service: ServiceName, circuit: Circuit | undefined, probe: boolean): Permit {
    return {
      service,
      generation: circuit?.generation ?? 0,
      probe,
      failuresSeen: circuit?.failureSeq ?? 0,
      settled: false,
    };
  }

  private create(service: ServiceName): Circuit {
    const circuit: Circuit = {
      state: 'CLOSED',
      generation: 0,
      failures: 0,
      failureSeq: 0,
      openedAt: null,
      probe: null,
    };
    this.circuits.set(service, circuit);
    circuitStateGauge.set({ service }, STATE_VALUE.CLOSED);
    return circuit;
  }

  private addFailure(circuit: Circuit): void {
    circuit.failures += 1;
    circuit.failureSeq += 1;
  }

  private open(service: ServiceName, circuit: Circuit): void {
    circuit.openedAt = this.options.now();
    const reopened = circuit.state === 'HALF_OPEN';
    this.transition(service, circuit, 'OPEN');
    this.logger.error(
      reopened
        ? `Circuit for ${service} re-opened: the probe failed`
        : `Circuit for ${service} opened after ${circuit.failures} consecutive failures`,
    );
  }

  private transition(service: ServiceName, circuit: Circuit, state: CircuitStateName): void {
    circuit.state = state;
    circuit.generation += 1;
    circuit.probe = null;
    if (state === 'CLOSED') {
      circuit.openedAt = null;
      this.logger.log(`Circuit for ${service} closed`);
    }
    circuitStateGauge.set({ service }, STATE_VALUE[state]);
  }
}

function refusal(
  service: ServiceName,
  reason: 'circuit-open' | 'circuit-half-open',
  retryAfterSeconds: number,
  retryInMs?: number,
): RastaError {
  // The wait is the typed field the exception filter sends as `Retry-After`,
  // never read back out of `internalContext`.
  return new RastaError(
    ERROR_CODES.UPSTREAM_UNAVAILABLE,
    'A required service is temporarily unavailable',
    {
      internalContext: { service },
      cause: { reason, ...(retryInMs !== undefined ? { retryInMs } : {}) },
      retryAfterSeconds,
    },
  );
}
