import { Logger } from '@nestjs/common';
import { RastaError } from '@rasta/nest-common';
import { ERROR_CODES } from '@rasta/contracts';
import { DEFAULT_ORGANIZATIONS_TO_OPEN } from '../config/env';
import type { ServiceName } from '../config/routes';
import { circuitShedRefusalsTotal, circuitStateGauge } from './circuit.metrics';

/**
 * The gateway's circuit breaker: one explicit state machine per downstream
 * service (#381 r4 F2).
 *
 *   CLOSED     every request is forwarded. `failureThreshold` consecutive
 *              failures open it, once they come from `organizationsToOpen`
 *              distinct organizations and as many distinct people.
 *   OPEN       every request is refused without contacting the service, with
 *              `Retry-After` = the cooldown's remaining time. The first request
 *              after `resetAfterMs` from a caller that is not shed moves it to
 *              HALF_OPEN and is its probe.
 *   HALF_OPEN  exactly ONE request — the probe — is in flight. Every other
 *              request is refused fast, `Retry-After` = 1 s. The probe's
 *              success closes the circuit; its failure or timeout sheds its
 *              caller, and opens the circuit again for a fresh cooldown once
 *              `organizationsToOpen` distinct organizations (and people) have
 *              failed a probe (see "Who failed"); a probe that proves nothing
 *              before it was sent (`release`) frees the slot for the next
 *              request and leaves the circuit exactly as it was. A probe whose
 *              caller left after it was sent (`abandoned`) keeps the slot until
 *              its own upstream deadline has passed on this breaker's clock —
 *              the service may still be working on it — and only then frees
 *              it, again as neither success nor failure (#460 r1 F1). So at
 *              most ONE probe is in flight at a time, whatever callers do; a
 *              failed probe frees the slot at once for the next caller.
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
 * **Who failed (FU-085).** This circuit is shared by every tenant, and a service
 * 5xx or a deadline is something one tenant can provoke with its own input. So
 * every counted failure is attributed to the caller's verified organization, and
 * to the person behind it (the token's subject, or the calling service):
 *
 *  - **Opening takes several organizations.** A failure run opens the circuit
 *    only while `organizationsToOpen` distinct organizations have a standing
 *    failure, and the latest of those failures came from as many distinct
 *    people — one person holding three memberships is still one. A failure
 *    stands while it is recent (`VOTE_WINDOW_COOLDOWNS`), after the run's last
 *    clearing, and not followed by a success of that organization's own. When
 *    many tenants fail, the run opens on the same failure as today if
 *    `failureThreshold >= organizationsToOpen`; below that, on the failure that
 *    brings the K-th organization.
 *  - **An organization alone sheds only itself.** `failureThreshold` consecutive
 *    failures of its own refuse that organization's requests to this service for
 *    one cooldown. After it, its first failure sheds it again.
 *  - **No organization never counts.** A verified caller without an organization
 *    is a bucket of its own, per person; every anonymous caller is one more
 *    bucket. These shed only themselves and are never an organization toward
 *    opening.
 *  - **Re-opening takes as many.** What opened the circuit is spent when it opens.
 *    Whoever's probe failed is shed for a cooldown, so another caller probes next,
 *    and the circuit re-opens only once enough organizations have failed one: else
 *    a single organization could keep it open by racing for the slot each time.
 *    A probe abandoned holds the slot until its deadline and sheds its caller for
 *    that hold again plus a cooldown, so that two identities of one attacker,
 *    taking turns, still leave a cooldown free for everyone else. A failed or
 *    abandoned probe of any caller without an organization bars every such caller
 *    from probing for as long: they could be one person under many names.
 *    Re-opening takes K probes, one at a time.
 *
 * Only callers with a failure or a shed are remembered, at most
 * `MAX_TRACKED_CALLERS` per service, least recently touched forgotten first.
 * Forgetting one can only delay opening or lift a shed; it can never open anything.
 *
 * Classification is the caller's (ProxyService.forward), made once the
 * response body is complete: 2xx–4xx `success` (a 4xx is the service
 * answering, not the service failing), 5xx / malformed / truncated / upstream
 * timeout / network error `failure`, client cancellation and gateway-local
 * faults before the request was sent (token issuance, a transport refusal)
 * `release`, client cancellation after it was sent `abandoned` — unless a 5xx
 * status line had already arrived, which is a `failure` (fail closed). A transport
 * error that proves nothing either way is `abandoned` too: this breaker is shared
 * by every tenant, so what one caller can provoke must not count. A request the
 * gateway refuses outright never gets a permit. An expected per-request
 * refusal exempted from counting (#381's identity refusals) is a `release` too,
 * once its body is complete: it frees the probe slot without changing the
 * failure state.
 */

