import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { withDatabasePool } from '@rasta/config';
import type { EventEnvelope } from '@rasta/contracts';
import { runUnscoped, type EventConsumer, type EventHandler } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IDENTITY_EVENTS } from '../src/identity/events';
import { IdentityService } from '../src/identity/identity.service';
import { MembershipExpiryScanner } from '../src/identity/membership-expiry.scanner';
import {
  FENCE_POOL_CONNECTIONS,
  KeycloakWriteFences,
  type KeycloakWriteAttempt,
} from '../src/keycloak/keycloak-write-fence';
import type { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import { KeycloakProjectionConsumer } from '../src/keycloak/keycloak-projection.consumer';
import { KeycloakProjector, settleRecoveryProjections } from '../src/keycloak/keycloak.projector';
import { runProjectionCommand } from '../src/keycloak/projection.command';
import { keycloakWriteFenceEventsTotal } from '../src/observability/keycloak-projection.metrics';
import {
  isWithin,
  platformAttributesFor,
  provenanceOnly,
  readPlatformAttributes,
  type PlatformAttributes,
} from '../src/keycloak/platform-attributes';
import { withCancellation } from '../src/prisma/cancellation';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  asActor,
  databaseUrl,
  id,
  newFences,
  newPrisma,
  pauseSenderAtNextPut,
  SenderClock,
  tenants,
  waitFor,
} from './helpers';
import { KeycloakHttpStub, type StubRequest } from './keycloak-http-stub';

/**
 * D-069 (#402 r1 F1–F4, #381 r3 F1): the durable in-flight fence of every
 * Keycloak write, against a real PostgreSQL and the real `KeycloakAdminClient`
 * over a real socket to `keycloak-http-stub.ts`.
 *
 * Every interleaving the review named is forced, never hoped for:
 *
 * - **the handoff** — a writer's PUT outlives its transaction, which rolls
 *   back and releases the user lock to a narrowing already waiting for it:
 *   the fence was committed before the PUT, so the narrowing sees it and
 *   refuses (the r1 F1 sequence, for a projection and for a write-ahead);
 * - **durability** — a fence outlives the process that wrote it;
 * - **ownership** — only the owning attempt removes its row, by id; a late
 *   callback never clears a newer one; the sweep takes over only after
 *   deadline + settle;
 * - **the late sender** — the deadline is checked again immediately before
 *   dispatch; and how long that check precedes the socket write, measured;
 * - **the lock graph** — the fence insert never waits on the business
 *   transaction, even with the business pool exhausted;
 * - **creation** — an operator's account and an approval's are created
 *   disabled and granting nothing, and granted and enabled only through the
 *   fenced path, after commit; an adoption's late disable cannot outlive the
 *   enable unseen;
 * - **the clock** (F3), **fair progress** (F2), **the stop** (F4) and the
 *   **terminal 404**.
 */

