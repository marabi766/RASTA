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
 *              success closes the circuit. Any other end of it — a failure, a
 *              timeout, a refusal, its caller leaving — is one its caller could
 *              have chosen, so it decides nothing: the gateway's own readiness
 *              check does (see "What a caller cannot choose"). The probe's
 *              failure or timeout also excludes its caller from the next probe,
 *              and while the service is not ready the circuit opens again for a
 *              fresh cooldown once `organizationsToOpen` distinct organizations
 *              (and people) have
 *              failed a probe (see "Who failed"); a probe that proves nothing
 *              (`release`) frees the slot for the next
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
 *    Whoever's probe failed is excluded from the next one, so another caller probes,
 *    and the circuit re-opens only once enough organizations have failed one: else
 *    a single organization could keep it open by racing for the slot each time.
 *    A probe abandoned holds the slot until its deadline.
 *  - **Recovery exclusions are per person too (#758 r1 R1).** A probe that fails
 *    or is abandoned excludes, from taking the next probe, its organization, the
 *    person behind it (under every membership, and without one), and — if it had
 *    no organization — every caller without one: they could be one person under
 *    many names. The exclusion runs from the moment the slot frees for the
 *    probe's whole granted deadline plus a cooldown, never for what was left of
 *    it when the caller left: so whichever two classes of identity one person
 *    alternates (a membership, and no organization), each turn is followed by a
 *    cooldown in which only someone else can probe. Re-opening takes K probes,
 *    one at a time.
 *
 * **What a caller cannot choose (FU-113).** Which route, which input, how slow,
 * whether to stay: whatever one caller's request ends in, the caller could
 * have chosen it, and several colluding callers under distinct organizations
 * and people satisfy every count above. So no count of callers' outcomes moves
 * the circuit toward OPEN by itself. The gateway's own readiness check of the
 * service — `GET /health/ready`, sent by the gateway with no caller's identity,
 * input or deadline in it (`checkReady`) — decides, at most one at a time:
 *
 *  - A failure run that would open the circuit opens it only if the service is
 *    not ready. If it is, the run is spent and the circuit stays CLOSED; those
 *    organizations still shed themselves.
 *  - A probe that ends in anything but success hands the decision to the
 *    check: ready closes the circuit; not ready leaves the rules above (and a
 *    re-opening still needs it not ready). While the check runs, every request
 *    is refused as while a probe is in flight.
 *  - Anything but a complete 2xx in time is "not ready": fail closed, toward a
 *    failing service opening. No caller's input reaches the check.
 *
 * So while the service's readiness answers 2xx — under whatever load callers
 * put on it — colluding callers can neither open the circuit nor keep it from
 * closing for longer than one probe of their own. Limits: readiness is not the
 * API (a service whose readiness checks only its database can fail every route
 * and stay CLOSED, its organizations shedding themselves; one with a stopped
 * consumer is not ready and falls back to the counts above); load heavy
 * enough to make readiness miss its deadline opens it, as it would have
 * opened before; and a probe's 2xx still closes a service that is not ready.
 *
 * Only callers with a failure or a shed are remembered, at most
 * `MAX_TRACKED_CALLERS` per service, least recently touched forgotten first.
 * Forgetting one can only delay opening or lift a shed; it can never open anything.
 *
 * Classification is the caller's (ProxyService.forward, `answerOutcome`), made
 * once the response body is complete: 2xx–3xx `success`, the only affirmative
 * recovery evidence; a 4xx `release` — a refusal of this one request, evidence
 * neither way (FU-109); 5xx / malformed / truncated / upstream
 * timeout / network error `failure`, client cancellation and gateway-local
 * faults before the request was sent (token issuance, a transport refusal)
 * `release`, client cancellation after it was sent `abandoned` — unless a 5xx
 * status line had already arrived, which is a `failure` (fail closed). A transport
 * error that proves nothing either way is `abandoned` too: this breaker is shared
 * by every tenant, so what one caller can provoke must not count. A request the
 * gateway refuses outright never gets a permit. An expected per-request
 * refusal exempted from counting — identity's complete, valid 503
 * `KEYCLOAK_WRITE_SETTLING` and `KEYCLOAK_UNAVAILABLE` (FU-110) — is a `release`
 * too: it frees the probe slot without changing the failure state.
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
  /**
   * The gateway's own readiness check of `service` (FU-113): true only when it
   * is ready. Anything else — false, a throw, a rejection, a non-boolean — is
   * "not ready". Required: without it nothing could tell a failing service
   * from colluding callers.
   */
  checkReady: (service: ServiceName) => boolean | Promise<boolean>;
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

/** The recovery exclusion every caller without an organization shares. */
const ORGLESS = 'orgless';

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
  /**
   * Who may not take the probe before when: `org:<id>`, `person:<id>`, and
   * {@link ORGLESS} for every caller without an organization. Bounded like
   * `callers`; cleared when the circuit closes.
   */
  excluded: Map<string, number>;
  /** Callers with a standing failure or a shed, least recently touched first. */
  callers: Map<Caller, CallerFailures>;
  /** The readiness check in flight, and the generation that sent it; null if none. */
  checking: { generation: number; done: Promise<void> } | null;
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
  /** The deadline it was granted when it was sent, in milliseconds. */
  deadlineMs?: number;
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
    // Excluded from recovery as an organization, as a person under any of its
    // identities, or as one more caller without an organization.
    const barredForMs = this.excludedUntil(circuit, caller, person) - this.options.now();
    if (barredForMs > 0) {
      throw refusal(
        service,
        'circuit-half-open',
        circuitRetryAfterSeconds(barredForMs),
        barredForMs,
      );
    }
    if (circuit.state === 'OPEN') this.transition(service, circuit, 'HALF_OPEN');
    // The gateway's own check holds the slot while it runs.
    if (circuit.checking?.generation === circuit.generation) {
      throw refusal(service, 'circuit-half-open', HALF_OPEN_RETRY_AFTER_SECONDS);
    }

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
    (permit as Permit).deadlineMs = deadlineMs;
    (permit as Permit).deadlineAt = this.options.now() + deadlineMs;
  }

  /**
   * Applies what one request proved. Stale, repeated or foreign permits change
   * nothing. Returns, when this outcome sent the gateway's readiness check or
   * found one in flight, a promise settled once the check has decided; it never
   * rejects.
   */
  settle(permit: CircuitPermit, outcome: CircuitOutcome): void | Promise<void> {
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
        const until = this.exclusionEnd(own, own.heldUntil, this.options.resetAfterMs);
        this.exclude(circuit, own, until);
      } else {
        circuit.probe = null;
        if (outcome === 'success') {
          circuit.failures = 0;
          this.transition(own.service, circuit, 'CLOSED');
          return;
        }
        if (outcome === 'failure') {
          this.addFailure(own, circuit);
          this.exclude(circuit, own, this.exclusionEnd(own, this.options.now(), 0));
        }
      }
      // Its caller could have chosen this end: the gateway's own check decides.
      return this.check(own.service, circuit);
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
        // Callers could have provoked every one of these: it opens only if the
        // gateway's own check finds the service not ready.
        return this.check(own.service, current);
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
      excluded: new Map(),
      callers: new Map(),
      checking: null,
    };
    this.circuits.set(service, circuit);
    circuitStateGauge.set({ service }, STATE_VALUE.CLOSED);
    return circuit;
  }

  private addFailure({ service, caller, person }: Permit, circuit: Circuit): void {
    circuit.failures += 1;
    circuit.failureSeq += 1;

    const now = this.options.now();
    const failures = (circuit.callers.get(caller)?.failures ?? 0) + 1;
    const shed = failures >= this.options.failureThreshold;
    this.remember(circuit, caller, {
      failures,
      lastSeq: circuit.failureSeq,
      lastAt: now,
      person,
      ...(shed ? { shedUntil: now + this.options.resetAfterMs } : {}),
    });
    if (shed) {
      // Never the tenant's id: logs are not where tenants are named.
      const who = isOrganization(caller) ? 'an organization' : 'a caller without an organization';
      this.logger.warn(`Circuit for ${service}: shedding ${who} after ${failures} failures`);
    }
  }

  /**
   * When a probe that failed or was abandoned stops excluding its caller: from
   * the moment the slot frees, its whole granted deadline plus a cooldown. Never
   * what was left of the deadline. `unsent` stands in for a deadline it never got.
   */
  private exclusionEnd(probe: Permit, freedAt: number, unsent: number): number {
    const granted = probe.deadlineMs ?? unsent;
    return freedAt + granted + this.options.resetAfterMs;
  }

  /** Who may not take the probe until `until`: the organization, the person, and every caller without an organization if it had none. */
  private exclude(circuit: Circuit, { caller, person }: Permit, until: number): void {
    const keys: string[] = [];
    if (isOrganization(caller)) keys.push(caller);
    else keys.push(ORGLESS);
    if (person !== undefined) keys.push(`person:${person}`);
    for (const key of keys) {
      // Never excluded now: whoever took the probe was not.
      circuit.excluded.delete(key);
      circuit.excluded.set(key, until);
      if (circuit.excluded.size > MAX_TRACKED_CALLERS) {
        circuit.excluded.delete(circuit.excluded.keys().next().value as string);
      }
    }
  }

  /** Until when this caller may not take the probe; 0 if it may. */
  private excludedUntil(circuit: Circuit, caller: Caller, person: string | undefined): number {
    const own = isOrganization(caller) ? caller : ORGLESS;
    const asPerson = person === undefined ? 0 : (circuit.excluded.get(`person:${person}`) ?? 0);
    return Math.max(circuit.excluded.get(own) ?? 0, asPerson);
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

  /**
   * Sends the gateway's readiness check of `service`, unless this generation
   * has one in flight, and applies its answer while the generation is current.
   * Ready: CLOSED stays CLOSED with the failure run sent before the check spent,
   * HALF_OPEN closes. Not ready: CLOSED opens (its run already met every count),
   * HALF_OPEN re-opens once enough organizations have failed a probe.
   */
  private check(service: ServiceName, circuit: Circuit): void | Promise<void> {
    if (circuit.checking?.generation === circuit.generation) return circuit.checking.done;
    const generation = circuit.generation;
    const sentAtSeq = circuit.failureSeq;
    const decide = (ready: unknown) => {
      if (circuit.checking?.generation === generation) circuit.checking = null;
      if (circuit.generation !== generation) return;
      if (ready === true) {
        this.logger.log(`Circuit for ${service}: the service is ready`);
        if (circuit.state === 'CLOSED') {
          circuit.clearedSeq = Math.max(circuit.clearedSeq, sentAtSeq);
          circuit.failures = Math.min(circuit.failures, circuit.failureSeq - sentAtSeq);
        } else {
          circuit.failures = 0;
          this.transition(service, circuit, 'CLOSED');
        }
      } else if (circuit.state === 'CLOSED' || this.enoughOrganizationsFailing(circuit)) {
        this.open(service, circuit);
      }
    };
    let answer: unknown;
    try {
      answer = this.options.checkReady(service);
    } catch {
      answer = false;
    }
    if (!(answer instanceof Promise)) return decide(answer);
    const done = answer
      .then(decide, () => decide(false))
      .catch((error: unknown) => {
        this.logger.error(`Circuit for ${service}: applying the readiness check failed: ${error}`);
      });
    circuit.checking = { generation, done };
    return done;
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
      circuit.excluded.clear();
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