export type CircuitStateName = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * What one forwarded request proved about its service, decided once.
 * `release` — nothing outstanding upstream (never sent, or answered in full);
 * `abandoned` — sent, then the caller left: the upstream work may still run.
 */
export type CircuitOutcome = 'success' | 'failure' | 'release' | 'abandoned';

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
  /** Distinct organizations a failure run needs to open the circuit; {@link DEFAULT_ORGANIZATIONS_TO_OPEN} if unset. */
  organizationsToOpen?: number;
}

/** Callers remembered per service. The ids come from signed tokens; the bound does not rely on it. */
export const MAX_TRACKED_CALLERS = 1024;

/**
 * How many cooldowns an organization's latest failure keeps counting toward
 * opening. One: older stray failures of others must not let one tenant's burst
 * complete the count.
 */
export const VOTE_WINDOW_COOLDOWNS = 1;

/** The one bucket of every anonymous caller. No id can equal it. */
const ANONYMOUS = Symbol('anonymous');

/** `org:<id>`, `person:<id>` for a verified caller without an organization, or {@link ANONYMOUS}. */
type Caller = string | typeof ANONYMOUS;

/** Who a request is attributed to, and whether it may count toward opening. */
function callerOf(organizationId: string | undefined, person: string | undefined): Caller {
  if (organizationId) return `org:${organizationId}`;
  if (person) return `person:${person}`;
  return ANONYMOUS;
}

const isOrganization = (caller: Caller): caller is string =>
  typeof caller === 'string' && caller.startsWith('org:');

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
 * While an abandoned probe holds the slot the wait is known — the time left to
 * its deadline — and that is sent instead.
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
  /** `failureSeq` when `failures` was last cleared: what came before is no evidence now. */
  clearedSeq: number;
  /** Callers without an organization may not take the probe before this time. */
  orglessProbeUntil: number;
  /** Callers with a standing failure or a shed, least recently touched first. */
  callers: Map<Caller, CallerFailures>;
}

interface CallerFailures {
  /** Consecutive failures of this caller's own. */
  failures: number;
  /** The circuit's `failureSeq` at its latest failure. */
  lastSeq: number;
  lastAt: number;
  /** The person behind its latest failure, if one is known: one person is one vote. */
  person?: string;
  /** Refused until this time; 0 if it never was. */
  shedUntil: number;
}

