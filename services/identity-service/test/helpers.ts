import { eligibilityClockWrite } from '@rasta/testing';
import { withUtcSession } from '@rasta/config';
import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService } from '../src/prisma/prisma.service';
import { FENCE_POOL_CONNECTIONS, KeycloakWriteFences } from '../src/keycloak/keycloak-write-fence';

/**
 * The minimum scaffolding the ADR-051 B3 integration evidence needs.
 *
 * Deliberately thin, and deliberately new: this service had no integration
 * suite, and B3 requires per-service evidence that a real domain operation
 * commits a correctly sequenced outbox row. Building a full harness is a
 * larger change than B3; this provides exactly what the sequencing evidence
 * needs and nothing else.
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_IDENTITY;
  if (!url) {
    throw new Error(
      'DATABASE_URL_IDENTITY is not set. These tests run against a real PostgreSQL; ' +
        'start it with `pnpm infra:up` and copy .env.example to .env.',
    );
  }
  return withUtcSession(url);
}

export function newPrisma(): PrismaService {
  return new PrismaService(databaseUrl());
}

/**
 * The Keycloak write fences on a pool of their own, as the service runs them
 * (D-069, `app.module.ts`). Connected; the suite closes `pool` in `afterAll`.
 * Their senders' monotonic clock is `clock`, when given ({@link SenderClock}).
 */
export async function newFences(
  clock?: SenderClock,
): Promise<{ fences: KeycloakWriteFences; pool: PrismaService }> {
  const pool = new PrismaService(databaseUrl(), { connections: FENCE_POOL_CONNECTIONS });
  await pool.onModuleInit();
  return {
    fences: new KeycloakWriteFences(pool, clock ? { monotonicNow: clock.now } : {}),
    pool,
  };
}

/**
 * The senders' monotonic clock of a suite (`monotonicNow`): `performance.now`
 * plus every pause so far.
 *
 * A timeout is not, by itself, a late reply (#458 r1 F5): the request's own
 * abort timer is set to the whole milliseconds left, rounded down, so it may
 * fire a fraction **before** the deadline — and an outcome observed then is
 * on time, covered by the attempt's own fence. Whether a sender is late is
 * decided by the clock it reads after the reply. A test that means a late
 * timeout says so: {@link pauseSenderAtNextPut} moves this clock past the
 * deadline while the request is at Keycloak — the sender paused there — so
 * the observation after the timer fires is past it, on every run.
 */
export class SenderClock {
  private paused = 0;
  constructor(private readonly source: () => number = () => performance.now()) {}
  readonly now = (): number => this.source() + this.paused;

  pause(ms: number): void {
    this.paused += ms;
  }
}

/**
 * Real sockets and PostgreSQL, but no race against a short request/fence lifetime.
 * Install per test and restore in afterEach, even when the test throws. Both
 * the client's and the fence's AbortSignal.timeout calls belong to this fixture.
 * A snapshot of pending signals is fired only after the intended PUT (and, for
 * a handoff, the lock waiter) has been observed. Recovery gets new signals.
 */
export class FenceTestTimeline {
  /** Beyond the 60 s test bound; the signal, never elapsed time, ends a request. */
  static readonly requestBudgetMs = 120_000;
  private readonly originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!;
  private pending: AbortController[] = [];
  readonly monotonicNow = (): number => 0;

  install(): void {
    this.pending = [];
    Object.defineProperty(AbortSignal, 'timeout', {
      ...this.originalTimeout,
      value: (_milliseconds: number): AbortSignal => {
        const controller = new AbortController();
        this.pending.push(controller);
        return controller.signal;
      },
    });
  }

  restore(): void {
    Object.defineProperty(AbortSignal, 'timeout', this.originalTimeout);
    this.pending = [];
  }

  fireDeadline(): void {
    const pending = this.pending.splice(0);
    if (pending.length === 0) throw new Error('no request deadline was armed');
    for (const controller of pending) {
      controller.abort(new DOMException('The test fired the deadline', 'TimeoutError'));
    }
  }

  /** Start work, wait for the complete PUT at the server, then fire its deadline. */
  async timeoutAfterPut<T>(stub: { puts(): unknown[] }, start: () => Promise<T>): Promise<T> {
    const before = stub.puts().length;
    // Attach a rejection handler at once: a premature-deadline mutant must
    // fail the dispatch assertion, without an unhandled rejection hiding it.
    const work = start().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitFor('the complete PUT before firing its deadline', async () =>
      stub.puts().length > before ? true : null,
    );

    this.fireDeadline();
    const result = await work;
    if (!result.ok) throw result.error;
    return result.value;
  }