const SETTLE_SECONDS = 2;
/** The stub client's request deadline: the fence's `deadline_at - started_at`. */
const REQUEST_TIMEOUT_MS = 400;
/** Longer than a request's deadline: how far a paused sender's clock moves on. */
const PAUSE_MS = REQUEST_TIMEOUT_MS + 1_000;
/** From a fence's opening until it is no longer live, and a margin. */
const TAKEOVER_MS = REQUEST_TIMEOUT_MS + SETTLE_SECONDS * 1000 + 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('D-069: every Keycloak write is fenced before it is sent', () => {
  let prisma: PrismaService;
  let holder: PrismaService;
  let repository: IdentityRepository;
  let holderRepository: IdentityRepository;
  let stub: KeycloakHttpStub;
  let keycloak: KeycloakAdminClient;
  let fencing: Awaited<ReturnType<typeof newFences>>;
  let projector: KeycloakProjector;
  let service: IdentityService;
  /** Users this suite made, so its sweeps touch nobody else's fences or lapses. */
  const mine = new Set<string>();
  /** The senders' monotonic clock: a late timeout is a paused sender, said so (#458 r1 F5). */
  const senders = new SenderClock();

  beforeAll(async () => {
    prisma = newPrisma();
    holder = newPrisma();
    await prisma.onModuleInit();
    await holder.onModuleInit();
    repository = new IdentityRepository(prisma);
    holderRepository = new IdentityRepository(holder);
    stub = new KeycloakHttpStub();
    await stub.start();
    keycloak = stub.client(REQUEST_TIMEOUT_MS);
    fencing = await newFences(senders);
    projector = new KeycloakProjector(repository, keycloak, fencing.fences, {
      writeSettleSeconds: SETTLE_SECONDS,
    });
    service = new IdentityService(repository, keycloak, projector);
  });

  afterEach(async () => {
    // A late write's recovery projection runs in the background (D-070 D):
    // done before the next test, so it never takes that test's stub modes.
    await settleRecoveryProjections(30_000);
    stub.onPut = null;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await stub.close();
    await fencing.pool.onModuleDestroy();
    await holder.onModuleDestroy();
    await prisma.onModuleDestroy();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  interface Seeded {
    userId: string;
    keycloakId: string;
    org: { a: string; b: string };
    memberships: string[];
  }

  async function seed(spec: {
    memberships: Array<{ in: 'a' | 'b'; roles: string[]; validUntil?: Date }>;
    account?: 'linked' | 'missing-in-keycloak';
  }): Promise<Seeded> {
    const org = tenants();
    const userId = id('USR-FN');
    mine.add(userId);
    const keycloakId = `kc-${userId.slice(-16).toLowerCase()}`;
    const memberships = spec.memberships.map(() => id('MBR-FN'));
    const validFrom = new Date(Date.now() - 3_600_000);
    await runUnscoped('test fixture spans organizations', async () => {
      await prisma.client.user.create({
        data: {
          id: userId,
          keycloakId,
          username: `fn-${userId.slice(-12)}`.toLowerCase(),
          email: `fn-${userId.slice(-12)}@example.test`.toLowerCase(),
          firstName: 'آزمون',
          lastName: 'حصار',
          status: 'ACTIVE',
          activeOrganizationId: org.a,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      });
      for (const [index, membership] of spec.memberships.entries()) {
        await prisma.client.membership.create({
          data: {
            id: memberships[index]!,
            userId,
            organizationId: org[membership.in],
            roles: membership.roles,
            validFrom: new Date(validFrom.getTime() + index),
            validUntil: membership.validUntil ?? null,
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
        });
      }
    });
    if (spec.account !== 'missing-in-keycloak') {
      stub.add({
        id: keycloakId,
        username: `fn-${userId.slice(-12)}`.toLowerCase(),
        email: `fn-${userId.slice(-12)}@example.test`.toLowerCase(),
        firstName: 'آزمون',
        lastName: 'حصار',
        attributes: {
          ...(await rowsGrant(userId, validFrom.getTime() + 60_000)),
          rasta_activation: ['REG_FIXTURE'],
        },
      });
    }
    return { userId, keycloakId, org, memberships };
  }

  async function rowsGrant(userId: string, at = Date.now()): Promise<PlatformAttributes> {
    const user = await repository.findUserById(userId);
    if (!user) throw new Error(`no user ${userId}`);
    return platformAttributesFor(
      user,
      await repository.listMembershipsForUser(userId),
      new Date(at),
    );
  }

  const asAdmin = <T>(organizationId: string, fn: () => Promise<T>) =>
    asActor({ organizationId, userId: 'USR-FN-ADMIN', roles: ['ORGANIZATION_ADMIN'] }, fn);

  const demoteWith = (on: IdentityService, s: Seeded, roles: string[], membership = 0) =>
    asAdmin(s.org.a, () =>
      on.updateMembershipRoles(s.memberships[membership]!, {
        roles: roles as never,
        reason: 'fence itest',
      }),
    );
  const demote = (s: Seeded, roles: string[], membership = 0) =>
    demoteWith(service, s, roles, membership);

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected a refusal');
      },
      (error: unknown) => error,
    );

  const fencesOf = async (userId: string) =>
    (
      await prisma.client.$queryRaw<
        Array<{
          attempt_id: string;
          operation: string;
          live: boolean;
          account_missing: boolean;
          reassert_failures: number;
          next_in: number;
        }>
      >`
        SELECT attempt_id, operation,
               takeover_at > (clock_timestamp() AT TIME ZONE 'UTC') AS live,
               account_missing_at IS NOT NULL AS account_missing,
               reassert_failures,
               EXTRACT(EPOCH FROM next_reassert_at - (clock_timestamp() AT TIME ZONE 'UTC'))::float AS next_in
          FROM keycloak_write_attempt WHERE user_id = ${userId}
         ORDER BY started_at, attempt_id`
    ).map((row) => ({
      attemptId: row.attempt_id,
      operation: row.operation,
      live: row.live,
      accountMissing: row.account_missing,
      reassertFailures: row.reassert_failures,
      nextIn: row.next_in,
    }));

  const events = (aggregateId: string) =>
    runUnscoped('test reads the outbox', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  const carried = (request: StubRequest) =>
    readPlatformAttributes(request.body?.attributes as Record<string, string[]>);

  /** Until a session of this database waits on a lock. */
  const someoneWaitsOnALock = () =>
    waitFor('a transaction to wait on the user lock', async () => {
      const rows = await holder.client.$queryRawUnsafe<{ waiting: bigint }[]>(
        `SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      return Number(rows[0]?.waiting ?? 0) > 0 ? true : null;
    });

  /**
   * A scanner whose sweeps see only `only` (default: every user this suite
   * made) — its lapses and its fences — so rows other suites left behind
   * never take a pass's budget. The real queries, filtered after; the
   * repository's and the fences' other methods are the real ones.
   */
  function ownScanner(
    batchSize = 50,
    using: {
      service: IdentityService;
      projector: KeycloakProjector;
      fences: KeycloakWriteFences;
      repository?: IdentityRepository;
    } = {
      service,
      projector,
      fences: fencing.fences,
    },
    only: Set<string> = mine,
  ) {
    const base = using.repository ?? repository;
    const scopedRepository = Object.create(base) as IdentityRepository;
    scopedRepository.findLapsedMemberships = async (at, take, after, until) =>
      (await base.findLapsedMemberships(at, 1000, after, until))
        .filter((row) => only.has(row.userId))
        .slice(0, take);
    const scopedFences = Object.create(using.fences) as KeycloakWriteFences;
    scopedFences.dueUsers = async (after, take, until) =>
      (await using.fences.dueUsers(after, 1000, until))
        .filter((userId) => only.has(userId))
        .slice(0, take);
    return new MembershipExpiryScanner(
      scopedRepository,
      using.service,
      { enabled: false, intervalSeconds: 60, batchSize },
      using.projector,
      scopedFences,
    );
  }

  /** Holds the user lock in another session until released. */
  function holdUserLock(userId: string) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const held = new Promise<void>((resolve) => (taken = resolve));
    const done = holderRepository.transaction(
      async (tx) => {
        await holderRepository.lockUserMemberships(tx, userId);
        taken();
        await released;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    return { held, release, done };
  }

  // -------------------------------------------------------------------------
  // F1: the fence is in place before the PUT, and through the lock handoff
  // -------------------------------------------------------------------------

  describe('the fence and the lock handoff (#402 r1 F1, #381 r3 F1)', () => {
    it('is committed before the PUT is sent — visible from another session while the writer still holds the lock — and goes with the commit', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      const seen: Array<{ fences: number; operation?: string }> = [];
      stub.onPut = async () => {
        const rows = await fencesOf(s.userId);
        seen.push({ fences: rows.length, operation: rows[0]?.operation });
      };

      await projector.project(s.userId, 'event');

      expect(seen).toEqual([{ fences: 1, operation: 'replace_attributes' }]);
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('a projection whose PUT outlives its transaction: the narrowing waiting for the lock sees the fence and refuses; the late PUT lands; the sweep re-asserts after takeover; then the narrowing commits', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      const wide = await rowsGrant(s.userId);
      // A client with a deadline long enough to line the demotion up behind it.
      const slow = stub.client(1500);
      const slowProjector = new KeycloakProjector(repository, slow, fencing.fences, {
        writeSettleSeconds: SETTLE_SECONDS,
      });

      // 1. The projection sends the old, wider attributes; Keycloak holds it.
      stub.nextPut('hold');
      const projection = slowProjector.project(s.userId, 'event').then(
        () => 'projected',
        (error: unknown) => error,
      );
      await waitFor('the held PUT', async () => (stub.heldCount === 1 ? true : null));

      // 2. Another administrator's demotion is already waiting for the lock.
      const putsBefore = stub.puts(s.keycloakId).length;
      const demotion = failure(demote(s, ['OPERATOR']));
      await someoneWaitsOnALock();

      // 3. The projection's deadline passes; its transaction rolls back and
      //    the lock passes to the demotion — which reads the fence.
      expect(await projection).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      expect(await demotion).toMatchObject({ status: 503, code: 'KEYCLOAK_WRITE_SETTLING' });
      expect(
        ((await demotion) as { retryAfterSeconds?: number }).retryAfterSeconds,
      ).toBeGreaterThan(0);
      expect(stub.puts(s.keycloakId)).toHaveLength(putsBefore);
      expect(await events(s.memberships[0]!)).toEqual([]);

      // 4. The old PUT lands now, after the refusal: wider than nothing committed.
      stub.releaseHeld();
      expect(stub.platform(s.keycloakId)).toEqual(wide);

      // 5. Once it can no longer land, the sweep re-asserts the rows and clears it.
      await sleep(1500 + SETTLE_SECONDS * 1000 + 300);
      await ownScanner(50, undefined, new Set([s.userId])).scan();
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
      expect(await fencesOf(s.userId)).toEqual([]);

      // 6. And the demotion is the last write now: it commits, and narrows.
      await demote(s, ['OPERATOR']);
      expect(stub.platform(s.keycloakId).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
      expect((await events(s.memberships[0]!)).map((e) => e.eventName)).toEqual(['ROLE_REVOKED']);
    });

    it('a write-ahead whose PUT outlives its transaction: the same — the next narrowing waiting for the lock refuses', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'OPERATOR'] }],
      });
      const slow = stub.client(1500);
      const slowService = new IdentityService(
        repository,
        slow,
        new KeycloakProjector(repository, slow, fencing.fences, {
          writeSettleSeconds: SETTLE_SECONDS,
        }),
      );

      stub.nextPut('hold');
      // Paused while its PUT is at Keycloak: its timeout is heard late (D-070 D).
      pauseSenderAtNextPut(stub, senders, 1500 + PAUSE_MS);
      const first = failure(demoteWith(slowService, s, ['FLEET_MANAGER', 'OPERATOR']));
      await waitFor('the held PUT', async () => (stub.heldCount === 1 ? true : null));
      const second = failure(demote(s, ['OPERATOR']));
      await someoneWaitsOnALock();

      expect(await first).toMatchObject({ status: 503, code: 'KEYCLOAK_UNAVAILABLE' });
      expect(await second).toMatchObject({ status: 503, code: 'KEYCLOAK_WRITE_SETTLING' });
      expect(await events(s.memberships[0]!)).toEqual([]);
      // Its own, and — its timeout heard past its deadline — a fresh one (D-070 D).
      expect(await fencesOf(s.userId)).toEqual([
        expect.objectContaining({ live: true }),
        expect.objectContaining({ live: true }),
      ]);
      stub.releaseHeld();
    });

    it('outlives the process that wrote it: a fresh projector on a fresh pool refuses too', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      stub.nextPut('hang');
      await expect(projector.project(s.userId, 'event')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });

      // Nothing of the first writer survives but the row.
      const fresh = await newFences();
      try {
        const freshService = new IdentityService(
          repository,
          keycloak,
          new KeycloakProjector(repository, keycloak, fresh.fences, {
            writeSettleSeconds: SETTLE_SECONDS,
          }),
        );
        expect(await failure(demoteWith(freshService, s, ['OPERATOR']))).toMatchObject({
          code: 'KEYCLOAK_WRITE_SETTLING',
        });
      } finally {
        await fresh.pool.onModuleDestroy();
      }
    });

    it('is taken over only after deadline + settle; a late release of an old attempt never clears a newer one', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      const scanner = ownScanner(50, undefined, new Set([s.userId]));
      stub.nextPut('hang');
      pauseSenderAtNextPut(stub, senders, PAUSE_MS);
      await expect(projector.project(s.userId, 'event')).rejects.toBeDefined();
      // Its sender paused at Keycloak, its timeout was heard past its
      // deadline: a fresh fence beside it, and a recovery projection of the
      // rows (D-070 D).
      await settleRecoveryProjections(10_000);
      const [old, fresh] = await fencesOf(s.userId);

      // Before takeover: the sweep leaves them, and sends nothing.
      const puts = stub.puts(s.keycloakId).length;
      await scanner.scan();
      expect(stub.puts(s.keycloakId)).toHaveLength(puts);
      expect(await fencesOf(s.userId)).toEqual([
        expect.objectContaining({ attemptId: old!.attemptId, live: true }),
        expect.objectContaining({ attemptId: fresh!.attemptId, live: true }),
      ]);

      // After it: re-asserted, and cleared.
      await sleep(TAKEOVER_MS);
      await scanner.scan();
      expect(await fencesOf(s.userId)).toEqual([]);

      // A newer attempt, in flight — and its own late sender's fresh fence.
      stub.nextPut('hang');
      pauseSenderAtNextPut(stub, senders, PAUSE_MS);
      await expect(projector.project(s.userId, 'event')).rejects.toBeDefined();
      await settleRecoveryProjections(10_000);
      const [newer, newerFresh] = await fencesOf(s.userId);
      expect(newer!.attemptId).not.toBe(old!.attemptId);

      // The old attempt's owner wakes up late and "releases" or "confirms" it:
      // compare-and-delete by attempt id touches only its own row — never the
      // newer attempts, and never a replacement fence.
      await fencing.fences.release(old!.attemptId);
      await fencing.fences.confirmLanded([old!.attemptId, fresh!.attemptId]);
      expect(await fencesOf(s.userId)).toEqual([
        expect.objectContaining({ attemptId: newer!.attemptId, live: true }),
        expect.objectContaining({ attemptId: newerFresh!.attemptId, live: true }),
      ]);
      expect(await failure(demote(s, ['OPERATOR']))).toMatchObject({
        code: 'KEYCLOAK_WRITE_SETTLING',
      });
    });

    it('a write provably not applied releases its fence at once: refused 4xx, and a deadline passed before dispatch', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      stub.nextPut('refuse', 403);
      expect(await failure(demote(s, ['OPERATOR']))).toMatchObject({
        code: 'KEYCLOAK_UNAVAILABLE',
      });
      expect(await fencesOf(s.userId)).toEqual([]);

      // The sender pauses after its fence committed, past its deadline: the
      // check immediately before dispatch refuses to send (D-069 addendum A).
      const real = fencing.fences.open.bind(fencing.fences);
      jest.spyOn(fencing.fences, 'open').mockImplementationOnce(async (tx, input) => {
        const attempt = await real(tx, input);
        await sleep(REQUEST_TIMEOUT_MS + 100);
        return attempt;
      });
      const puts = stub.puts(s.keycloakId).length;
      expect(await failure(demote(s, ['OPERATOR']))).toMatchObject({
        code: 'KEYCLOAK_UNAVAILABLE',
      });
      expect(stub.puts(s.keycloakId)).toHaveLength(puts);
      expect(await fencesOf(s.userId)).toEqual([]);
      // Nothing held back: the retry commits.
      await demote(s, ['OPERATOR']);
      expect(stub.platform(s.keycloakId).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
    });

    it('opens only under a user row it can lock: for a user that does not exist it refuses and inserts nothing', async () => {
      const ghost = id('USR-FN-GHOST');
      await expect(
        repository.transaction((tx) =>
          fencing.fences.open(tx, {
            userId: ghost,
            keycloakId: 'kc-ghost',
            operation: 'replace_attributes',
            timeoutMs: REQUEST_TIMEOUT_MS,
            settleSeconds: SETTLE_SECONDS,
            // Prisma's default transaction timeout.
            transactionTimeoutMs: 5_000,
          }),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await fencesOf(ghost)).toEqual([]);
    });

    it('a projection whose PUT landed but whose transaction failed: its fence is due at once, so it holds no narrowing back', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      jest
        .spyOn(fencing.fences, 'settle')
        .mockRejectedValueOnce(new Error('the commit-time statement failed'));
      await expect(projector.project(s.userId, 'command')).rejects.toThrow(
        'the commit-time statement failed',
      );
      // Landed (confirmed), so it can no longer land: due, not live.
      expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ live: false })]);

      // Nothing held back: the demotion commits now, and its projection takes the fence over.
      await demote(s, ['OPERATOR']);
      expect((await events(s.memberships[0]!)).map((e) => e.eventName)).toEqual(['ROLE_REVOKED']);
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('a mixed change: its write-ahead carried less than it commits, so its fence outlives the commit until a projection of the full state lands', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      // The write-ahead (the intersection) lands; the projection after commit is refused.
      let puts = 0;
      stub.onPut = async () => {
        puts += 1;
        if (puts === 2) stub.refuseFor(s.keycloakId, 403);
      };
      try {
        await demote(s, ['OPERATOR', 'DRIVER']);
        expect(stub.platform(s.keycloakId).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
        expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ live: false })]);
      } finally {
        stub.stopRefusing(s.keycloakId);
        stub.onPut = null;
      }

      // The sweep re-asserts the committed state and takes the fence over.
      await ownScanner(50, undefined, new Set([s.userId])).scan();
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
      expect(stub.platform(s.keycloakId).organization_roles).toEqual(
        expect.arrayContaining([`${s.org.a}:OPERATOR`, `${s.org.a}:DRIVER`]),
      );
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('measures how long the final deadline check precedes the PUT reaching Keycloak (D-069 addendum C)', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      const checkedAt: number[] = [];
      const real = fencing.fences.open.bind(fencing.fences);
      jest.spyOn(fencing.fences, 'open').mockImplementation(async (tx, input) => {
        const attempt = await real(tx, input);
        const wrapped: KeycloakWriteAttempt = {
          id: attempt.id,
          signal: attempt.signal,
          assertDispatchable() {
            attempt.assertDispatchable();
            checkedAt.push(performance.timeOrigin + performance.now());
          },
          observeReply: () => attempt.observeReply(),
        };
        return wrapped;
      });
      const before = stub.puts(s.keycloakId).length;
      const SAMPLES = 200;
      for (let i = 0; i < SAMPLES; i += 1) await projector.project(s.userId, 'event');
      const arrivals = stub
        .puts(s.keycloakId)
        .slice(before)
        .map((put) => put.at);
      expect(arrivals).toHaveLength(SAMPLES);
      const gaps = arrivals.map((at, i) => at - checkedAt[i]!).sort((a, b) => a - b);
      const pick = (q: number) => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]!;
      const measured = {
        samples: SAMPLES,
        p50Ms: pick(0.5),
        p99Ms: pick(0.99),
        maxMs: gaps.at(-1)!,
        settleWindowMs: SETTLE_SECONDS * 1000,
      };
      // eslint-disable-next-line no-console
      console.log(`D-069 dispatch gap (check → arrival): ${JSON.stringify(measured)}`);
      if (process.env.FENCE_GAP_REPORT)
        writeFileSync(process.env.FENCE_GAP_REPORT, JSON.stringify(measured));
      // Loopback and an idle process: a bound for this machine, not a proof.
      expect(measured.maxMs).toBeLessThan(SETTLE_SECONDS * 1000);
    });
  });

  // -------------------------------------------------------------------------
  // The lock graph (addendum B)
  // -------------------------------------------------------------------------

  describe('the fence transaction never waits on the business transaction (addendum B)', () => {
    it('opens while the business transaction holds the user lock and the only connection of its pool', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      const single = new PrismaService(withDatabasePool(databaseUrl(), { size: 1 }));
      await single.onModuleInit();
      try {
        const business = new IdentityRepository(single);
        const opened = await business.transaction(
          async (tx) => {
            await business.lockUserMemberships(tx, s.userId);
            const started = performance.now();
            const attempt = await fencing.fences.open(tx, {
              userId: s.userId,
              keycloakId: s.keycloakId,
              operation: 'replace_attributes',
              timeoutMs: REQUEST_TIMEOUT_MS,
              settleSeconds: SETTLE_SECONDS,
              transactionTimeoutMs: 20_000,
            });
            return { attempt, ms: performance.now() - started };
          },
          { timeout: 20_000, maxWait: 5_000 },
        );
        expect(opened.ms).toBeLessThan(1000);
        expect(await fencesOf(s.userId)).toEqual([
          expect.objectContaining({ attemptId: opened.attempt.id, live: true }),
        ]);
        await fencing.fences.release(opened.attempt.id);

        // Control: the same insert on the business pool would wait for the
        // connection its own transaction holds, and fail by the pool's wait.
        const sameUrl = new URL(withDatabasePool(databaseUrl(), { size: 1 }));
        sameUrl.searchParams.set('pool_timeout', '2');
        const shared = new PrismaService(sameUrl.toString());
        await shared.onModuleInit();
        try {
          const onSamePool = new KeycloakWriteFences(shared);
          const sharedRepository = new IdentityRepository(shared);
          const started = performance.now();
          await expect(
            sharedRepository.transaction(
              async (tx) => {
                await sharedRepository.lockUserMemberships(tx, s.userId);
                await onSamePool.open(tx, {
                  userId: s.userId,
                  keycloakId: s.keycloakId,
                  operation: 'replace_attributes',
                  timeoutMs: REQUEST_TIMEOUT_MS,
                  settleSeconds: SETTLE_SECONDS,
                  transactionTimeoutMs: 20_000,
                });
              },
              { timeout: 20_000, maxWait: 5_000 },
            ),
          ).rejects.toThrow();
          expect(performance.now() - started).toBeGreaterThan(1500);
        } finally {
          await shared.onModuleDestroy();
        }
      } finally {
        await single.onModuleDestroy();
      }
    });

    it('takes no lock on the user row: it succeeds while another session holds that row FOR UPDATE', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      const lock = holdUserLock(s.userId);
      await lock.held;
      try {
        // As the fence pool runs it: its own short transaction, bounded.
        const started = performance.now();
        await fencing.pool.transaction(
          (fence) => fence.$executeRaw`
            INSERT INTO keycloak_write_attempt
                   (attempt_id, user_id, keycloak_id, operation,
                    started_at, deadline_at, takeover_at, next_reassert_at)
            VALUES (${`KWA_${ulid()}`}, ${s.userId}, ${s.keycloakId}, 'replace_attributes',
                    now(), now(), now(), now())`,
          { maxWait: 5_000, timeout: 5_000, statementTimeoutMs: 5_000 },
        );
        expect(performance.now() - started).toBeLessThan(1000);
      } finally {
        lock.release();
        await lock.done;
        await prisma.client
          .$executeRaw`DELETE FROM keycloak_write_attempt WHERE user_id = ${s.userId}`;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Creation (addendum D)
  // -------------------------------------------------------------------------

  describe('an account is created disabled and granting nothing (addendum D)', () => {
    const operator = <T>(organizationId: string, fn: () => Promise<T>) =>
      asActor({ organizationId, userId: 'USR-FN-OPERATOR', roles: ['SYSTEM_ADMIN'] }, fn);

    it('operator provisioning: created harmless before its transaction, then granted and enabled through the fenced path after commit', async () => {
      const org = tenants();
      const username = `fn-op-${ulid().slice(-10)}`.toLowerCase();
      const fencedAt: string[] = [];
      stub.onPut = async (put) => {
        const user = await runUnscoped('test reads what committed', () =>
          prisma.client.user.findFirst({ where: { username } }),
        );
        fencedAt.push(
          `${put.body && 'enabled' in put.body ? 'enable' : 'attributes'}:committed=${user !== null}:fences=${
            user ? (await fencesOf(user.id)).length : 0
          }`,
        );
      };

      const created = await operator(org.a, () =>
        service.createUser({
          username,
          email: `${username}@example.test`,
          firstName: 'آزمون',
          lastName: 'اپراتور',
          organizationId: org.a,
          roles: ['OPERATOR'],
        } as never),
      );
      mine.add(created.id);

      const [create] = stub.requests.filter(
        (r) => r.method === 'POST' && r.body?.username === username,
      );
      expect(create!.body).toMatchObject({
        enabled: false,
        attributes: provenanceOnly(created.id),
      });
      // The grants, then the enable — each fenced, each after the row committed.
      // The grants' fence is still there at the enable: both go with the commit.
      expect(fencedAt).toEqual([
        'attributes:committed=true:fences=1',
        'enable:committed=true:fences=2',
      ]);
      const account = [...stub.accounts.values()].find((a) => a.username === username)!;
      expect(account.enabled).toBe(true);
      expect(account.attributes.rasta_activation).toEqual([created.id]);
      expect(readPlatformAttributes(account.attributes)).toEqual(await rowsGrant(created.id));
      expect(await fencesOf(created.id)).toEqual([]);
    });

    it('operator provisioning whose transaction fails: the account stays disabled and grants nothing', async () => {
      const org = tenants();
      const username = `fn-op-${ulid().slice(-10)}`.toLowerCase();
      jest
        .spyOn(repository, 'enqueueEvent')
        .mockRejectedValueOnce(new Error('the database went away'));

      await expect(
        operator(org.a, () =>
          service.createUser({
            username,
            email: `${username}@example.test`,
            firstName: 'آزمون',
            lastName: 'اپراتور',
            organizationId: org.a,
            roles: ['ORGANIZATION_ADMIN'],
          } as never),
        ),
      ).rejects.toThrow(/went away/);
      const account = [...stub.accounts.values()].find((a) => a.username === username)!;
      expect(account.enabled).toBe(false);
      expect(readPlatformAttributes(account.attributes)).toMatchObject({
        organization_ids: [],
        organization_roles: [],
        active_organization_id: [],
      });
      expect(stub.puts(account.id)).toEqual([]);
    });

    it('an adoption whose disable outlives its approval: the next approval commits, but the enable waits until that disable can no longer land — then the sweep activates', async () => {
      const org = tenants();
      const username = `fn-reg-${ulid().slice(-10)}`.toLowerCase();
      const { registrationId } = await service.submitRegistration({
        username,
        email: `${username}@example.test`,
        firstName: 'متقاضی',
        lastName: 'آزمون',
        requestedOrganizationId: org.a,
        requestedRoles: ['FLEET_MANAGER'],
        documentRefs: [],
      } as never);
      const request = await runUnscoped('the suite reads the request it filed', () =>
        prisma.client.registrationRequest.findUniqueOrThrow({ where: { id: registrationId } }),
      );
      const userId = request.userId;
      mine.add(userId);
      // What an earlier version's failed compensation left: enabled and granting.
      const legacy = `kc-legacy-${ulid().slice(-10).toLowerCase()}`;
      stub.add({
        id: legacy,
        username,
        email: `${username}@example.test`,
        firstName: 'متقاضی',
        lastName: 'آزمون',
        enabled: true,
        attributes: {
          rasta_user_id: [userId],
          organization_ids: [org.a],
          organization_roles: [`${org.a}:ORGANIZATION_ADMIN`],
          active_organization_id: [org.a],
        },
      });
      const reviewer = <T>(fn: () => Promise<T>) =>
        asActor({ organizationId: org.a, roles: ['SYSTEM_ADMIN'] }, fn);

      // 1. The first approval's adoption: its disable reaches Keycloak and is held.
      stub.nextPut('hold');
      pauseSenderAtNextPut(stub, senders, PAUSE_MS);
      await expect(
        reviewer(() => service.approveRegistration(registrationId, {})),
      ).rejects.toBeDefined();
      // Its own fence, and — its sender paused at Keycloak, its timeout heard
      // past its deadline — a fresh one for the same account and operation
      // (D-070 D).
      await settleRecoveryProjections(10_000);
      expect(await fencesOf(userId)).toEqual([
        expect.objectContaining({ live: true, operation: 'disable' }),
        expect.objectContaining({ live: true, operation: 'disable' }),
      ]);

      // 2. The second approval adopts again (still enabled), commits, and projects:
      //    the grants are written, the enable waits for the held disable.
      await reviewer(() => service.approveRegistration(registrationId, {}));
      const account = stub.accounts.get(legacy)!;
      expect(account.enabled).toBe(false);
      expect(account.attributes.rasta_activation).toBeUndefined();
      expect(readPlatformAttributes(account.attributes)).toEqual(await rowsGrant(userId));

      // 3. The first disable lands late. Nothing it can undo was done.
      stub.releaseHeld();
      expect(stub.accounts.get(legacy)!.enabled).toBe(false);

      // 4. Once it can no longer land, the sweep re-asserts and activates.
      await sleep(TAKEOVER_MS);
      await ownScanner(50, undefined, new Set([userId])).scan();
      expect(stub.accounts.get(legacy)!.enabled).toBe(true);
      expect(stub.accounts.get(legacy)!.attributes.rasta_activation).toEqual([registrationId]);
      expect(await fencesOf(userId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // F3: the clock of every validity decision
  // -------------------------------------------------------------------------

  describe('every validity decision is on the database clock read after the lock (#402 r1 F3)', () => {
    it('a delayed expiry pass: the write-ahead does not grant a membership that lapsed after the scan began', async () => {
      const s = await seed({
        memberships: [
          // M1, in b: lapsed before the scan.
          { in: 'b', roles: ['FLEET_MANAGER'], validUntil: new Date(Date.now() - 60_000) },
          // M2, in a: lapses after the scan began, before the delayed pass writes.
          { in: 'a', roles: ['ORGANIZATION_ADMIN'], validUntil: new Date(Date.now() + 800) },
        ],
      });
      const scanBegan = new Date();
      const m1 = await runUnscoped('the suite reads its own fixture', () =>
        prisma.client.membership.findUniqueOrThrow({ where: { id: s.memberships[0]! } }),
      );
      await sleep(1200);

      await service.expireLapsedMembership(m1, scanBegan);

      const [ahead] = stub.puts(s.keycloakId);
      // Judged at scanBegan, M2 would be in it: `a:ORGANIZATION_ADMIN` restored
      // after M2's own expiry — the r1 F3 counterexample.
      expect(carried(ahead!).organization_roles).not.toContain(`${s.org.a}:ORGANIZATION_ADMIN`);
      expect(carried(ahead!)).toMatchObject({ organization_ids: [], organization_roles: [] });
      expect(isWithin(carried(ahead!), await rowsGrant(s.userId))).toBe(true);
    });

    it('a switch that waits on the lock past the membership’s validUntil is refused', async () => {
      const s = await seed({
        memberships: [
          { in: 'a', roles: ['OPERATOR'] },
          { in: 'b', roles: ['DRIVER'], validUntil: new Date(Date.now() + 700) },
        ],
      });
      const lock = holdUserLock(s.userId);
      await lock.held;
      const switching = failure(
        asActor({ organizationId: s.org.a, userId: s.userId, roles: ['OPERATOR'] }, () =>
          service.switchActiveOrganization({ organizationId: s.org.b }),
        ),
      );
      await someoneWaitsOnALock();
      await sleep(1100);
      lock.release();
      await lock.done;
      // `now()` — the transaction's start, before validUntil — would have accepted it.
      expect(await switching).toMatchObject({ status: 403, code: 'TENANT_MISMATCH' });
    });
  });

  // -------------------------------------------------------------------------
  // F2: fair progress, durably
  // -------------------------------------------------------------------------

  describe('fair progress across passes, in the database (#402 r1 F2)', () => {
    it('a failing lapse is deferred in its row: a restarted scanner and another replica wait too, and reach the healthy lapse behind it', async () => {
      const lapsedAt = new Date(Date.now() - 5_000);
      const stuck = await seed({
        memberships: [{ in: 'a', roles: ['OPERATOR'], validUntil: lapsedAt }],
      });
      const healthy = await seed({
        memberships: [{ in: 'a', roles: ['DRIVER'], validUntil: new Date(lapsedAt.getTime() + 1) }],
      });
      stub.refuseFor(stuck.keycloakId, 403);
      const these = new Set([stuck.userId, healthy.userId]);
      try {
        await ownScanner(1, undefined, these).scan();
        const row = await runUnscoped('the suite reads its own fixture', () =>
          prisma.client.membership.findUniqueOrThrow({ where: { id: stuck.memberships[0]! } }),
        );
        expect(row).toMatchObject({ lapseHandledAt: null, lapseFailures: 1 });
        expect(row.lapseRetryAt!.getTime()).toBeGreaterThan(Date.now() + 60_000);

        // A new scanner — a restart, or a second replica: no cursor, same rows.
        await ownScanner(1, undefined, these).scan();
        expect(
          (
            await runUnscoped('the suite reads its own fixture', () =>
              prisma.client.membership.findUniqueOrThrow({
                where: { id: healthy.memberships[0]! },
              }),
            )
          ).lapseHandledAt,
        ).not.toBeNull();
        expect(
          (
            await runUnscoped('the suite reads its own fixture', () =>
              prisma.client.membership.findUniqueOrThrow({ where: { id: stuck.memberships[0]! } }),
            )
          ).lapseFailures,
        ).toBe(1);
      } finally {
        stub.stopRefusing(stuck.keycloakId);
      }
    });

    it('a re-assertion that keeps failing is deferred in its fences, and the healthy user behind it is re-asserted', async () => {
      // Two users with an expired in-flight write each: the first one's account refuses.
      const failing = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      const ok = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      for (const s of [failing, ok]) {
        await prisma.client.$executeRaw`
          INSERT INTO keycloak_write_attempt
                 (attempt_id, user_id, keycloak_id, operation,
                  started_at, deadline_at, takeover_at, next_reassert_at)
          VALUES (${`KWA_${ulid()}`}, ${s.userId}, ${s.keycloakId}, 'replace_attributes',
                  now() - interval '10 minutes', now() - interval '10 minutes',
                  now() - interval '8 minutes', now() - interval '8 minutes')`;
      }
      stub.refuseFor(failing.keycloakId, 403);
      try {
        const scanner = ownScanner(1, undefined, new Set([failing.userId, ok.userId]));
        await scanner.scan();
        await scanner.scan();
        expect(await fencesOf(ok.userId)).toEqual([]);
        const [deferred] = await fencesOf(failing.userId);
        expect(deferred).toMatchObject({ reassertFailures: 1, accountMissing: false });
        expect(deferred!.nextIn).toBeGreaterThan(60);
      } finally {
        stub.stopRefusing(failing.keycloakId);
      }
    });

    it('a Keycloak 404 on re-assertion is terminal: recorded, counted, never retried — and holds no narrowing back', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
        account: 'missing-in-keycloak',
      });
      await prisma.client.$executeRaw`
        INSERT INTO keycloak_write_attempt
               (attempt_id, user_id, keycloak_id, operation,
                started_at, deadline_at, takeover_at, next_reassert_at)
        VALUES (${`KWA_${ulid()}`}, ${s.userId}, ${s.keycloakId}, 'replace_attributes',
                now() - interval '10 minutes', now() - interval '10 minutes',
                now() - interval '8 minutes', now() - interval '8 minutes')`;
      const scanner = ownScanner(50, undefined, new Set([s.userId]));
      const project = jest.spyOn(projector, 'project');

      await scanner.scan();
      expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ accountMissing: true })]);
      expect((await fencing.fences.counts()).accountMissing).toBeGreaterThanOrEqual(1);

      await scanner.scan();
      expect(project.mock.calls.filter(([userId]) => userId === s.userId)).toHaveLength(1);

      // Nothing can mint a token for a missing account: the demotion proceeds.
      await demote(s, ['OPERATOR']);
      expect((await events(s.memberships[0]!)).map((e) => e.eventName)).toEqual(['ROLE_REVOKED']);
      // Still terminal: the projection after that commit found no account either.
      expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ accountMissing: true })]);

      // The operator restores the account (runbook): the next projection that
      // lands — the backfill's — takes the terminal fence over with its commit.
      stub.add({
        id: s.keycloakId,
        username: `fn-${s.userId.slice(-12)}`.toLowerCase(),
        email: `fn-${s.userId.slice(-12)}@example.test`.toLowerCase(),
        firstName: 'آزمون',
        lastName: 'حصار',
        attributes: { ...(await rowsGrant(s.userId)), rasta_activation: ['REG_FIXTURE'] },
      });
      await expect(projector.project(s.userId, 'command')).resolves.toBe('projected');
      expect(await fencesOf(s.userId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // F4: nothing after the stop
  // -------------------------------------------------------------------------

  describe('the stop (#402 r1 F4)', () => {
    it('a lapse that resumes after the stop gave up on it sends nothing, fences nothing, enqueues nothing', async () => {
      const s = await seed({
        memberships: [
          { in: 'a', roles: ['OPERATOR'] },
          { in: 'b', roles: ['DRIVER'], validUntil: new Date(Date.now() - 1000) },
        ],
      });
      const own = await newFences();
      try {
        const ownProjector = new KeycloakProjector(repository, keycloak, own.fences, {
          writeSettleSeconds: SETTLE_SECONDS,
        });
        const ownService = new IdentityService(repository, keycloak, ownProjector);
        const scanner = ownScanner(
          50,
          { service: ownService, projector: ownProjector, fences: own.fences },
          new Set([s.userId]),
        );
        const open = jest.spyOn(own.fences, 'open');
        const enqueue = jest.spyOn(repository, 'enqueueEvent');
        const defer = jest.spyOn(repository, 'deferLapse');
        const count = jest.spyOn(repository, 'countLapsedMemberships');

        // The lapse waits on the user lock another session holds.
        const lock = holdUserLock(s.userId);
        await lock.held;
        const pass = scanner.scan();
        await someoneWaitsOnALock();

        const startedStop = Date.now();
        await scanner.stop({ deadlineAt: Date.now() + 200 });
        expect(Date.now() - startedStop).toBeLessThan(1500);
        const putsAtStop = stub.puts(s.keycloakId).length;

        // The work resumes, after shutdown returned.
        lock.release();
        await lock.done;
        await pass;
        await sleep(300);

        expect(stub.puts(s.keycloakId)).toHaveLength(putsAtStop);
        expect(open).not.toHaveBeenCalled();
        expect(enqueue).not.toHaveBeenCalled();
        expect(defer).not.toHaveBeenCalled();
        expect(count).not.toHaveBeenCalled();
        expect(await fencesOf(s.userId)).toEqual([]);
        expect(await events(s.memberships[1]!)).toEqual([]);
        expect(
          (
            await runUnscoped('the suite reads its own fixture', () =>
              prisma.client.membership.findUniqueOrThrow({ where: { id: s.memberships[1]! } }),
            )
          ).lapseHandledAt,
        ).toBeNull();
      } finally {
        await own.pool.onModuleDestroy();
      }
    });

    it('a stop mid-write is safe: the PUT is cancelled, its fence stays, and the next process’s sweep re-asserts', async () => {
      const s = await seed({
        memberships: [
          { in: 'a', roles: ['OPERATOR'] },
          { in: 'b', roles: ['DRIVER'], validUntil: new Date(Date.now() - 1000) },
        ],
      });
      const slow = stub.client(10_000);
      const slowProjector = new KeycloakProjector(repository, slow, fencing.fences, {
        writeSettleSeconds: SETTLE_SECONDS,
      });
      const slowService = new IdentityService(repository, slow, slowProjector);
      const scanner = ownScanner(
        50,
        { service: slowService, projector: slowProjector, fences: fencing.fences },
        new Set([s.userId]),
      );
      stub.nextPut('hold');
      const pass = scanner.scan();
      await waitFor('the held PUT', async () => (stub.heldCount === 1 ? true : null));

      await scanner.stop({ deadlineAt: Date.now() + 2000 });
      await pass;
      // Cut off mid-flight: unknown, so its fence stays (live until its takeover).
      expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ live: true })]);
      expect(await events(s.memberships[1]!)).toEqual([]);
      stub.releaseHeld();
    });
  });

  // -------------------------------------------------------------------------
  // #402 r2 F1: the business transaction ends while its fence is inserted
  // -------------------------------------------------------------------------

  describe('the fence insert and the end of its transaction (#402 r2 F1)', () => {
    /**
     * Holds the next fence insert of the fence pool — before it starts
     * (`before`: as if waiting for a fence connection) or after it committed
     * (`after`) — until released.
     */
    function holdNextInsert(when: 'before' | 'after') {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const atInsert = new Promise<void>((resolve) => (reached = resolve));
      const real = fencing.pool.transaction.bind(fencing.pool);
      jest.spyOn(fencing.pool, 'transaction').mockImplementationOnce((async (
        fn: never,
        options?: never,
      ) => {
        if (when === 'before') {
          reached();
          await released;
          return real(fn, options);
        }
        const result = await real(fn, options);
        reached();
        await released;
        return result;
      }) as never);
      return { atInsert, release };
    }

    /**
     * The next fence opened ends its business transaction on the database
     * side while it waits — the session is closed after 300 ms idle in
     * transaction, which releases the user lock as an expiry or a rollback
     * would.
     */
    function expireTransactionOfNextFence() {
      const real = fencing.fences.open.bind(fencing.fences);
      jest.spyOn(fencing.fences, 'open').mockImplementationOnce(async (tx, input) => {
        await tx.$executeRawUnsafe(`SET LOCAL idle_in_transaction_session_timeout = '300ms'`);
        return real(tx, input);
      });
    }

    const lockLost = async () =>
      (await keycloakWriteFenceEventsTotal.get()).values.find((v) => v.labels.event === 'lock_lost')
        ?.value ?? 0;

    it('a projection: its transaction ends while the fence insert waits, a narrowing commits in between — the old PUT is never sent', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      const lostBefore = await lockLost();
      const insert = holdNextInsert('before');
      expireTransactionOfNextFence();

      // 1. The projection holds the lock, read the wide rows, and waits on its insert.
      const projection = projector.project(s.userId, 'event').then(
        () => 'projected',
        (error: unknown) => error,
      );
      await insert.atInsert;

      // 2. Its transaction ends; the demotion waiting for the lock sees no
      //    fence (none committed yet), writes, and commits.
      await demote(s, ['OPERATOR']);
      expect(stub.platform(s.keycloakId).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
      expect((await events(s.memberships[0]!)).map((e) => e.eventName)).toEqual(['ROLE_REVOKED']);
      const putsAfterNarrowing = stub.puts(s.keycloakId).length;

      // 3. The old insert commits now. The re-check in its transaction fails:
      //    nothing is sent, and its fence goes at once.
      insert.release();
      expect(await projection).toBeInstanceOf(Error);
      expect(stub.puts(s.keycloakId)).toHaveLength(putsAfterNarrowing);
      expect(stub.platform(s.keycloakId).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
      expect(await fencesOf(s.userId)).toEqual([]);
      expect(await lockLost()).toBe(lostBefore + 1);
    });

    it('a write-ahead: the same — the later narrowing commits, the earlier one sends nothing and is refused', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'OPERATOR'] }],
      });
      const insert = holdNextInsert('before');
      expireTransactionOfNextFence();

      // The earlier demotion would write FLEET_MANAGER + OPERATOR.
      const first = failure(demote(s, ['FLEET_MANAGER', 'OPERATOR']));
      await insert.atInsert;
      await demote(s, ['OPERATOR']);
      const putsAfterNarrowing = stub.puts(s.keycloakId).length;

      insert.release();
      expect(await first).toMatchObject({ status: 503, code: 'KEYCLOAK_UNAVAILABLE' });
      expect(stub.puts(s.keycloakId)).toHaveLength(putsAfterNarrowing);
      expect(stub.platform(s.keycloakId).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
      expect((await events(s.memberships[0]!)).map((e) => e.eventName)).toEqual(['ROLE_REVOKED']);
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('the other order: the insert commits, then the transaction ends before the re-check — the narrowing reads the fence and refuses; nothing is sent; the retry commits', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      const insert = holdNextInsert('after');
      expireTransactionOfNextFence();
      const putsBefore = stub.puts(s.keycloakId).length;

      const projection = projector.project(s.userId, 'event').then(
        () => 'projected',
        (error: unknown) => error,
      );
      await insert.atInsert;
      // The fence committed; the projection's transaction ends meanwhile.
      expect(await failure(demote(s, ['OPERATOR']))).toMatchObject({
        status: 503,
        code: 'KEYCLOAK_WRITE_SETTLING',
      });

      insert.release();
      expect(await projection).toBeInstanceOf(Error);
      expect(stub.puts(s.keycloakId)).toHaveLength(putsBefore);
      expect(await fencesOf(s.userId)).toEqual([]);

      await demote(s, ['OPERATOR']);
      expect(stub.platform(s.keycloakId).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
    });

    it('Prisma’s own transaction timeout: an insert that commits after it is refused in the re-check, and released', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      const insert = holdNextInsert('before');
      let outcome: unknown = null;
      const done = repository
        .transaction(
          async (tx) => {
            await repository.lockUserMemberships(tx, s.userId);
            try {
              await fencing.fences.open(tx, {
                userId: s.userId,
                keycloakId: s.keycloakId,
                operation: 'replace_attributes',
                timeoutMs: REQUEST_TIMEOUT_MS,
                settleSeconds: SETTLE_SECONDS,
                // Wrong on purpose: the re-check does not trust the budget.
                transactionTimeoutMs: 60_000,
              });
              outcome = 'returned';
            } catch (error) {
              outcome = error;
            }
          },
          { timeout: 400, maxWait: 5_000 },
        )
        .catch(() => undefined);
      await insert.atInsert;
      await sleep(700);
      insert.release();
      await done;
      await waitFor('the open to end', async () => (outcome === null ? null : true));
      expect(outcome).toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
        internalContext: expect.objectContaining({ reason: 'transaction_ended_before_dispatch' }),
      });
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('a transaction still open but past its budget at the re-check (the database clock says so) sends nothing', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      const insert = holdNextInsert('before');
      let outcome: unknown = null;
      const done = repository.transaction(
        async (tx) => {
          await repository.lockUserMemberships(tx, s.userId);
          try {
            await fencing.fences.open(tx, {
              userId: s.userId,
              keycloakId: s.keycloakId,
              operation: 'replace_attributes',
              timeoutMs: REQUEST_TIMEOUT_MS,
              settleSeconds: SETTLE_SECONDS,
              // The budget its caller gave it; Prisma's own timeout is longer.
              transactionTimeoutMs: 500,
            });
            outcome = 'returned';
          } catch (error) {
            outcome = error;
          }
        },
        { timeout: 10_000, maxWait: 5_000 },
      );
      await insert.atInsert;
      await sleep(700);
      insert.release();
      await done;
      expect(outcome).toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
        internalContext: expect.objectContaining({ reason: 'transaction_ended_before_dispatch' }),
      });
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('the insert is bounded by what is left of the business transaction: one that cannot commit in time is cancelled, inserts nothing and sends nothing', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      // Another session blocks every insert into the fence table (reads still pass).
      let unblock!: () => void;
      const unblocked = new Promise<void>((resolve) => (unblock = resolve));
      let blocked!: () => void;
      const isBlocked = new Promise<void>((resolve) => (blocked = resolve));
      const blocker = holderRepository.transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('LOCK TABLE keycloak_write_attempt IN SHARE MODE');
          blocked();
          await unblocked;
        },
        { timeout: 30_000, maxWait: 5_000 },
      );
      await isBlocked;
      try {
        const started = performance.now();
        await expect(
          repository.transaction(
            async (tx) => {
              await repository.lockUserMemberships(tx, s.userId);
              return fencing.fences.open(tx, {
                userId: s.userId,
                keycloakId: s.keycloakId,
                operation: 'replace_attributes',
                timeoutMs: REQUEST_TIMEOUT_MS,
                settleSeconds: SETTLE_SECONDS,
                transactionTimeoutMs: 1_500,
              });
            },
            { timeout: 10_000, maxWait: 5_000 },
          ),
        ).rejects.toBeDefined();
        const ms = performance.now() - started;
        expect(ms).toBeGreaterThan(1_000);
        expect(ms).toBeLessThan(4_000);
      } finally {
        unblock();
        await blocker;
      }
      expect(await fencesOf(s.userId)).toEqual([]);
      expect(stub.puts(s.keycloakId)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // #402 r2 F2: one cancellation boundary for every database operation
  // -------------------------------------------------------------------------

  describe('the stop reaches every database operation (#402 r2 F2)', () => {
    /**
     * The scanner's whole stack on its own two pools, each recording every
     * operation that passed the cancellation boundary (the recorder is the
     * client's last extension, so it sees only what the boundary let start).
     */
    async function recordedStack() {
      const log: Array<{ at: number; operation: string }> = [];
      const record = (service: PrismaService) => {
        const client = service.client.$extends({
          query: {
            $allOperations({ operation, args, query }) {
              log.push({ at: performance.now(), operation });
              return query(args);
            },
          },
        });
        Object.defineProperty(service, 'client', { value: client });
      };
      const business = newPrisma();
      await business.onModuleInit();
      record(business);
      const pool = new PrismaService(databaseUrl(), { connections: FENCE_POOL_CONNECTIONS });
      await pool.onModuleInit();
      record(pool);
      const ownRepository = new IdentityRepository(business);
      const ownFences = new KeycloakWriteFences(pool);
      const ownProjector = new KeycloakProjector(ownRepository, keycloak, ownFences, {
        writeSettleSeconds: SETTLE_SECONDS,
      });
      const ownService = new IdentityService(ownRepository, keycloak, ownProjector);
      return {
        log,
        pools: { business, fence: pool },
        repository: ownRepository,
        fences: ownFences,
        projector: ownProjector,
        service: ownService,
        scanner: (only: Set<string>) =>
          ownScanner(
            50,
            {
              service: ownService,
              projector: ownProjector,
              fences: ownFences,
              repository: ownRepository,
            },
            only,
          ),
        close: async () => {
          await pool.onModuleDestroy();
          await business.onModuleDestroy();
        },
      };
    }

    async function dueFence(userId: string, keycloakId: string) {
      await prisma.client.$executeRaw`
        INSERT INTO keycloak_write_attempt
               (attempt_id, user_id, keycloak_id, operation,
                started_at, deadline_at, takeover_at, next_reassert_at)
        VALUES (${`KWA_${ulid()}`}, ${userId}, ${keycloakId}, 'replace_attributes',
                now() - interval '10 minutes', now() - interval '10 minutes',
                now() - interval '8 minutes', now() - interval '8 minutes')`;
    }

    /** Pauses the next call of `method` — after (`after`) or before (`before`) its query — until released. */
    function pauseNext<T extends object>(
      target: T,
      method: keyof T & string,
      when: 'before' | 'after',
    ) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => (reached = resolve));
      const real = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target);
      jest.spyOn(target, method as never).mockImplementationOnce((async (...args: unknown[]) => {
        if (when === 'before') {
          reached();
          await released;
          return real(...args);
        }
        const result = await real(...args);
        reached();
        await released;
        return result;
      }) as never);
      return { paused, release };
    }

    /** Runs a pass, pauses it where `pause` says, stops the scanner, then lets it resume. */
    async function stopWhilePaused(
      stack: Awaited<ReturnType<typeof recordedStack>>,
      only: Set<string>,
      pause: { paused: Promise<void>; release: () => void },
    ) {
      const scanner = stack.scanner(only);
      const pass = scanner.scan();
      await pause.paused;
      await scanner.stop({ deadlineAt: Date.now() + 100 });
      const stoppedAt = performance.now();
      pause.release();
      await pass;
      await sleep(300);
      return stack.log.filter((entry) => entry.at >= stoppedAt).map((entry) => entry.operation);
    }

    it('a re-assertion paused in databaseNow: the query completes after the stop returned, and nothing after it starts — no user read, no fence read, no PUT', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      await dueFence(s.userId, s.keycloakId);
      const stack = await recordedStack();
      try {
        const putsBefore = stub.puts(s.keycloakId).length;
        const after = await stopWhilePaused(
          stack,
          new Set([s.userId]),
          pauseNext(stack.repository, 'databaseNow', 'after'),
        );
        expect(after).toEqual([]);
        expect(stub.puts(s.keycloakId)).toHaveLength(putsBefore);
        expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ live: false })]);
      } finally {
        await stack.close();
      }
    });

    it('a re-assertion paused at its fence read: nothing after it starts — no membership read, no fence insert, no settle', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      await dueFence(s.userId, s.keycloakId);
      const stack = await recordedStack();
      try {
        const putsBefore = stub.puts(s.keycloakId).length;
        const after = await stopWhilePaused(
          stack,
          new Set([s.userId]),
          pauseNext(stack.fences, 'ofUser', 'after'),
        );
        expect(after).toEqual([]);
        expect(stub.puts(s.keycloakId)).toHaveLength(putsBefore);
        expect(await fencesOf(s.userId)).toHaveLength(1);
      } finally {
        await stack.close();
      }
    });

    it('a lapse paused before its write-ahead reads the user: the read never starts, nothing is claimed, sent or enqueued', async () => {
      const s = await seed({
        memberships: [
          { in: 'a', roles: ['OPERATOR'] },
          { in: 'b', roles: ['DRIVER'], validUntil: new Date(Date.now() - 1000) },
        ],
      });
      const stack = await recordedStack();
      try {
        const putsBefore = stub.puts(s.keycloakId).length;
        const after = await stopWhilePaused(
          stack,
          new Set([s.userId]),
          pauseNext(stack.repository, 'findUserById', 'before'),
        );
        expect(after).toEqual([]);
        expect(stub.puts(s.keycloakId)).toHaveLength(putsBefore);
        expect(await events(s.memberships[1]!)).toEqual([]);
        expect(
          (
            await runUnscoped('the suite reads its own fixture', () =>
              prisma.client.membership.findUniqueOrThrow({ where: { id: s.memberships[1]! } }),
            )
          ).lapseHandledAt,
        ).toBeNull();
      } finally {
        await stack.close();
      }
    });

    it('control: the same stack without a stop runs the pass through, on both pools', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      await dueFence(s.userId, s.keycloakId);
      const stack = await recordedStack();
      try {
        await stack.scanner(new Set([s.userId])).scan();
        expect(stack.log.length).toBeGreaterThan(5);
        expect(await fencesOf(s.userId)).toEqual([]);
      } finally {
        await stack.close();
      }
    });

    // -----------------------------------------------------------------------
    // #402 r3 R3-1: … and the COMMIT. Prisma sends it when the callback
    // resolves, past the client extension, so the recorder above cannot see
    // it; the database can. Each case holds the reply of a transaction's LAST
    // statement until the stop returned, then lets the work resume, and asks
    // PostgreSQL how that transaction ended (`txid_status`).
    // -----------------------------------------------------------------------

    /** How the transaction `xid` ended, by PostgreSQL's own record of it. */
    const ended = async (xid: string) =>
      (
        await prisma.client.$queryRaw<Array<{ status: string }>>`
          SELECT txid_status(${xid}::bigint) AS status`
      )[0]?.status;

    const xidOf = async (tx: unknown) =>
      (
        await (tx as PrismaService['client']).$queryRaw<Array<{ xid: string }>>`
          SELECT txid_current()::text AS xid`
      )[0]!.xid;

    /**
     * Pauses the next call of `method`, whose first argument is the business
     * transaction, after its statement completed — the reply held — and
     * records that transaction's id first.
     */
    function holdLastStatement<T extends object>(target: T, method: keyof T & string) {
      const held = { xid: '' };
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => (reached = resolve));
      const real = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target);
      jest.spyOn(target, method as never).mockImplementationOnce((async (...args: unknown[]) => {
        held.xid = await xidOf(args[0]);
        const result = await real(...args);
        reached();
        await released;
        return result;
      }) as never);
      return { held, paused, release };
    }

    /** The same, for the next transaction `service` opens: its callback's last statement held. */
    function holdTransaction(service: PrismaService) {
      const held = { xid: '' };
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => (reached = resolve));
      const real = service.transaction.bind(service);
      jest.spyOn(service, 'transaction').mockImplementationOnce(((
        fn: (tx: PrismaService['client']) => Promise<unknown>,
        options?: Parameters<PrismaService['transaction']>[1],
      ) =>
        real(async (tx) => {
          held.xid = await xidOf(tx);
          const result = await fn(tx);
          reached();
          await released;
          return result;
        }, options)) as never);
      return { held, paused, release };
    }

    /** A fresh pass after every fence of `userId` is past takeover: the sweep re-asserts. */
    async function reassertedLater(
      stack: Awaited<ReturnType<typeof recordedStack>>,
      userId: string,
    ) {
      await sleep(TAKEOVER_MS);
      await stack.scanner(new Set([userId])).scan();
      await waitFor('the sweep to re-assert and clear every fence', async () =>
        (await fencesOf(userId)).length === 0 ? true : null,
      );
    }

    it('a re-assertion held at its last statement (the fence DELETE) until the stop returned: ROLLBACK — nothing commits, the PUT that landed keeps its live fence, and the sweep re-asserts after takeover', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      await dueFence(s.userId, s.keycloakId);
      const stack = await recordedStack();
      try {
        const putsBefore = stub.puts(s.keycloakId).length;
        const hold = holdLastStatement(stack.fences, 'settle');
        const after = await stopWhilePaused(stack, new Set([s.userId]), hold);

        expect(await ended(hold.held.xid)).toBe('aborted');
        expect(after).toEqual([]);
        // The PUT was applied before the stop, and carried the rows read under the lock.
        const puts = stub.puts(s.keycloakId).slice(putsBefore);
        expect(puts).toHaveLength(1);
        expect(carried(puts[0]!)).toEqual(await rowsGrant(s.userId));
        // Its fence (committed on the fence pool before the PUT) and the due
        // one it would have taken over both stay: the DELETE rolled back.
        expect(await fencesOf(s.userId)).toEqual([
          expect.objectContaining({ live: false }),
          expect.objectContaining({ live: true }),
        ]);

        await reassertedLater(stack, s.userId);
        for (const put of stub.puts(s.keycloakId).slice(putsBefore)) {
          expect(carried(put)).toEqual(await rowsGrant(s.userId));
        }
      } finally {
        await stack.close();
      }
    });

    it('a lapse held at its last statement (the outbox insert) until the stop returned: ROLLBACK — no claim, no event; the narrowing that landed keeps its live fence; the next pass after takeover lapses it once', async () => {
      const s = await seed({
        memberships: [
          { in: 'a', roles: ['OPERATOR'] },
          { in: 'b', roles: ['DRIVER'], validUntil: new Date(Date.now() - 1000) },
        ],
      });
      const lapsed = s.memberships[1]!;
      const stack = await recordedStack();
      try {
        const putsBefore = stub.puts(s.keycloakId).length;
        const hold = holdLastStatement(stack.repository, 'enqueueEvent');
        const after = await stopWhilePaused(stack, new Set([s.userId]), hold);

        expect(await ended(hold.held.xid)).toBe('aborted');
        expect(after).toEqual([]);
        expect(await events(lapsed)).toEqual([]);
        const row = await runUnscoped('the suite reads its own fixture', () =>
          prisma.client.membership.findUniqueOrThrow({ where: { id: lapsed } }),
        );
        expect(row.lapseHandledAt).toBeNull();
        // The write-ahead landed: Keycloak already holds the narrower set — the
        // safe direction — and its fence stays live, holding the rest back.
        const puts = stub.puts(s.keycloakId).slice(putsBefore);
        expect(puts).toHaveLength(1);
        const narrowed = await rowsGrant(s.userId);
        expect(carried(puts[0]!)).toEqual(narrowed);
        expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ live: true })]);

        await reassertedLater(stack, s.userId);
        expect(await events(lapsed)).toHaveLength(1);
        // No write ever put the lapsed grant back.
        for (const put of stub.puts(s.keycloakId).slice(putsBefore)) {
          expect(carried(put)).toEqual(narrowed);
        }
      } finally {
        await stack.close();
      }
    });

    it('a fence-pool INSERT transaction held at its INSERT until the stop returned: ROLLBACK — no fence row, no PUT, and the business transaction rolls back too', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      await dueFence(s.userId, s.keycloakId);
      const stack = await recordedStack();
      try {
        const putsBefore = stub.puts(s.keycloakId).length;
        // Records the business transaction's id at its fence read; holds nothing.
        const business = holdLastStatement(stack.fences, 'ofUser');
        business.release();
        const hold = holdTransaction(stack.pools.fence);
        const after = await stopWhilePaused(stack, new Set([s.userId]), hold);

        expect(await ended(hold.held.xid)).toBe('aborted');
        expect(await ended(business.held.xid)).toBe('aborted');
        expect(after).toEqual([]);
        expect(stub.puts(s.keycloakId)).toHaveLength(putsBefore);
        // Only the due fence it found: the new attempt's row never committed.
        expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ live: false })]);
      } finally {
        await stack.close();
      }
    });

    it('a consumer projection held at its last statement until the consumer’s stop returned: ROLLBACK — its fence stays live', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      const stack = await recordedStack();
      try {
        let handler!: EventHandler;
        const consumer = new KeycloakProjectionConsumer((h) => {
          handler = h;
          return {
            start: async () => undefined,
            stop: async () => undefined,
          } as unknown as EventConsumer;
        }, stack.projector);
        await consumer.onModuleInit();
        const putsBefore = stub.puts(s.keycloakId).length;
        const hold = holdLastStatement(stack.fences, 'settle');
        const handled = handler(
          {
            eventId: `EVT_${ulid()}`,
            eventName: IDENTITY_EVENTS.ROLE_ASSIGNED,
            payload: { userId: s.userId },
          } as unknown as EventEnvelope,
          {} as never,
        ).then(
          () => 'committed',
          () => 'refused',
        );
        await hold.paused;
        await consumer.stop({ deadlineAt: Date.now() + 100 });
        const stoppedAt = performance.now();
        hold.release();

        expect(await handled).toBe('refused');
        expect(await ended(hold.held.xid)).toBe('aborted');
        expect(stack.log.filter((entry) => entry.at >= stoppedAt)).toEqual([]);
        expect(stub.puts(s.keycloakId)).toHaveLength(putsBefore + 1);
        expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ live: true })]);
      } finally {
        await stack.close();
      }
    });

    it.each([
      ['the business pool', 'without', undefined],
      ['the business pool', 'with', 5_000],
      ['the fence pool', 'without', undefined],
      ['the fence pool', 'with', 5_000],
    ] as const)(
      'PrismaService.transaction on %s, %s statementTimeoutMs: a callback that resolves after the abort rolls back; one that resolves before it commits',
      async (pool, _branch, statementTimeoutMs) => {
        const stack = await recordedStack();
        try {
          const service = pool === 'the fence pool' ? stack.pools.fence : stack.pools.business;
          const run = (abortBeforeReturn: boolean) => {
            const cancel = new AbortController();
            const held = { xid: '' };
            const outcome = withCancellation(cancel.signal, () =>
              service.transaction(
                async (tx) => {
                  held.xid = await xidOf(tx);
                  if (abortBeforeReturn) cancel.abort(new Error('stopped'));
                  return 'returned';
                },
                { maxWait: 5_000, timeout: 5_000, statementTimeoutMs },
              ),
            ).then(
              (value) => value,
              (error: Error) => error.message,
            );
            return { held, outcome };
          };

          const late = run(true);
          expect(await late.outcome).toBe('stopped');
          expect(await ended(late.held.xid)).toBe('aborted');

          const inTime = run(false);
          expect(await inTime.outcome).toBe('returned');
          expect(await ended(inTime.held.xid)).toBe('committed');
        } finally {
          await stack.close();
        }
      },
    );

    it('control: the same hold at the last statement, no stop — COMMIT, and the fences go with it', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      await dueFence(s.userId, s.keycloakId);
      const stack = await recordedStack();
      try {
        const hold = holdLastStatement(stack.fences, 'settle');
        const pass = stack.scanner(new Set([s.userId])).scan();
        await hold.paused;
        hold.release();
        await pass;
        expect(await ended(hold.held.xid)).toBe('committed');
        expect(await fencesOf(s.userId)).toEqual([]);
      } finally {
        await stack.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // #402 r2 F3: the backfill drains every fence
  // -------------------------------------------------------------------------

  describe('the backfill drains every fence, linked or not (#402 r2 F3)', () => {
    async function fence(userId: string, keycloakId: string, state: 'due' | 'retry' | 'terminal') {
      await prisma.client.$executeRaw`
        INSERT INTO keycloak_write_attempt
               (attempt_id, user_id, keycloak_id, operation,
                started_at, deadline_at, takeover_at, next_reassert_at,
                reassert_failures, account_missing_at)
        VALUES (${`KWA_${ulid()}`}, ${userId}, ${keycloakId}, 'replace_attributes',
                now() - interval '10 minutes', now() - interval '10 minutes',
                now() - interval '8 minutes',
                CASE WHEN ${state} = 'retry' THEN now() + interval '1 hour'
                     ELSE now() - interval '8 minutes' END,
                CASE WHEN ${state} = 'retry' THEN 3 ELSE 0 END,
                CASE WHEN ${state} = 'terminal' THEN now() - interval '5 minutes' END)`;
    }

    /** A user whose registration was never approved: no account linked, an orphan account in Keycloak. */
    async function unlinked(orphan: { enabled: boolean; grants: boolean }) {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['OPERATOR'] }],
        account: 'missing-in-keycloak',
      });
      await runUnscoped('test fixture', () =>
        prisma.client.user.update({ where: { id: s.userId }, data: { keycloakId: null } }),
      );
      const username = `fn-${s.userId.slice(-12)}`.toLowerCase();
      stub.add({
        id: s.keycloakId,
        username,
        email: `${username}@example.test`,
        firstName: 'آزمون',
        lastName: 'حصار',
        enabled: orphan.enabled,
        attributes: orphan.grants
          ? { ...provenanceOnly(s.userId), organization_ids: [s.org.a] }
          : provenanceOnly(s.userId),
      });
      return s;
    }

    it('drains an unlinked user’s fence, a repaired orphan’s earlier attempt and a fence waiting out its retry; a terminal fence stays and keeps the count above zero', async () => {
      // The review's probe: harmless orphan, unlinked, an uncertain fence left.
      const harmless = await unlinked({ enabled: false, grants: false });
      await fence(harmless.userId, harmless.keycloakId, 'due');
      // A non-harmless orphan: the orphan sweep repairs it, settling only its own attempts.
      const repaired = await unlinked({ enabled: true, grants: true });
      await fence(repaired.userId, repaired.keycloakId, 'due');
      // Linked, its fence deferred by failed re-assertions.
      const retry = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      await fence(retry.userId, retry.keycloakId, 'retry');
      // Linked, the account gone: terminal.
      const terminal = await seed({
        memberships: [{ in: 'a', roles: ['OPERATOR'] }],
        account: 'missing-in-keycloak',
      });
      await fence(terminal.userId, terminal.keycloakId, 'terminal');

      const only = new Set([harmless.userId, repaired.userId, retry.userId, terminal.userId]);
      // The command over this suite's users only — the real queries, filtered
      // after; the count is the same COUNT(*), over these users' rows.
      const scopedRepository = Object.create(repository) as IdentityRepository;
      scopedRepository.listUserIdsWithAccount = async (after, take) =>
        (await repository.listUserIdsWithAccount(after, 100_000))
          .filter((u) => only.has(u))
          .slice(0, take);
      scopedRepository.listUsersWithoutAccount = async (after, take) =>
        (await repository.listUsersWithoutAccount(after, 100_000))
          .filter((u) => only.has(u.id))
          .slice(0, take);
      const scopedFences = Object.create(fencing.fences) as KeycloakWriteFences;
      scopedFences.owners = async (after, take) =>
        (await fencing.fences.owners(after, 100_000)).filter((u) => only.has(u)).slice(0, take);
      const ids = [...only];
      scopedFences.counts = async () => {
        const [row] = await prisma.client.$queryRaw<Array<{ total: bigint; terminal: bigint }>>`
          SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE account_missing_at IS NOT NULL) AS terminal
            FROM keycloak_write_attempt WHERE user_id = ANY(${ids}::text[])`;
        return {
          live: 0,
          due: 0,
          overdue: 0,
          expired: 0,
          accountMissing: Number(row!.terminal),
          total: Number(row!.total),
          at: new Date(),
        };
      };

      const report = await runProjectionCommand('backfill', {
        repository: scopedRepository,
        projector,
        keycloak,
        fences: scopedFences,
      });

      expect(await fencesOf(harmless.userId)).toEqual([]);
      expect(await fencesOf(repaired.userId)).toEqual([]);
      expect(await fencesOf(retry.userId)).toEqual([]);
      expect(await fencesOf(terminal.userId)).toEqual([
        expect.objectContaining({ accountMissing: true }),
      ]);
      expect(report.fences).toMatchObject({ outstanding: 1, accountMissing: 1 });
      expect(report.fences.drained).toBeGreaterThanOrEqual(2);
      expect(stub.accounts.get(repaired.keycloakId)).toMatchObject({ enabled: false });

      // Nothing to wait for but the terminal one: once its account is back, the
      // next backfill drains it, and the count is zero.
      stub.add({
        id: terminal.keycloakId,
        username: `fn-${terminal.userId.slice(-12)}`.toLowerCase(),
        email: `fn-${terminal.userId.slice(-12)}@example.test`.toLowerCase(),
        firstName: 'آزمون',
        lastName: 'حصار',
        attributes: { ...(await rowsGrant(terminal.userId)), rasta_activation: ['REG_FIXTURE'] },
      });
      const again = await runProjectionCommand('backfill', {
        repository: scopedRepository,
        projector,
        keycloak,
        fences: scopedFences,
      });
      expect(again.fences.outstanding).toBe(0);
    });

    it('counts every row as COUNT(*) does, whatever its state', async () => {
      const at = await repository.databaseNow(prisma.client);
      const counted = await fencing.fences.counts(at);
      const [row] = await prisma.client.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*) AS n FROM keycloak_write_attempt`;
      expect(counted.total).toBe(Number(row!.n));
    });
  });

  // -------------------------------------------------------------------------
  // #402 r2 F4 and D-070
  // -------------------------------------------------------------------------

  describe('the durable backoffs cannot overflow (#402 r2 F4)', () => {
    it.each([1023, 2_147_483_647])(
      'a re-assertion counter of %i: deferred by the capped interval, the counter capped',
      async (failures) => {
        const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
        await prisma.client.$executeRaw`
          INSERT INTO keycloak_write_attempt
                 (attempt_id, user_id, keycloak_id, operation,
                  started_at, deadline_at, takeover_at, next_reassert_at, reassert_failures)
          VALUES (${`KWA_${ulid()}`}, ${s.userId}, ${s.keycloakId}, 'replace_attributes',
                  now() - interval '10 minutes', now() - interval '10 minutes',
                  now() - interval '8 minutes', now() - interval '8 minutes', ${failures})`;
        await fencing.fences.deferReassert(s.userId, 60, 16);
        const [deferred] = await fencesOf(s.userId);
        expect(deferred!.reassertFailures).toBe(Math.min(failures + 1, 1_000_000));
        expect(deferred!.nextIn).toBeGreaterThan(60 * 16 - 5);
        expect(deferred!.nextIn).toBeLessThanOrEqual(60 * 16);
      },
    );

    it.each([1023, 2_147_483_647])(
      'a lapse counter of %i: deferred by the capped interval, the counter capped',
      async (failures) => {
        const s = await seed({
          memberships: [{ in: 'a', roles: ['OPERATOR'], validUntil: new Date(Date.now() - 1000) }],
        });
        const membershipId = s.memberships[0]!;
        await runUnscoped(
          'test fixture',
          () =>
            prisma.client
              .$executeRaw`UPDATE membership SET lapse_failures = ${failures} WHERE id = ${membershipId}`,
        );
        await repository.deferLapse(membershipId, 60, 16);
        const [row] = await runUnscoped(
          'test reads its fixture',
          () =>
            prisma.client.$queryRaw<Array<{ failures: number; retry_in: number }>>`
            SELECT lapse_failures AS failures,
                   EXTRACT(EPOCH FROM lapse_retry_at - (clock_timestamp() AT TIME ZONE 'UTC'))::float AS retry_in
              FROM membership WHERE id = ${membershipId}`,
        );
        expect(row!.failures).toBe(Math.min(failures + 1, 1_000_000));
        expect(row!.retry_in).toBeGreaterThan(60 * 16 - 5);
        expect(row!.retry_in).toBeLessThanOrEqual(60 * 16);
      },
    );
  });

  describe('a write unresolved past half its settle window is counted as overdue (D-070)', () => {
    it('counts live fences past deadline + settle/2, not those before it, nor due ones', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      const at = await repository.databaseNow(prisma.client);
      const before = await fencing.fences.counts(at);
      // settle 70 s each. Overdue: deadline 50 s ago (half the window passed 15 s ago).
      // Not yet: deadline 10 s ago (25 s to go). Due: past takeover.
      for (const [deadlineAgo, takeoverIn] of [
        [50, 20],
        [10, 60],
        [100, -30],
      ] as const) {
        await prisma.client.$executeRaw`
          INSERT INTO keycloak_write_attempt
                 (attempt_id, user_id, keycloak_id, operation,
                  started_at, deadline_at, takeover_at, next_reassert_at)
          SELECT ${`KWA_${ulid()}`}, ${s.userId}, ${s.keycloakId}, 'replace_attributes',
                 t.c - make_interval(secs => ${deadlineAgo + 10}),
                 t.c - make_interval(secs => ${deadlineAgo}),
                 t.c + make_interval(secs => ${takeoverIn}),
                 t.c + make_interval(secs => ${takeoverIn})
            FROM (SELECT ${at}::timestamp AS c) t`;
      }
      const after = await fencing.fences.counts(at);
      expect(after.overdue - before.overdue).toBe(1);
      expect(after.live - before.live).toBe(2);
      expect(after.due - before.due).toBe(1);
      expect(after.total - before.total).toBe(3);
      await prisma.client
        .$executeRaw`DELETE FROM keycloak_write_attempt WHERE user_id = ${s.userId}`;
    });
  });
});