interface Permit extends CircuitPermit {
  /** `failureSeq` when it was admitted. */
  readonly failuresSeen: number;
  readonly caller: Caller;
  readonly person: string | undefined;
  settled: boolean;
  /** Its upstream deadline on this breaker's clock; set when it is sent. */
  deadlineAt?: number;
  /** An abandoned probe: the slot stays its own until this time. */
  heldUntil?: number;
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
   * returned must be settled exactly once. `organizationId` is the caller's
   * verified organization, from the request context and never from a header;
   * without one the caller is in a bucket that never counts toward opening.
   * `person` is who is behind it (the token's subject, or the calling service):
   * an organization's failure without one never counts toward opening.
   */
  admit(service: ServiceName, organizationId: string | undefined, person?: string): CircuitPermit {
    const caller = callerOf(organizationId, person);
    const circuit = this.circuits.get(service);
    if (!circuit) return this.permit(service, circuit, false, caller, person);

    // First: a shed caller must not move the circuit, or take its probe.
    const shedForMs = (circuit.callers.get(caller)?.shedUntil ?? 0) - this.options.now();
    if (shedForMs > 0) {
      circuitShedRefusalsTotal.inc({ service });
      throw refusal(service, 'caller-shed', circuitRetryAfterSeconds(shedForMs), shedForMs);
    }
    if (circuit.state === 'CLOSED') return this.permit(service, circuit, false, caller, person);

    if (circuit.state === 'OPEN') {
      const elapsed = this.options.now() - (circuit.openedAt ?? 0);
      if (elapsed < this.options.resetAfterMs) {
        const remainingMs = this.options.resetAfterMs - elapsed;
        throw refusal(service, 'circuit-open', circuitRetryAfterSeconds(remainingMs), remainingMs);
      }
    }
    // Callers without an organization share one probe limit: one person can be
    // anonymous and several organization-less identities at once.
    const barredForMs = isOrganization(caller) ? 0 : circuit.orglessProbeUntil - this.options.now();
    if (barredForMs > 0) {
      throw refusal(
        service,
        'circuit-half-open',
        circuitRetryAfterSeconds(barredForMs),
        barredForMs,
      );
    }
    if (circuit.state === 'OPEN') this.transition(service, circuit, 'HALF_OPEN');

    if (circuit.probe) {
      const heldUntil = circuit.probe.heldUntil;
      if (heldUntil === undefined) {
        throw refusal(service, 'circuit-half-open', HALF_OPEN_RETRY_AFTER_SECONDS);
      }
      const remainingMs = heldUntil - this.options.now();
      if (remainingMs > 0) {
        throw refusal(
          service,
          'circuit-half-open',
          circuitRetryAfterSeconds(remainingMs),
          remainingMs,
        );
      }
      // The abandoned probe's deadline has passed: the gateway would have given
      // up on it by now. Freed as neither success nor failure. Fenced like
      // every outcome: a transition clears `circuit.probe`, so only the
      // generation that admitted it can reach here.
      circuit.probe = null;
      this.logger.warn(`Circuit for ${service}: the abandoned probe's deadline passed; slot freed`);
    }
    const probe = this.permit(service, circuit, true, caller, person);
    circuit.probe = probe;
    this.logger.log(`Circuit for ${service} is half-open; probing`);
    return probe;
  }

  /**
   * Records that `permit`'s request is being sent, with `deadlineMs` to be
   * answered. Called immediately before the upstream call: from here on the
   * caller leaving is `abandoned`, not `release`.
   */
  dispatched(permit: CircuitPermit, deadlineMs: number): void {
    (permit as Permit).deadlineAt = this.options.now() + deadlineMs;
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
      if (outcome === 'abandoned') {
        // Sent, and the caller left: the service may still be working on it,
        // so no second probe is sent until this one's deadline has passed.
        // Never sent through `dispatched`, it has no deadline of its own: a
        // full cooldown, rather than none.
        const now = this.options.now();
        own.heldUntil = own.deadlineAt ?? now + this.options.resetAfterMs;
        // The hold again, then a cooldown: while another identity of the same
        // caller holds the slot as long, this one is still shed when it frees.
        const shedUntil = own.heldUntil + (own.heldUntil - now) + this.options.resetAfterMs;
        this.remember(circuit, own.caller, { shedUntil });
        this.barOrgless(circuit, own.caller, shedUntil);
        return;
      }
      circuit.probe = null;
      if (outcome === 'success') {
        circuit.failures = 0;
        this.transition(own.service, circuit, 'CLOSED');
      } else if (outcome === 'failure') {
        this.addFailure(own, circuit);
        if (this.enoughOrganizationsFailing(circuit)) this.open(own.service, circuit);
      }
      return;
    }

    // A non-probe permit is current only while its circuit is CLOSED: every
    // other state began with a transition, a new generation. `release` and
    // `abandoned` record nothing here.
    if (outcome === 'success') {
      if (!circuit) return;
      if (circuit.failures > 0 && circuit.failureSeq === own.failuresSeen) {
        circuit.failures = 0;
        circuit.clearedSeq = circuit.failureSeq;
      }
      const standing = circuit.callers.get(own.caller);
      if (standing && standing.lastSeq <= own.failuresSeen) circuit.callers.delete(own.caller);
    } else if (outcome === 'failure') {
      const current = circuit ?? this.create(own.service);
      this.addFailure(own, current);
      if (
        current.failures >= this.options.failureThreshold &&
        this.enoughOrganizationsFailing(current)
      ) {
        this.open(own.service, current);
      }
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

  private permit(
    service: ServiceName,
    circuit: Circuit | undefined,
    probe: boolean,
    caller: Caller,
    person: string | undefined,
  ): Permit {
    return {
      service,
      generation: circuit?.generation ?? 0,
      probe,
      caller,
      person,
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
      clearedSeq: 0,
      orglessProbeUntil: 0,
      callers: new Map(),
    };
    this.circuits.set(service, circuit);
    circuitStateGauge.set({ service }, STATE_VALUE.CLOSED);
    return circuit;
  }

  private addFailure({ service, caller, person, probe }: Permit, circuit: Circuit): void {
    circuit.failures += 1;
    circuit.failureSeq += 1;

    const now = this.options.now();
    const failures = (circuit.callers.get(caller)?.failures ?? 0) + 1;
    const shed = probe || failures >= this.options.failureThreshold;
    this.remember(circuit, caller, {
      failures,
      lastSeq: circuit.failureSeq,
      lastAt: now,
      person,
      ...(shed ? { shedUntil: now + this.options.resetAfterMs } : {}),
    });
    if (probe) this.barOrgless(circuit, caller, now + this.options.resetAfterMs);
    if (shed) {
      // Never the tenant's id: logs are not where tenants are named.
      const who = isOrganization(caller) ? 'an organization' : 'a caller without an organization';
      this.logger.warn(`Circuit for ${service}: shedding ${who} after ${failures} failures`);
    }
  }

  /** A failed or abandoned probe without an organization bars every such caller from probing. */
  private barOrgless(circuit: Circuit, caller: Caller, until: number): void {
    if (!isOrganization(caller)) {
      circuit.orglessProbeUntil = Math.max(circuit.orglessProbeUntil, until);
    }
  }

  /** Updates a caller, making it the most recently touched; the least recently touched goes past the cap. */
  private remember(circuit: Circuit, caller: Caller, change: Partial<CallerFailures>): void {
    const known = circuit.callers.get(caller) ?? {
      failures: 0,
      // No failure: never above `clearedSeq`, so never one that stands.
      lastSeq: 0,
      lastAt: 0,
      shedUntil: 0,
    };
    circuit.callers.delete(caller);
    circuit.callers.set(caller, { ...known, ...change });
    if (circuit.callers.size > MAX_TRACKED_CALLERS) {
      circuit.callers.delete(circuit.callers.keys().next().value as Caller);
    }
  }

  /** Whether enough distinct organizations, and people, have a failure that still stands. */
  private enoughOrganizationsFailing(circuit: Circuit): boolean {
    const needed = this.options.organizationsToOpen ?? DEFAULT_ORGANIZATIONS_TO_OPEN;
    const windowMs = VOTE_WINDOW_COOLDOWNS * this.options.resetAfterMs;
    const now = this.options.now();
    let organizations = 0;
    const people = new Set<string>();
    for (const [caller, { lastSeq, lastAt, person }] of circuit.callers) {
      if (!isOrganization(caller) || person === undefined) continue;
      if (lastSeq <= circuit.clearedSeq || now - lastAt >= windowMs) continue;
      organizations += 1;
      people.add(person);
      if (organizations >= needed && people.size >= needed) return true;
    }
    return false;
  }

  private open(service: ServiceName, circuit: Circuit): void {
    circuit.openedAt = this.options.now();
    // Spent: a probe's failure alone must not find them still standing.
    circuit.clearedSeq = circuit.failureSeq;
    const reopened = circuit.state === 'HALF_OPEN';
    this.transition(service, circuit, 'OPEN');
    this.logger.error(
      reopened
        ? `Circuit for ${service} re-opened: probes failed across organizations`
        : `Circuit for ${service} opened after ${circuit.failures} consecutive failures across organizations`,
    );
  }

  private transition(service: ServiceName, circuit: Circuit, state: CircuitStateName): void {
    circuit.state = state;
    circuit.generation += 1;
    circuit.probe = null;
    if (state === 'CLOSED') {
      circuit.openedAt = null;
      // The service answered: nothing from before is evidence against it now.
      circuit.callers.clear();
      circuit.orglessProbeUntil = 0;
      this.logger.log(`Circuit for ${service} closed`);
    }
    circuitStateGauge.set({ service }, STATE_VALUE[state]);
  }
}

function refusal(
  service: ServiceName,
  reason: 'circuit-open' | 'circuit-half-open' | 'caller-shed',
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