  /** Liveness at the newest retained attempt's start, independent of runner time. */
  async observation(prisma: PrismaService, userId: string): Promise<Date> {
    const [row] = await prisma.client.$queryRaw<Array<{ at: Date | null }>>`
      SELECT max(started_at) AS at FROM keycloak_write_attempt WHERE user_id = ${userId}`;
    if (!row?.at) throw new Error(`no fence to observe for ${userId}`);
    return row.at;
  }

  /** Refusal is about a live row: hold it live well beyond the 60 s harness bound. */
  async holdLive(prisma: PrismaService, userId: string): Promise<void> {
    await eligibilityClockWrite(prisma.client)`
      UPDATE keycloak_write_attempt
         SET takeover_at = GREATEST(takeover_at,
               (clock_timestamp() AT TIME ZONE 'UTC') + interval '2 hours'),
             next_reassert_at = (clock_timestamp() AT TIME ZONE 'UTC') + interval '2 hours'
       WHERE user_id = ${userId}`;
  }

  /** Takeover is a fixture transition, never a sleep through the original lifetime. */
  async expire(prisma: PrismaService, userId: string): Promise<void> {
    // Shift all four instants together: keep each row's deadline/settle windows
    // and ordering, and satisfy the schema's started <= deadline <= takeover.
    await eligibilityClockWrite(prisma.client)`
      WITH shift AS (
        SELECT max(takeover_at) - (clock_timestamp() AT TIME ZONE 'UTC')
                 + interval '2 hours' AS delta
          FROM keycloak_write_attempt WHERE user_id = ${userId}
      )
      UPDATE keycloak_write_attempt
         SET started_at = started_at - shift.delta,
             deadline_at = deadline_at - shift.delta,
             takeover_at = takeover_at - shift.delta,
             next_reassert_at = next_reassert_at - shift.delta
        FROM shift WHERE user_id = ${userId}`;
  }
}

/**
 * The next PUT that reaches `stub` finds its sender paused for `ms` — longer
 * than its request timeout — on `clock`: whatever it hears afterwards, its
 * own timer's abort included, it hears after its deadline. Once.
 */
export function pauseSenderAtNextPut(
  stub: { onPut: ((request: never) => Promise<void>) | null },
  clock: SenderClock,
  ms: number,
): void {
  const previous = stub.onPut;
  let armed = true;
  stub.onPut = async (request: never) => {
    await previous?.(request);
    if (!armed) return;
    armed = false;
    clock.pause(ms);
  };
}

export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/**
 * Tags every identifier one test run creates, so a suite that shares
 * infrastructure with other runs (a developer's `pnpm infra:up`, another
 * suite's Kafka consumer group) can tell its own rows and messages apart.
 * Not currently read by a cleanup routine — this service's integration
 * suites tag rows for grep-ability in a shared log, not for automated
 * teardown.
 */
export const RUN_TAG = ulid().slice(-10);

/**
 * Waits for `check` to become truthy, or gives up with a readable failure.
 *
 * Identity-owned rather than imported from another service: AGENTS.md A-02
 * forbids a service reaching into another's `src/**` or `test/**`, and a
 * generic poll is cheap enough to keep on each side of that boundary rather
 * than share.
 */
