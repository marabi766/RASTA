import { performance } from 'node:perf_hooks';
import { runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import { MembershipExpiryScanner } from '../src/identity/membership-expiry.scanner';
import type { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import {
  FENCE_POOL_CONNECTIONS,
  KeycloakWriteFences,
  type KeycloakWriteAttempt,
} from '../src/keycloak/keycloak-write-fence';
import { KeycloakProjector, settleRecoveryProjections } from '../src/keycloak/keycloak.projector';
import {
  platformAttributesFor,
  readPlatformAttributes,
  type PlatformAttributes,
} from '../src/keycloak/platform-attributes';
import { runProjectionCommand } from '../src/keycloak/projection.command';
import {
  keycloakProjectionsTotal,
  keycloakWriteFenceEventsTotal,
} from '../src/observability/keycloak-projection.metrics';
import { PrismaService } from '../src/prisma/prisma.service';
import { asActor, databaseUrl, id, newPrisma, tenants } from './helpers';
import { KeycloakHttpStub, type StubRequest } from './keycloak-http-stub';

/**
 * D-070 option D, against a real PostgreSQL and the real `KeycloakAdminClient`
 * over a real socket to `keycloak-http-stub.ts`: a sender that learns its
 * write's outcome only after its own deadline — whatever the outcome — commits
 * a **fresh** fence for the user and asks for an immediate projection, so a
 * PUT that lands late is never the last word.
 *
 * **The pause.** A sender paused after its request went out (a process stop,
 * a GC, an event-loop stall) resumes with its monotonic clock moved on and
 * its answer waiting. The suite pauses a sender exactly that way: the fences'
 * monotonic clock (`monotonicNow`, `performance.now` in production) is moved
 * past the deadline while the request is at Keycloak — after the dispatch
 * check passed — and Keycloak answers. A timeout (the request's own timer
 * firing first on resume) is the other way a paused sender can hear back:
 * the same pause, and Keycloak never answers (`nextPut('hang')`).
 *
 * A timeout alone is **not** a late reply (#458 r1 F5): the request's timer
 * is set to the whole milliseconds left, rounded down, so it may fire a
 * fraction before the deadline, and an outcome observed then is on time —
 * the attempt's own fence covers it. So no test here relies on the real
 * timer to make a sender late: lateness is always a pause, said so.
 *
 * Every narrowing sender is driven through its own entry point: a projection
 * (the consumer's and the request's), an API narrowing's write-ahead, the
 * sweep's lapse and its re-assertion, and the backfill command.
 */

const SETTLE_SECONDS = 2;
const REQUEST_TIMEOUT_MS = 400;
/** Longer than a request's deadline: what a paused sender's clock moves on by. */
const PAUSE_MS = REQUEST_TIMEOUT_MS + 1_000;

describe('D-070 option D: a late sender fences afresh and asks for a projection', () => {
  let prisma: PrismaService;
  let fencePool: PrismaService;
  let repository: IdentityRepository;
  let stub: KeycloakHttpStub;
  let keycloak: KeycloakAdminClient;
  let fences: KeycloakWriteFences;
  let projector: KeycloakProjector;
  let service: IdentityService;
  /** How far the senders' monotonic clock is ahead of `performance.now`: the pauses so far. */
  let paused = 0;
  const mine = new Set<string>();

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    fencePool = new PrismaService(databaseUrl(), { connections: FENCE_POOL_CONNECTIONS });
    await fencePool.onModuleInit();
    repository = new IdentityRepository(prisma);
    stub = new KeycloakHttpStub();
    await stub.start();
    keycloak = stub.client(REQUEST_TIMEOUT_MS);
    fences = new KeycloakWriteFences(fencePool, { monotonicNow: () => performance.now() + paused });
    projector = new KeycloakProjector(repository, keycloak, fences, {
      writeSettleSeconds: SETTLE_SECONDS,
    });
    service = new IdentityService(repository, keycloak, projector);
  });

  afterEach(async () => {
    await settleRecoveryProjections(30_000);
    stub.onPut = null;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await stub.close();
    await fencePool.stop();
    await prisma.stop();
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

  async function seed(
    memberships: Array<{ in: 'a' | 'b'; roles: string[]; validUntil?: Date }>,
  ): Promise<Seeded> {
    const org = tenants();
    const userId = id('USR-LS');
    mine.add(userId);
    const keycloakId = `kc-${userId.slice(-16).toLowerCase()}`;
    const ids = memberships.map(() => id('MBR-LS'));
    const validFrom = new Date(Date.now() - 3_600_000);
    const username = `ls-${userId.slice(-12)}`.toLowerCase();
    await runUnscoped('test fixture spans organizations', async () => {
      await prisma.client.user.create({
        data: {
          id: userId,
          keycloakId,
          username,
          email: `${username}@example.test`,
          firstName: 'آزمون',
          lastName: 'دیرکرد',
          status: 'ACTIVE',
          activeOrganizationId: org.a,
          createdBy: 'ITEST',
          updatedBy: 'ITEST',
        },
      });
      for (const [index, membership] of memberships.entries()) {
        await prisma.client.membership.create({
          data: {
            id: ids[index]!,
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
    stub.add({
      id: keycloakId,
      username,
      email: `${username}@example.test`,
      firstName: 'آزمون',
      lastName: 'دیرکرد',
      attributes: {
        ...(await rowsGrant(userId, validFrom.getTime() + 60_000)),
        rasta_activation: ['REG_FIXTURE'],
      },
    });
    return { userId, keycloakId, org, memberships: ids };
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

  const carried = (request: StubRequest) =>
    readPlatformAttributes(request.body?.attributes as Record<string, string[]>);

  interface FenceRow {
    attemptId: string;
    operation: string;
    keycloakId: string;
    live: boolean;
    /** `takeover_at - deadline_at`, seconds: 0 for an outcome known. */
    window: number;
    /** `deadline_at - started_at`, seconds. */
    timeout: number;
    startedAgo: number;
    deadlineAt: Date;
    takeoverAt: Date;
    nextReassertAt: Date;
    reassertFailures: number;
  }

  const fencesOf = async (userId: string): Promise<FenceRow[]> =>
    (
      await prisma.client.$queryRaw<
        Array<{
          attempt_id: string;
          operation: string;
          keycloak_id: string;
          live: boolean;
          window: number;
          timeout: number;
          started_ago: number;
          deadline_at: Date;
          takeover_at: Date;
          next_reassert_at: Date;
          reassert_failures: number;
        }>
      >`
        SELECT attempt_id, operation, keycloak_id,
               takeover_at > (clock_timestamp() AT TIME ZONE 'UTC') AS live,
               EXTRACT(EPOCH FROM takeover_at - deadline_at)::float AS window,
               EXTRACT(EPOCH FROM deadline_at - started_at)::float AS timeout,
               EXTRACT(EPOCH FROM (clock_timestamp() AT TIME ZONE 'UTC') - started_at)::float AS started_ago,
               deadline_at, takeover_at, next_reassert_at, reassert_failures
          FROM keycloak_write_attempt WHERE user_id = ${userId}
         ORDER BY started_at, attempt_id`
    ).map((row) => ({
      attemptId: row.attempt_id,
      operation: row.operation,
      keycloakId: row.keycloak_id,
      live: row.live,
      window: row.window,
      timeout: row.timeout,
      startedAgo: row.started_ago,
      deadlineAt: row.deadline_at,
      takeoverAt: row.takeover_at,
      nextReassertAt: row.next_reassert_at,
      reassertFailures: row.reassert_failures,
    }));

  /**
   * The next PUT to arrive pauses its sender (see the header); `meanwhile`
   * runs first, while the request is at Keycloak and its sender stopped.
   */
  function pauseNextSender(meanwhile?: (request: StubRequest) => Promise<void>) {
    let armed = true;
    stub.onPut = async (request) => {
      if (!armed) return;
      armed = false;
      await meanwhile?.(request);
      paused += PAUSE_MS;
    };
  }

  /**
   * What each late sender's fresh fence left committed, read the moment it
   * was written (`recoverLate` returned): the late attempt, and every fence
   * of its user then.
   */
  function recordLateFences() {
    const seen: Array<{ late: string; known: boolean; written: boolean; rows: FenceRow[] }> = [];
    const original = fences.recoverLate.bind(fences);
    jest
      .spyOn(fences, 'recoverLate')
      .mockImplementation(async (attempt: KeycloakWriteAttempt, known: boolean) => {
        const written = await original(attempt, known);
        const record = { late: attempt.id, known, written, rows: [] as FenceRow[] };
        seen.push(record);
        // A stopped sender's scope refuses this read too: then there is no snapshot.
        record.rows = await Promise.all([...mine].map((userId) => fencesOf(userId))).then(
          (all) => all.flat(),
          () => [],
        );
        return written;
      });
    return seen;
  }

  /** Every projection the projector starts, by trigger. */
  function recordProjections() {
    const triggers: string[] = [];
    const original = projector.project.bind(projector);
    jest.spyOn(projector, 'project').mockImplementation(async (userId, trigger, options) => {
      triggers.push(trigger);
      return original(userId, trigger, options);
    });
    return triggers;
  }

  const counter = async (event: string) =>
    (await keycloakWriteFenceEventsTotal.get()).values.find((v) => v.labels.event === event)
      ?.value ?? 0;
  const projections = async (trigger: string, outcome: string) =>
    (await keycloakProjectionsTotal.get()).values.find(
      (v) => v.labels.trigger === trigger && v.labels.outcome === outcome,
    )?.value ?? 0;

  /** A sweep that sees only this suite's users (see `keycloak-write-fence.int-spec.ts`). */
  function ownScanner(using: KeycloakWriteFences = fences) {
    const scopedRepository = Object.create(repository) as IdentityRepository;
    scopedRepository.findLapsedMemberships = async (at, take, after, until) =>
      (await repository.findLapsedMemberships(at, 1000, after, until))
        .filter((row) => mine.has(row.userId))
        .slice(0, take);
    const scopedFences = Object.create(using) as KeycloakWriteFences;
    scopedFences.dueUsers = async (after, take, until) =>
      (await using.dueUsers(after, 1000, until))
        .filter((userId) => mine.has(userId))
        .slice(0, take);
    return new MembershipExpiryScanner(
      scopedRepository,
      service,
      { enabled: false, intervalSeconds: 60, batchSize: 50 },
      projector,
      scopedFences,
    );
  }

  const narrowRows = (membershipId: string, roles: string[]) =>
    runUnscoped('a narrowing that committed while the sender was paused', () =>
      prisma.client.membership.update({ where: { id: membershipId }, data: { roles } }),
    );

  const asAdmin = <T>(organizationId: string, fn: () => Promise<T>) =>
    asActor({ organizationId, userId: 'USR-LS-ADMIN', roles: ['ORGANIZATION_ADMIN'] }, fn);

  // -------------------------------------------------------------------------
  // The outcome, whatever it is
  // -------------------------------------------------------------------------

  describe('whatever outcome the late sender gets', () => {
    it('success, late: a fresh fence (its outcome known: a zero window, due at once) and a recovery projection — the stale PUT that landed is not the last word', async () => {
      const s = await seed([{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }]);
      const late = recordLateFences();
      const triggers = recordProjections();
      const fencedBefore = await counter('late_fenced');
      const recoveredBefore = await projections('recovery', 'projected');
      const wide = await rowsGrant(s.userId);
      // The sender read the wide rows; while it is paused at Keycloak, a
      // narrowing commits; then its stale PUT lands, and it hears 204.
      pauseNextSender(() => narrowRows(s.memberships[0]!, ['OPERATOR']).then(() => undefined));

      await expect(projector.project(s.userId, 'event')).resolves.toBe('projected');

      expect(late).toHaveLength(1);
      const [record] = late;
      expect(record).toMatchObject({ known: true, written: true });
      const fresh = record!.rows.filter((row) => row.attemptId !== record!.late);
      expect(fresh).toEqual([
        expect.objectContaining({
          keycloakId: s.keycloakId,
          operation: 'replace_attributes',
          window: 0,
          live: false,
        }),
      ]);
      expect(await counter('late_fenced')).toBe(fencedBefore + 1);
      expect(triggers).toEqual(['event', 'recovery']);

      await settleRecoveryProjections(10_000);
      expect(await projections('recovery', 'projected')).toBe(recoveredBefore + 1);
      const puts = stub.puts(s.keycloakId);
      expect(carried(puts[puts.length - 2]!)).toEqual(wide);
      const narrowed = await rowsGrant(s.userId);
      expect(narrowed).not.toEqual(wide);
      // The last word: the committed rows, after the late PUT.
      expect(carried(puts[puts.length - 1]!)).toEqual(narrowed);
      expect(stub.platform(s.keycloakId)).toEqual(narrowed);
      // The recovery took the fresh fence over (and the late attempt's own).
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('failure, late — refused (4xx): its own row is released, and a fresh fence and a projection all the same', async () => {
      const s = await seed([{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }]);
      const late = recordLateFences();
      const triggers = recordProjections();
      stub.nextPut('refuse', 403);
      pauseNextSender(() => narrowRows(s.memberships[0]!, ['OPERATOR']).then(() => undefined));

      await expect(projector.project(s.userId, 'event')).rejects.toBeDefined();

      expect(late).toHaveLength(1);
      const [record] = late;
      expect(record).toMatchObject({ known: true, written: true });
      // Released before the fresh one was written: only the fresh one is left.
      expect(record!.rows).toEqual([
        expect.objectContaining({ window: 0, live: false, operation: 'replace_attributes' }),
      ]);
      expect(record!.rows[0]!.attemptId).not.toBe(record!.late);
      expect(triggers).toEqual(['event', 'recovery']);

      await settleRecoveryProjections(10_000);
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('failure, late — unknown (5xx): the fresh fence is live, with its own deadline and takeover from now; narrowing waits; the sweep re-asserts after takeover', async () => {
      const s = await seed([{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }]);
      const late = recordLateFences();
      stub.nextPut('refuse', 503);
      pauseNextSender();

      await expect(projector.project(s.userId, 'event')).rejects.toBeDefined();

      const [record] = late;
      expect(record).toMatchObject({ known: false, written: true });
      const own = record!.rows.find((row) => row.attemptId === record!.late);
      const fresh = record!.rows.filter((row) => row.attemptId !== record!.late);
      // Its own row stays live (the outcome is unknown) — and beside it, a
      // fresh one whose window starts now, not at the old attempt's start.
      expect(own).toMatchObject({ live: true });
      expect(fresh).toEqual([
        expect.objectContaining({
          live: true,
          window: SETTLE_SECONDS,
          timeout: REQUEST_TIMEOUT_MS / 1000,
        }),
      ]);
      expect(fresh[0]!.takeoverAt.getTime()).toBeGreaterThanOrEqual(own!.takeoverAt.getTime());

      await settleRecoveryProjections(10_000);
      // A narrowing waits for a re-assertion after takeover.
      await expect(
        asAdmin(s.org.a, () =>
          service.updateMembershipRoles(s.memberships[0]!, {
            roles: ['OPERATOR'] as never,
            reason: 'late sender itest',
          }),
        ),
      ).rejects.toMatchObject({ code: 'KEYCLOAK_WRITE_SETTLING' });

      const takeover = Math.max(...record!.rows.map((row) => row.takeoverAt.getTime()));
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, takeover - Date.now()) + 300));
      await ownScanner().scan();
      expect(await fencesOf(s.userId)).toEqual([]);
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
    });

    it('a timeout heard after its sender paused at Keycloak (its own timer fires on resume): late, unknown — a fresh live fence', async () => {
      const s = await seed([{ in: 'a', roles: ['OPERATOR'] }]);
      const late = recordLateFences();
      stub.nextPut('hang');
      pauseNextSender();

      await expect(projector.project(s.userId, 'event')).rejects.toBeDefined();

      expect(late).toEqual([expect.objectContaining({ known: false, written: true })]);
      const fresh = late[0]!.rows.filter((row) => row.attemptId !== late[0]!.late);
      expect(fresh).toEqual([expect.objectContaining({ live: true, window: SETTLE_SECONDS })]);
    });

    it('a timeout on the real clock alone is not lateness (#458 r1 F5): a fresh fence exactly when it was observed past the deadline, and its own live fence either way', async () => {
      const s = await seed([{ in: 'a', roles: ['OPERATOR'] }]);
      const late = recordLateFences();
      stub.nextPut('hang');

      await expect(projector.project(s.userId, 'event')).rejects.toBeDefined();
      await settleRecoveryProjections(10_000);

      // The timer may fire a fraction before the deadline (not late: nothing
      // more) or after it (late: one fresh fence) — the verdict is the
      // observation's, and the fences follow it, whichever it was.
      expect(late.length).toBeLessThanOrEqual(1);
      expect(late.every((record) => record.written && !record.known)).toBe(true);
      const rows = await fencesOf(s.userId);
      expect(rows).toHaveLength(1 + late.length);
      expect(rows.every((row) => row.live)).toBe(true);
    });

    it('on time: no fresh fence and no recovery — the deadline is judged on the clock after the reply, not before', async () => {
      const s = await seed([{ in: 'a', roles: ['OPERATOR'] }]);
      const late = recordLateFences();
      const triggers = recordProjections();
      let seenAtKeycloak = 0;
      stub.onPut = async () => {
        seenAtKeycloak = (await fencesOf(s.userId)).length;
      };

      await expect(projector.project(s.userId, 'event')).resolves.toBe('projected');

      expect(seenAtKeycloak).toBe(1);
      expect(late).toEqual([]);
      expect(triggers).toEqual(['event']);
      expect(await fencesOf(s.userId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Every narrowing sender
  // -------------------------------------------------------------------------

  describe('every sender: the same fresh fence and recovery from each entry point', () => {
    async function expectRecovered(
      s: Seeded,
      late: ReturnType<typeof recordLateFences>,
      triggers: string[],
    ) {
      expect(late.length).toBeGreaterThanOrEqual(1);
      expect(late[0]).toMatchObject({ written: true });
      expect(late[0]!.rows.some((row) => row.attemptId !== late[0]!.late)).toBe(true);
      expect(triggers).toContain('recovery');
      await settleRecoveryProjections(10_000);
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
      expect(await fencesOf(s.userId)).toEqual([]);
    }

    it('an API narrowing’s write-ahead (the admin demotes a role)', async () => {
      const s = await seed([{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }]);
      const late = recordLateFences();
      const triggers = recordProjections();
      pauseNextSender();

      await asAdmin(s.org.a, () =>
        service.updateMembershipRoles(s.memberships[0]!, {
          roles: ['OPERATOR'] as never,
          reason: 'late sender itest',
        }),
      );

      await expectRecovered(s, late, triggers);
    });

    it('the sweep’s lapse (its write-ahead)', async () => {
      const s = await seed([
        { in: 'a', roles: ['OPERATOR'] },
        { in: 'b', roles: ['DRIVER'], validUntil: new Date(Date.now() - 1_000) },
      ]);
      const late = recordLateFences();
      const triggers = recordProjections();
      pauseNextSender();

      await ownScanner().scan();

      await expectRecovered(s, late, triggers);
      const row = await runUnscoped('the suite reads its own fixture', () =>
        prisma.client.membership.findUniqueOrThrow({ where: { id: s.memberships[1]! } }),
      );
      expect(row.lapseHandledAt).not.toBeNull();
    });

    it('the sweep’s re-assertion of a due fence', async () => {
      const s = await seed([{ in: 'a', roles: ['OPERATOR'] }]);
      // A write that timed out long ago and is past takeover: due.
      await prisma.client.$executeRaw`
        INSERT INTO keycloak_write_attempt
               (attempt_id, user_id, keycloak_id, operation,
                started_at, deadline_at, takeover_at, next_reassert_at)
        SELECT ${`KWA_${id('DUE')}`}, ${s.userId}, ${s.keycloakId}, 'replace_attributes',
               c - interval '10 seconds', c - interval '9 seconds', c - interval '1 second', c - interval '1 second'
          FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS c) t`;
      const late = recordLateFences();
      const triggers = recordProjections();
      pauseNextSender();

      await ownScanner().scan();

      expect(triggers[0]).toBe('reassert');
      await expectRecovered(s, late, triggers);
    });

    it('the backfill command: it waits for the recovery and writes what is owed before it counts', async () => {
      const s = await seed([{ in: 'a', roles: ['OPERATOR'] }]);
      const late = recordLateFences();
      const triggers = recordProjections();
      pauseNextSender();
      const scopedFences = Object.create(fences) as KeycloakWriteFences;
      scopedFences.owners = async (after, take) =>
        (await fences.owners(after, 1000)).filter((userId) => mine.has(userId)).slice(0, take);

      const report = await runProjectionCommand('backfill', {
        repository: {
          listUserIdsWithAccount: async (after) => (after === null ? [s.userId] : []),
          listUsersWithoutAccount: async () => [],
        },
        projector,
        keycloak,
        fences: scopedFences,
      });

      expect(report.fences.owed).toBe(0);
      // Its recovery ran before the command returned: no wait here.
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
      await expectRecovered(s, late, triggers);
      expect(report.failed).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Ownership: an old attempt already taken over
  // -------------------------------------------------------------------------

  describe('the old attempt was already taken over while its sender was paused', () => {
    /**
     * While the sender is paused at Keycloak: its fence is taken over (its
     * row gone) and a newer attempt's fence — the replacement — is live.
     */
    async function takeOverAndReplace(s: Seeded) {
      const [own] = await fencesOf(s.userId);
      const replacement = `KWA_${id('REPL')}`;
      await prisma.client.$transaction([
        prisma.client
          .$executeRaw`DELETE FROM keycloak_write_attempt WHERE attempt_id = ${own!.attemptId}`,
        prisma.client.$executeRaw`
          INSERT INTO keycloak_write_attempt
                 (attempt_id, user_id, keycloak_id, operation,
                  started_at, deadline_at, takeover_at, next_reassert_at)
          SELECT ${replacement}, ${s.userId}, ${s.keycloakId}, 'replace_attributes',
                 c, c + interval '30 seconds', c + interval '60 seconds', c + interval '60 seconds'
            FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS c) t`,
      ]);
      return { own: own!.attemptId, replacement };
    }

    for (const outcome of ['success', 'refused'] as const) {
      it(`${outcome}: its cleanup never deletes or shortens the replacement; a fresh fence beside it`, async () => {
        const s = await seed([{ in: 'a', roles: ['OPERATOR'] }]);
        const late = recordLateFences();
        let ids!: { own: string; replacement: string };
        let before!: FenceRow;
        if (outcome === 'refused') stub.nextPut('refuse', 403);
        pauseNextSender(async () => {
          ids = await takeOverAndReplace(s);
          before = (await fencesOf(s.userId)).find((row) => row.attemptId === ids.replacement)!;
        });

        const sent = projector.project(s.userId, 'event');
        if (outcome === 'success') await expect(sent).resolves.toBe('projected');
        else await expect(sent).rejects.toBeDefined();
        await settleRecoveryProjections(10_000);

        expect(late).toEqual([expect.objectContaining({ late: ids.own, written: true })]);
        const rows = await fencesOf(s.userId);
        expect(rows.find((row) => row.attemptId === ids.own)).toBeUndefined();
        const after = rows.find((row) => row.attemptId === ids.replacement);
        // Exactly as it was: not deleted, not shortened, not deferred.
        expect(after).toMatchObject({
          live: true,
          deadlineAt: before.deadlineAt,
          takeoverAt: before.takeoverAt,
          nextReassertAt: before.nextReassertAt,
          reassertFailures: before.reassertFailures,
        });
        // The fresh fence (a zero window) was taken over by the recovery; the
        // replacement, still live, holds the narrowing back until its takeover.
        expect(rows.map((row) => row.attemptId)).toEqual([ids.replacement]);
        await prisma.client
          .$executeRaw`DELETE FROM keycloak_write_attempt WHERE attempt_id = ${ids.replacement}`;
      });
    }
  });

  // -------------------------------------------------------------------------
  // The stop: a cancelled worker cannot write; its stop's flush does
  // -------------------------------------------------------------------------

  describe('a worker stopped while its sender is paused', () => {
    it('the resumed sender’s fresh fence is refused in its stopped scope, owed, and written by the stop’s flush outside it; the lapse rolls back with no event', async () => {
      const s = await seed([
        { in: 'a', roles: ['OPERATOR'] },
        { in: 'b', roles: ['DRIVER'], validUntil: new Date(Date.now() - 1_000) },
      ]);
      const late = recordLateFences();
      const scanner = ownScanner();
      let stopping!: Promise<void>;
      // The sender is paused at Keycloak, and the stop begins: its request is
      // aborted, and its scope refuses every database operation from now on.
      let armed = true;
      stub.onPut = async () => {
        if (!armed) return;
        armed = false;
        paused += PAUSE_MS;
        stopping = scanner.stop({ deadlineAt: Date.now() + 10_000 });
      };

      await scanner.scan();
      await stopping;

      expect(late).toEqual([expect.objectContaining({ known: false, written: false })]);
      // Written by the stop's flush, before the stop returned: a fresh live row.
      const rows = await fencesOf(s.userId);
      const fresh = rows.filter((row) => row.attemptId !== late[0]!.late);
      expect(fresh).toEqual([expect.objectContaining({ live: true, window: SETTLE_SECONDS })]);
      expect(fences.owedCount).toBe(0);
      // Nothing of the stopped pass committed: no claim, no lapse event.
      const row = await runUnscoped('the suite reads its own fixture', () =>
        prisma.client.membership.findUniqueOrThrow({ where: { id: s.memberships[1]! } }),
      );
      expect(row.lapseHandledAt).toBeNull();
      const events = await runUnscoped('test reads the outbox', () =>
        prisma.client.outboxMessage.findMany({ where: { aggregateId: s.memberships[1]! } }),
      );
      expect(events).toEqual([]);
      await prisma.client
        .$executeRaw`DELETE FROM keycloak_write_attempt WHERE user_id = ${s.userId}`;
    });

    it('a sender still unanswered past its deadline when its worker stops: the flush writes a fresh live fence for it — the stop leaves a durable record of the paused sender', async () => {
      const s = await seed([{ in: 'a', roles: ['OPERATOR'] }]);
      let arrived!: () => void;
      const atKeycloak = new Promise<void>((resolve) => (arrived = resolve));
      stub.nextPut('hold');
      stub.onPut = async () => {
        // Paused: past its deadline on the senders' clock, still unanswered.
        paused += PAUSE_MS;
        arrived();
      };

      const sending = projector.project(s.userId, 'event').catch((error: unknown) => error);
      await atKeycloak;
      // The worker's stop flushes, outside any stopped scope.
      expect(await fences.recoverOwed()).toBe(0);
      const rows = await fencesOf(s.userId);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.live)).toBe(true);
      expect(rows[1]!.window).toBe(SETTLE_SECONDS);
      // Once: a second flush writes nothing more for it.
      expect(await fences.recoverOwed()).toBe(0);
      expect(await fencesOf(s.userId)).toHaveLength(2);

      stub.releaseHeld();
      await sending;
      await settleRecoveryProjections(10_000);
      await prisma.client
        .$executeRaw`DELETE FROM keycloak_write_attempt WHERE user_id = ${s.userId}`;
    });
  });

  describe('one lifecycle boundary: nothing of a stop runs after it returned (#458 r1 F2)', () => {
    it('a stop whose flush waits for a fence connection past its deadline: after the stop returns, no transaction of it begins, inserts or commits — the fence stays owed', async () => {
      const s = await seed([{ in: 'a', roles: ['OPERATOR'] }]);
      // A sender still unanswered past its deadline: owed by the next flush.
      const attempt = await prisma.transaction(
        (tx) =>
          fences.open(tx, {
            userId: s.userId,
            keycloakId: s.keycloakId,
            operation: 'replace_attributes',
            timeoutMs: REQUEST_TIMEOUT_MS,
            settleSeconds: SETTLE_SECONDS,
            transactionTimeoutMs: 5_000,
          }),
        { timeout: 5_000 },
      );
      attempt.assertDispatchable();
      paused += PAUSE_MS;

      // Every fence connection is busy: the flush's transaction waits.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const holders = Array.from({ length: FENCE_POOL_CONNECTIONS }, () =>
        fencePool.transaction(() => released, { maxWait: 5_000, timeout: 10_000 }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      // What reached the fence pool's transactions, and when.
      const log: string[] = [];
      const real = fencePool.transaction.bind(fencePool);
      jest.spyOn(fencePool, 'transaction').mockImplementation((fn, options) =>
        real(async (tx) => {
          log.push('BEGIN');
          const result = await fn(tx);
          log.push('CALLBACK DONE');
          return result;
        }, options).then((result) => {
          log.push('COMMIT');
          return result;
        }),
      );

      await ownScanner().stop({ deadlineAt: Date.now() + 300 });
      log.push('STOP RETURNED');
      release();
      await Promise.all(holders);
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      expect(log).toEqual(['STOP RETURNED']);
      // Nothing written, nothing forgotten: only the attempt's own row, and
      // the fresh fence still owed in the process.
      expect(await fencesOf(s.userId)).toEqual([
        expect.objectContaining({ attemptId: attempt.id, live: true }),
      ]);
      expect(fences.owedCount).toBe(1);

      jest.restoreAllMocks();
      expect(await fences.recoverOwed()).toBe(0);
      await prisma.client
        .$executeRaw`DELETE FROM keycloak_write_attempt WHERE user_id = ${s.userId}`;
    });

    it('a request’s recovery projection has the application’s stop as its owner: stopped mid-projection, it reads, writes and commits nothing more', async () => {
      const s = await seed([{ in: 'a', roles: ['OPERATOR'] }]);
      // A projector of its own: its stop is for good.
      const owned = new KeycloakProjector(repository, keycloak, fences, {
        writeSettleSeconds: SETTLE_SECONDS,
      });
      // The recovery's first statement after the user lock completes, then
      // it is held there — inside its transaction, with no signal of a
      // request to stop it.
      let reached!: () => void;
      const atRecovery = new Promise<void>((resolve) => (reached = resolve));
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => (resume = resolve));
      const databaseNow = repository.databaseNow.bind(repository);
      let calls = 0;
      jest.spyOn(repository, 'databaseNow').mockImplementation(async (client) => {
        const now = await databaseNow(client);
        calls += 1;
        if (calls === 2) {
          reached();
          await resumed;
        }
        return now;
      });
      let stopped = false;
      const after: string[] = [];
      const findUserById = repository.findUserById.bind(repository);
      jest.spyOn(repository, 'findUserById').mockImplementation(async (...args) => {
        const user = await findUserById(...args);
        if (stopped) after.push('findUserById');
        return user;
      });

      // The request's projection: its sender paused at Keycloak, answered — late.
      pauseNextSender();
      await expect(owned.project(s.userId, 'request')).resolves.toBe('projected');
      await atRecovery;
      const puts = stub.puts(s.keycloakId).length;

      const stop = owned.stop({ deadlineAt: Date.now() + 300 });
      // One stop: a later call joins it.
      expect(owned.stop()).toBe(stop);
      await stop;
      stopped = true;
      resume();
      expect(await settleRecoveryProjections(10_000)).toBe('finished');

      // Resumed after the stop: no read reached the database, no PUT was sent.
      expect(after).toEqual([]);
      expect(stub.puts(s.keycloakId)).toHaveLength(puts);
      // Its fresh fence stands for it, for the sweep: the reply was heard —
      // a zero window, due at once — and nothing took it over.
      expect(await fencesOf(s.userId)).toEqual([
        expect.objectContaining({ live: false, window: 0 }),
      ]);
      await prisma.client
        .$executeRaw`DELETE FROM keycloak_write_attempt WHERE user_id = ${s.userId}`;
    });
  });

  // -------------------------------------------------------------------------
  // What recovery never changes
  // -------------------------------------------------------------------------

  describe('regressions (brief G)', () => {
    it('the recovery rebuilds from committed rows only — a membership in another tenant is projected as the rows say — and enqueues no event', async () => {
      const s = await seed([
        { in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] },
        { in: 'b', roles: ['DRIVER'] },
      ]);
      const outbox = () =>
        runUnscoped('test reads the outbox', () =>
          prisma.client.outboxMessage.count({
            where: { aggregateId: { in: [s.userId, ...s.memberships] } },
          }),
        );
      const eventsBefore = await outbox();
      pauseNextSender();
      await asAdmin(s.org.a, () => projector.project(s.userId, 'event'));
      await settleRecoveryProjections(10_000);
      // A replayed event's late write and its recovery add no business effect.
      expect(await outbox()).toBe(eventsBefore);
      // Both tenants' grants, exactly as committed: the actor's scope (org a)
      // neither hides org b's membership nor adds anything.
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
      expect(stub.platform(s.keycloakId).organization_roles).toEqual(
        expect.arrayContaining([expect.stringContaining(s.org.b)]),
      );
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('labels no metric with a user, an account or an organization', async () => {
      const values = [
        ...(await keycloakWriteFenceEventsTotal.get()).values,
        ...(await keycloakProjectionsTotal.get()).values,
      ];
      for (const value of values) {
        for (const label of Object.values(value.labels)) {
          expect(String(label)).not.toMatch(/USR|MBR|ORG|kc-/);
        }
      }
    });
  });
});