export async function waitFor<T>(
  description: string,
  check: () => Promise<T | null | undefined>,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}` +
      (last ? `; last error: ${String(last)}` : ''),
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The database's clock, in Unix milliseconds — the clock every aggregation
 * window decision is made with (AUD-004 Phase C2). Never the test process's.
 */
export async function databaseNowMs(prisma: PrismaService): Promise<number> {
  const rows = await prisma.client.$queryRawUnsafe<{ ms: number }[]>(
    'SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::float8 AS ms',
  );
  const ms = rows[0]?.ms;
  if (typeof ms !== 'number') throw new Error('the database did not report its clock');
  return ms;
}

/**
 * Waits until every Keycloak write fence of `userId` is past its takeover, on
 * the database clock the fences were written with (#458 r3 F8) — not a fixed
 * sleep computed from when the test began: a late sender's fresh fence starts
 * when its outcome was heard, which a slow runner moves later.
 */
export async function untilEveryFenceTakenOver(
  prisma: PrismaService,
  userId: string,
  marginMs = 300,
): Promise<void> {
  const rows = await prisma.client.$queryRaw<Array<{ ms: number | null }>>`
    SELECT (EXTRACT(EPOCH FROM max(takeover_at) - (clock_timestamp() AT TIME ZONE 'UTC'))
              * 1000)::float8 AS ms
      FROM keycloak_write_attempt WHERE user_id = ${userId}`;
  const leftMs = Math.max(0, rows[0]?.ms ?? 0);
  await new Promise((resolve) => setTimeout(resolve, leftMs + marginMs));
}

/**
 * Waits, on the database clock, until at least `neededMs` remain in the current
 * aggregation window, so a burst of refusals a test sends next starts with that
 * margin rather than straddling a boundary by chance.
 *
 * A starting margin, not a completion guarantee: nothing here bounds how long
 * the burst then takes. A burst slower than `neededMs` still crosses into the
 * next window — which is what the 500-write proofs did beside the whole
 * workspace's integration suites, and why they run alone (`jest.config.js`).
 *
 * Windows align to the Unix epoch (`refusal-aggregation.ts`), so the position
 * inside the window is the database time modulo the window length.
 */
export async function atFreshWindow(
  prisma: PrismaService,
  windowSeconds: number,
  neededMs: number,
): Promise<void> {
  const strideMs = windowSeconds * 1000;
  if (neededMs >= strideMs) {
    throw new Error(`a ${windowSeconds}s window can never leave ${neededMs}ms`);
  }
  for (;;) {
    const remaining = strideMs - ((await databaseNowMs(prisma)) % strideMs);
    if (remaining >= neededMs) return;
    await sleep(remaining + 25);
  }
}

/** Waits until row `id`'s aggregation window has closed on the database clock. */
export async function waitForWindowClose(
  prisma: PrismaService,
  id: string,
  timeoutMs = 120_000,
): Promise<void> {
  await waitFor(
    `the aggregation window of ${id} to close`,
    async () => {
      const rows = await prisma.client.$queryRawUnsafe<{ closed: boolean }[]>(
        `SELECT window_ends_at <= (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS closed
           FROM security_event_outbox WHERE id = $1`,
        id,
      );
      return rows[0]?.closed === true;
    },
    timeoutMs,
    50,
  );
}

export function tenants() {
  const suffix = ulid().slice(-10);
  return { a: `ORG-ITEST-A-${suffix}`, b: `ORG-ITEST-B-${suffix}` };
}

export interface ActorOptions {
  organizationId: string;
  userId?: string;
  roles?: string[];
  authType?: 'USER' | 'SERVICE';
}

/**
 * Makes `userId` an `ACTIVE` user with a live membership holding `roles` in
 * `organizationId`, as the database sees it — the authority every
 * identity-administration write re-reads under its locks (task 117, F1; a
 * token's roles alone no longer commit anything). Idempotent and safe to call
 * concurrently: an existing user or live membership is left as it is. Valid
 * since 2000, so no clock a test moves can put it outside its window. No
 * Keycloak account: nothing ever projects it.
 */
export async function ensureLiveMember(
  prisma: PrismaService,
  member: { userId: string; organizationId: string; roles: string[] },
): Promise<void> {
  const handle = `itest-${member.userId.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
  await prisma.client.$executeRaw`
    INSERT INTO "user" (id, username, email, first_name, last_name, status, created_by, updated_by, updated_at)
    VALUES (${member.userId}, ${handle}, ${`${handle}@example.test`}, 'آزمون', 'مدیر', 'ACTIVE',
            'ITEST', 'ITEST', now())
    ON CONFLICT DO NOTHING`;
  await eligibilityClockWrite(prisma.client)`
    INSERT INTO membership (id, user_id, organization_id, roles, status, valid_from, created_by, updated_by, updated_at)
    VALUES (${`MBR_ITEST_${ulid()}`}, ${member.userId}, ${member.organizationId}, ${member.roles}::text[],
            'ACTIVE', TIMESTAMP '2000-01-01 00:00:00', 'ITEST', 'ITEST', now())
    ON CONFLICT DO NOTHING`;
}

/** Runs `fn` as a user acting for an organization. */
export function asActor<T>(options: ActorOptions, fn: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    correlationId: `COR-ITEST-${ulid().slice(-8)}`,
    requestId: `REQ-ITEST-${ulid().slice(-8)}`,
    organizationId: options.organizationId,
    userId: options.userId ?? 'USR-ITEST',
    roles: options.roles ?? ['PLATFORM_OPERATOR'],
    organizationIds: [],
    authType: options.authType ?? 'USER',
    startedAt: Date.now(),
  };
  return runWithContext(context, fn);
}
