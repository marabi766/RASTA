import { RastaError, runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import { MembershipExpiryScanner } from '../src/identity/membership-expiry.scanner';
import { KeycloakProjectionConsumer } from '../src/keycloak/keycloak-projection.consumer';
import { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import {
  isWithin,
  platformAttributesFor,
  readPlatformAttributes,
  type PlatformAttributes,
} from '../src/keycloak/platform-attributes';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, id, newFences, newPrisma, tenants, waitFor } from './helpers';
import { KeycloakHttpStub, type StubRequest } from './keycloak-http-stub';

/**
 * ADR-060, write-ahead addendum (D-064): a change that takes access away
 * writes Keycloak **before** it commits, and its event — the gateway's cutoff
 * — is enqueued after that write; a change that grants still commits first.
 *
 * Against a real PostgreSQL, and the real `KeycloakAdminClient` over a real
 * socket to a stand-in for Keycloak's Admin API (`keycloak-http-stub.ts`):
 * Keycloak is stubbed at the HTTP boundary, and nowhere else. Every
 * interleaving is forced — a write held, refused, timed out, applied with its
 * answer lost, or applied after the caller gave up on it — never hoped for.
 *
 * What is proven, for roles removed, a revocation and a lapse:
 * - the write reaches Keycloak while the database still holds the old rows,
 *   and before the event exists; the event is stamped after it;
 * - when Keycloak cannot be written: 503 `KEYCLOAK_UNAVAILABLE`, the rows
 *   unchanged, no event;
 * - when the write may have landed (deadline, lost answer): the same, and
 *   Keycloak is narrower than or equal to the rows, never wider; a narrowing
 *   is refused until that write can no longer land, and the user is then
 *   projected again from the rows;
 * - when the write landed and the commit did not: Keycloak is narrower, and
 *   is put back;
 * - every writer of a user is serialised on the user lock, and computes what
 *   it writes from rows read under it;
 * - only the target user's account is written, and their other organizations
 *   are untouched in all four attributes, with the profile-field allowlist.
 */

const SETTLE_SECONDS = 2;
/** The stub client's request deadline (`stub.client()`), the fence's `deadline_at - started_at`. */
const REQUEST_TIMEOUT_MS = 400;
/** From a fence's opening until it is no longer live: deadline + settle, and a margin. */
const TAKEOVER_MS = REQUEST_TIMEOUT_MS + SETTLE_SECONDS * 1000 + 300;

describe('narrowing changes write Keycloak before they commit (D-064)', () => {
  let prisma: PrismaService;
  let repository: IdentityRepository;
  let stub: KeycloakHttpStub;
  let keycloak: KeycloakAdminClient;
  let projector: KeycloakProjector;
  let service: IdentityService;
  let scanner: MembershipExpiryScanner;
  let fencing: Awaited<ReturnType<typeof newFences>>;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    await prisma.client.$queryRawUnsafe('SELECT 1');
    repository = new IdentityRepository(prisma);
    stub = new KeycloakHttpStub();
    await stub.start();
    keycloak = stub.client(REQUEST_TIMEOUT_MS);
    fencing = await newFences();
    // Suite hygiene: fences other runs left behind would be re-asserted by
    // this suite's sweeps against a Keycloak that never had their accounts.
    await prisma.client.$executeRawUnsafe('DELETE FROM keycloak_write_attempt');
    projector = new KeycloakProjector(repository, keycloak, fencing.fences, {
      writeSettleSeconds: SETTLE_SECONDS,
    });
    service = new IdentityService(repository, keycloak, projector);
    scanner = new MembershipExpiryScanner(
      repository,
      service,
      { enabled: false, intervalSeconds: 60, batchSize: 50 },
      projector,
      fencing.fences,
    );
  });

  afterEach(async () => {
    stub.onPut = null;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await stub.close();
    await fencing.pool.onModuleDestroy();
    await prisma.onModuleDestroy();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  interface Seeded {
    userId: string;
    keycloakId: string;
    org: { a: string; b: string };
    /** Membership ids, in the order given. */
    memberships: string[];
  }

  /**
   * A user whose Keycloak account already carries what their rows grant, plus
   * attributes the platform does not own (`locale`, the activation marker).
   */
  async function seed(spec: {
    memberships: Array<{ in: 'a' | 'b'; roles: string[]; validUntil?: Date }>;
    active?: 'a' | 'b' | null;
    account?: 'linked' | 'none' | 'missing-in-keycloak';
  }): Promise<Seeded> {
    const org = tenants();
    const userId = id('USR-WA');
    const keycloakId = `kc-${userId.slice(-16).toLowerCase()}`;
    const linked = spec.account !== 'none';
    const active = spec.active === undefined ? org.a : spec.active ? org[spec.active] : null;
    const memberships = spec.memberships.map(() => id('MBR-WA'));
    const validFrom = new Date(Date.now() - 3_600_000);

    await runUnscoped('test fixture spans organizations', async () => {
      await prisma.client.user.create({
        data: {
          id: userId,
          keycloakId: linked ? keycloakId : null,
          username: `wa-${userId.slice(-12)}`.toLowerCase(),
          email: `wa-${userId.slice(-12)}@example.test`.toLowerCase(),
          firstName: 'آزمون',
          lastName: 'پیش‌نویس',
          status: 'ACTIVE',
          activeOrganizationId: active,
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

    if (spec.account !== 'none' && spec.account !== 'missing-in-keycloak') {
      stub.add({
        id: keycloakId,
        username: `wa-${userId.slice(-12)}`.toLowerCase(),
        email: `wa-${userId.slice(-12)}@example.test`.toLowerCase(),
        firstName: 'آزمون',
        lastName: 'پیش‌نویس',
        attributes: {
          ...(await rowsGrant(userId, validFrom.getTime() + 60_000)),
          locale: ['fa'],
          rasta_activation: ['REG_FIXTURE'],
        },
      });
    }
    return { userId, keycloakId, org, memberships };
  }

  /** What the committed rows grant, read outside any transaction. */
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
    asActor({ organizationId, userId: 'USR-WA-ADMIN', roles: ['ORGANIZATION_ADMIN'] }, fn);

  const demote = (s: Seeded, membership: number, roles: string[], org: 'a' | 'b' = 'a') =>
    asAdmin(s.org[org], () =>
      service.updateMembershipRoles(s.memberships[membership]!, {
        roles: roles as never,
        reason: 'write-ahead itest',
      }),
    );

  const revoke = (s: Seeded, membership: number, org: 'a' | 'b' = 'a') =>
    asAdmin(s.org[org], () =>
      service.revokeMembership(s.memberships[membership]!, { reason: 'write-ahead itest' }),
    );

  /** The committed row, outside any transaction. */
  const committedMembership = (membershipId: string) =>
    runUnscoped('test reads what committed', () =>
      prisma.client.membership.findFirst({ where: { id: membershipId } }),
    );

  const events = (aggregateId: string) =>
    runUnscoped('test reads the outbox', () =>
      prisma.client.outboxMessage.findMany({
        where: { aggregateId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  /** The user's Keycloak write fences (D-069), as the table holds them. */
  const fencesOf = async (userId: string) =>
    (
      await prisma.client.$queryRaw<
        Array<{ attempt_id: string; live: boolean; operation: string }>
      >`
        SELECT attempt_id, operation,
               takeover_at > (clock_timestamp() AT TIME ZONE 'UTC') AS live
          FROM keycloak_write_attempt WHERE user_id = ${userId}
         ORDER BY started_at, attempt_id`
    ).map((row) => ({ attemptId: row.attempt_id, operation: row.operation, live: row.live }));

  /** The platform attributes a PUT carried. */
  const carried = (request: StubRequest) =>
    readPlatformAttributes(request.body?.attributes as Record<string, string[]>);

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected a refusal');
      },
      (error: unknown) => error,
    );

  /** Waits until a session of this database is waiting on a lock. */
  const someoneWaitsOnALock = () =>
    waitFor('a transaction to wait on the user lock', async () => {
      const rows = await prisma.client.$queryRawUnsafe<{ waiting: bigint }[]>(
        `SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      return Number(rows[0]?.waiting ?? 0) > 0 ? true : null;
    });

  /** A gate a PUT can be held on, inside the writer's transaction. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { open, opened };
  }

  // -------------------------------------------------------------------------
  // Order: Keycloak, then the event, then the commit
  // -------------------------------------------------------------------------

  describe('a demotion', () => {
    it('reaches Keycloak while the database still holds the old roles, before its event exists; the event is stamped after it', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      const seenAtWrite: Array<{ roles: string[] | undefined; events: number }> = [];
      stub.onPut = async () => {
        seenAtWrite.push({
          roles: (await committedMembership(s.memberships[0]!))?.roles,
          events: (await events(s.memberships[0]!)).length,
        });
      };

      await demote(s, 0, ['OPERATOR']);

      const [ahead, after] = stub.puts(s.keycloakId);
      // The write-ahead: the old roles still committed, no event yet.
      expect(seenAtWrite[0]).toEqual({ roles: ['ORGANIZATION_ADMIN', 'OPERATOR'], events: 0 });
      expect(carried(ahead!).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
      // The projection after commit: the change committed, its event too.
      expect(seenAtWrite[1]).toEqual({ roles: ['OPERATOR'], events: 1 });
      expect(carried(after!)).toEqual(await rowsGrant(s.userId));

      const [revoked] = await events(s.memberships[0]!);
      expect(revoked!.eventName).toBe('ROLE_REVOKED');
      // `occurredAt` is stamped at enqueue, after the write returned
      // (`outbox.ts`: `input.occurredAt ?? new Date()`), and the row's
      // `createdAt` is that same instant.
      const occurredAt = Date.parse((revoked!.payload as { occurredAt: string }).occurredAt);
      expect(occurredAt).toBeGreaterThanOrEqual(ahead!.at);
      expect(revoked!.createdAt.getTime()).toBe(occurredAt);
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
    });

    it('Keycloak down: 503 KEYCLOAK_UNAVAILABLE, the roles unchanged, no event, nothing held back', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      const before = await committedMembership(s.memberships[0]!);
      const held = stub.platform(s.keycloakId);
      await stub.down();
      try {
        const error = await failure(demote(s, 0, ['OPERATOR']));
        expect(error).toMatchObject({ status: 503, code: 'KEYCLOAK_UNAVAILABLE' });
      } finally {
        await stub.up();
      }
      expect(await committedMembership(s.memberships[0]!)).toEqual(before);
      expect(await events(s.memberships[0]!)).toEqual([]);
      expect(stub.platform(s.keycloakId)).toEqual(held);
      // Refused before anything was sent: nothing can land later.
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('Keycloak refuses the write (4xx): the same, and nothing can land later', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      stub.nextPut('refuse', 403);

      const error = await failure(demote(s, 0, ['OPERATOR']));

      expect(error).toMatchObject({ status: 503, code: 'KEYCLOAK_UNAVAILABLE' });
      expect((await committedMembership(s.memberships[0]!))?.roles).toEqual([
        'ORGANIZATION_ADMIN',
        'OPERATOR',
      ]);
      expect(await events(s.memberships[0]!)).toEqual([]);
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('a write past its deadline: 503, unchanged, and narrowing is refused until it can no longer land; then the retry commits once', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      stub.nextPut('hang');

      const error = await failure(demote(s, 0, ['OPERATOR']));
      expect(error).toMatchObject({ status: 503, code: 'KEYCLOAK_UNAVAILABLE' });
      expect((await committedMembership(s.memberships[0]!))?.roles).toEqual([
        'ORGANIZATION_ADMIN',
        'OPERATOR',
      ]);
      expect(await events(s.memberships[0]!)).toEqual([]);
      // Its fence stays: the write may still land.
      expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ live: true })]);

      // The retry, while that write may still land: refused before writing.
      const putsBefore = stub.puts(s.keycloakId).length;
      const settling = await failure(demote(s, 0, ['OPERATOR']));
      expect(settling).toMatchObject({ status: 503, code: 'KEYCLOAK_WRITE_SETTLING' });
      expect((settling as RastaError).retryAfterSeconds).toBeGreaterThan(0);
      expect(stub.puts(s.keycloakId)).toHaveLength(putsBefore);

      // Once it can no longer land, the retry commits — once.
      await new Promise((resolve) => setTimeout(resolve, TAKEOVER_MS));
      await demote(s, 0, ['OPERATOR']);
      await demote(s, 0, ['OPERATOR']);
      expect((await events(s.memberships[0]!)).map((event) => event.eventName)).toEqual([
        'ROLE_REVOKED',
      ]);
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
    });

    it('a write that landed with its answer lost: 503, unchanged rows, Keycloak narrower than them, then put back from the rows', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      stub.nextPut('apply-then-drop');

      const error = await failure(demote(s, 0, ['OPERATOR']));

      expect(error).toMatchObject({ status: 503, code: 'KEYCLOAK_UNAVAILABLE' });
      expect(await events(s.memberships[0]!)).toEqual([]);
      const rows = await rowsGrant(s.userId);
      // Fail-closed: narrower than the rows, never wider.
      expect(isWithin(stub.platform(s.keycloakId), rows)).toBe(true);
      expect(stub.platform(s.keycloakId)).not.toEqual(rows);

      // The next projection under the lock, once the mark passes, re-asserts the rows.
      await new Promise((resolve) => setTimeout(resolve, TAKEOVER_MS));
      await scanner.scan();
      expect(stub.platform(s.keycloakId)).toEqual(rows);
      expect(await fencesOf(s.userId)).toEqual([]);
    });

    it('Keycloak written and the commit failed: narrower, put back at once from the rows, and by the sweep when that fails too', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      const rows = await rowsGrant(s.userId);
      jest
        .spyOn(repository, 'enqueueEvent')
        .mockRejectedValueOnce(new Error('the database went away after the write'));

      await expect(demote(s, 0, ['OPERATOR'])).rejects.toThrow(/went away/);

      expect((await committedMembership(s.memberships[0]!))?.roles).toEqual([
        'ORGANIZATION_ADMIN',
        'OPERATOR',
      ]);
      const [ahead, restored] = stub.puts(s.keycloakId);
      expect(carried(ahead!).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
      expect(carried(restored!)).toEqual(rows);
      expect(stub.platform(s.keycloakId)).toEqual(rows);
      expect(await fencesOf(s.userId)).toEqual([]);

      // Again, with the immediate re-projection refused as well: the mark
      // stays due, and the sweep puts the rows back.
      jest
        .spyOn(repository, 'enqueueEvent')
        .mockRejectedValueOnce(new Error('the database went away after the write'));
      stub.nextPut('delay', 0);
      stub.nextPut('refuse', 403);
      await expect(demote(s, 0, ['OPERATOR'])).rejects.toThrow(/went away/);
      expect(isWithin(stub.platform(s.keycloakId), rows)).toBe(true);
      expect(stub.platform(s.keycloakId)).not.toEqual(rows);
      // The write-ahead landed, so it cannot land again: its fence is due at
      // once (not live — no narrowing is held back), and the sweep takes it over.
      expect(await fencesOf(s.userId)).toEqual([expect.objectContaining({ live: false })]);

      await scanner.scan();
      expect(stub.platform(s.keycloakId)).toEqual(rows);
      expect(await fencesOf(s.userId)).toEqual([]);
    });
  });

  describe('a mixed change and a widening one', () => {
    it('mixed: the roles kept are written ahead, the full new set after commit', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });

      await demote(s, 0, ['OPERATOR', 'DRIVER']);

      const [ahead, after] = stub.puts(s.keycloakId);
      expect(carried(ahead!).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
      expect(carried(after!).organization_roles).toEqual([
        `${s.org.a}:DRIVER`,
        `${s.org.a}:OPERATOR`,
      ]);
      const written = await events(s.memberships[0]!);
      expect(written.map((event) => event.eventName).sort()).toEqual([
        'ROLE_ASSIGNED',
        'ROLE_REVOKED',
      ]);
      for (const event of written)
        expect(event.createdAt.getTime()).toBeGreaterThanOrEqual(ahead!.at);
    });

    it('widening: nothing is written before commit, and Keycloak down does not stop it', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      const seenAtWrite: Array<string[] | undefined> = [];
      stub.onPut = async () => {
        seenAtWrite.push((await committedMembership(s.memberships[0]!))?.roles);
      };

      await demote(s, 0, ['OPERATOR', 'DRIVER']);
      // One write, after the commit.
      expect(seenAtWrite).toEqual([['OPERATOR', 'DRIVER']]);

      await stub.down();
      try {
        await expect(demote(s, 0, ['OPERATOR', 'DRIVER', 'FLEET_MANAGER'])).resolves.toMatchObject({
          roles: ['OPERATOR', 'DRIVER', 'FLEET_MANAGER'],
        });
      } finally {
        await stub.up();
      }
      expect((await events(s.memberships[0]!)).map((event) => event.eventName)).toEqual([
        'ROLE_ASSIGNED',
        'ROLE_ASSIGNED',
      ]);
      expect(await fencesOf(s.userId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  describe('a revocation', () => {
    it('writes ahead without the organization and with no active one, then the moved active organization after commit', async () => {
      const s = await seed({
        memberships: [
          { in: 'a', roles: ['OPERATOR'] },
          { in: 'b', roles: ['DRIVER'] },
        ],
        active: 'a',
      });
      const committedAtWrite: Array<boolean> = [];
      stub.onPut = async () => {
        committedAtWrite.push((await committedMembership(s.memberships[0]!))?.deletedAt !== null);
      };

      await revoke(s, 0);

      const [ahead, after] = stub.puts(s.keycloakId);
      expect(committedAtWrite).toEqual([false, true]);
      expect(carried(ahead!)).toEqual({
        rasta_user_id: [s.userId],
        organization_ids: [s.org.b],
        organization_roles: [`${s.org.b}:DRIVER`],
        active_organization_id: [],
      });
      expect(carried(after!).active_organization_id).toEqual([s.org.b]);
      const [revoked] = await events(s.memberships[0]!);
      expect(revoked!.createdAt.getTime()).toBeGreaterThanOrEqual(ahead!.at);
    });

    it('Keycloak down: 503, still live, no event', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      await stub.down();
      try {
        await expect(revoke(s, 0)).rejects.toMatchObject({
          status: 503,
          code: 'KEYCLOAK_UNAVAILABLE',
        });
      } finally {
        await stub.up();
      }
      expect(await committedMembership(s.memberships[0]!)).toMatchObject({
        status: 'ACTIVE',
        deletedAt: null,
      });
      expect(await events(s.memberships[0]!)).toEqual([]);
    });

    it('sent again — the first answer lost behind a gateway timeout — answers the same, with one event', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });

      await revoke(s, 0);
      await expect(revoke(s, 0)).resolves.toBeUndefined();

      expect((await events(s.memberships[0]!)).map((event) => event.eventName)).toEqual([
        'MEMBERSHIP_REVOKED',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Exceptions: nothing to narrow
  // -------------------------------------------------------------------------

  describe('nothing to narrow', () => {
    it('no Keycloak account (never approved): commits, writes nothing', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['OPERATOR', 'DRIVER'] }],
        account: 'none',
      });
      const puts = stub.puts().length;

      await demote(s, 0, ['OPERATOR']);

      expect(stub.puts()).toHaveLength(puts);
      expect((await events(s.memberships[0]!)).map((event) => event.eventName)).toEqual([
        'ROLE_REVOKED',
      ]);
    });

    it('Keycloak answers 404 for the account: commits, as with no account', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['OPERATOR', 'DRIVER'] }],
        account: 'missing-in-keycloak',
      });

      await demote(s, 0, ['OPERATOR']);

      expect((await events(s.memberships[0]!)).map((event) => event.eventName)).toEqual([
        'ROLE_REVOKED',
      ]);
    });

    it('Keycloak sync off (development and test only): commits as before, writes nothing', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR', 'DRIVER'] }] });
      const off = new KeycloakAdminClient({
        baseUrl: stub.url,
        realm: 'rasta',
        clientId: 'rasta-backend',
        clientSecret: 'stub-client-secret',
        enabled: false,
      });
      const offService = new IdentityService(
        repository,
        off,
        new KeycloakProjector(repository, off, fencing.fences),
      );
      const puts = stub.puts().length;

      await asAdmin(s.org.a, () =>
        offService.updateMembershipRoles(s.memberships[0]!, { roles: ['OPERATOR'], reason: 'x' }),
      );

      expect(stub.puts()).toHaveLength(puts);
      expect((await events(s.memberships[0]!)).map((event) => event.eventName)).toEqual([
        'ROLE_REVOKED',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // The expiry sweep
  // -------------------------------------------------------------------------

  describe('the expiry sweep', () => {
    it('Keycloak failing (503): the lapse is not acted on — unclaimed, no event — and is acted on once Keycloak is back', async () => {
      const s = await seed({
        memberships: [
          { in: 'a', roles: ['OPERATOR'] },
          { in: 'b', roles: ['DRIVER'], validUntil: new Date(Date.now() - 1000) },
        ],
        active: 'b',
      });
      const own = new MembershipExpiryScanner(
        repository,
        service,
        { enabled: false, intervalSeconds: 60, batchSize: 50 },
        projector,
        fencing.fences,
      );
      stub.refuseFor(s.keycloakId, 503);
      const now = new Date();

      await own.scan(now);
      expect(await committedMembership(s.memberships[1]!)).toMatchObject({ lapseHandledAt: null });
      expect(await events(s.memberships[1]!)).toEqual([]);
      expect(stub.platform(s.keycloakId).organization_ids).toContain(s.org.b);

      stub.stopRefusing(s.keycloakId);
      // A 5xx may have landed: wait until it cannot, then the next pass that
      // reaches it — past its backoff — acts.
      await new Promise((resolve) => setTimeout(resolve, TAKEOVER_MS));
      await own.scan(new Date(now.getTime() + 3 * 60_000));
      expect((await committedMembership(s.memberships[1]!))?.lapseHandledAt).not.toBeNull();
      expect((await events(s.memberships[1]!)).map((event) => event.eventName)).toEqual([
        'MEMBERSHIP_EXPIRED',
      ]);
      expect(stub.platform(s.keycloakId)).toEqual({
        rasta_user_id: [s.userId],
        organization_ids: [s.org.a],
        organization_roles: [`${s.org.a}:OPERATOR`],
        active_organization_id: [s.org.a],
      });
    });

    it('a lapse whose user cannot be written never starves the lapse behind it', async () => {
      const lapsedAt = new Date(Date.now() - 5_000);
      const stuck = await seed({
        memberships: [{ in: 'a', roles: ['OPERATOR'], validUntil: lapsedAt }],
      });
      const behind = await seed({
        memberships: [{ in: 'a', roles: ['DRIVER'], validUntil: new Date(lapsedAt.getTime() + 1) }],
      });
      const own = new MembershipExpiryScanner(
        repository,
        service,
        // One attempt per pass: the stuck lapse alone would use every pass.
        { enabled: false, intervalSeconds: 60, batchSize: 1 },
        projector,
        fencing.fences,
      );
      // Only lapses of these two fixtures, so other suites' rows do not interfere.
      const only = new Set([stuck.memberships[0], behind.memberships[0]]);
      const real = repository.findLapsedMemberships.bind(repository);
      jest
        .spyOn(repository, 'findLapsedMemberships')
        .mockImplementation(async (at, take, after, until) =>
          (await real(at, 1000, after, until)).filter((row) => only.has(row.id)).slice(0, take),
        );
      stub.refuseFor(stuck.keycloakId, 403);
      const now = new Date();

      await own.scan(now);
      await own.scan(new Date(now.getTime() + 60_000));

      expect(await committedMembership(stuck.memberships[0]!)).toMatchObject({
        lapseHandledAt: null,
      });
      expect((await committedMembership(behind.memberships[0]!))?.lapseHandledAt).not.toBeNull();
      stub.stopRefusing(stuck.keycloakId);
    });
  });

  // -------------------------------------------------------------------------
  // One lock, every writer
  // -------------------------------------------------------------------------

  describe('every writer of a user on one lock', () => {
    // A held write must stay inside its deadline here: these are about the
    // lock, not about a write whose answer is lost (that is above).
    let patient: { service: IdentityService; projector: KeycloakProjector };
    beforeAll(() => {
      const slow = stub.client(15_000);
      const patientProjector = new KeycloakProjector(repository, slow, fencing.fences, {
        writeSettleSeconds: SETTLE_SECONDS,
      });
      patient = {
        projector: patientProjector,
        service: new IdentityService(repository, slow, patientProjector),
      };
    });
    const patientDemote = (s: Seeded, roles: string[]) =>
      asAdmin(s.org.a, () =>
        patient.service.updateMembershipRoles(s.memberships[0]!, {
          roles: roles as never,
          reason: 'write-ahead itest',
        }),
      );

    it('demote vs grant: the grant’s projection waits for the demotion, and Keycloak ends on the rows', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      const hold = gate();
      let first = true;
      stub.onPut = async () => {
        if (first) {
          first = false;
          await hold.opened;
        }
      };

      // The demotion's write-ahead is held, inside its transaction, under the lock.
      const demotion = patientDemote(s, ['OPERATOR']);
      await waitFor('the write-ahead to reach Keycloak', async () =>
        stub.puts(s.keycloakId).length > 0 ? true : null,
      );
      // A grant in another organization commits (it takes no user lock), and
      // its projection waits on the lock the demotion holds.
      const grant = asActor({ organizationId: s.org.b, roles: ['SYSTEM_ADMIN'] }, () =>
        patient.service.addMembership(s.userId, { organizationId: s.org.b, roles: ['DRIVER'] }),
      );
      await someoneWaitsOnALock();
      expect(stub.puts(s.keycloakId)).toHaveLength(1);

      hold.open();
      await Promise.all([demotion, grant]);

      const rows = await rowsGrant(s.userId);
      expect(rows.organization_roles).toEqual([`${s.org.a}:OPERATOR`, `${s.org.b}:DRIVER`].sort());
      expect(stub.platform(s.keycloakId)).toEqual(rows);
      // Never wider: no write after the write-ahead carries the removed role.
      const [ahead, ...later] = stub.puts(s.keycloakId);
      expect(carried(ahead!).organization_roles).not.toContain(`${s.org.a}:ORGANIZATION_ADMIN`);
      for (const put of later) {
        expect(carried(put).organization_roles).not.toContain(`${s.org.a}:ORGANIZATION_ADMIN`);
      }
    });

    it('demote vs the consumer backstop: the backstop waits, then writes the committed demotion, never the old grant', async () => {
      const s = await seed({
        memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] }],
      });
      const consumer = new KeycloakProjectionConsumer(null, patient.projector);
      const hold = gate();
      let first = true;
      stub.onPut = async () => {
        if (first) {
          first = false;
          await hold.opened;
        }
      };

      const demotion = patientDemote(s, ['OPERATOR']);
      await waitFor('the write-ahead to reach Keycloak', async () =>
        stub.puts(s.keycloakId).length > 0 ? true : null,
      );
      // An older event of this user arrives now — a re-delivery, a backlog.
      const backstop = consumer.handle({
        eventId: id('EVT'),
        eventName: 'ROLE_ASSIGNED',
        eventVersion: 1,
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
        producer: 'identity-service',
        producerVersion: 'itest',
        aggregateType: 'Membership',
        aggregateId: s.memberships[0]!,
        correlationId: 'COR-WA',
        payload: { userId: s.userId },
      } as never);
      await someoneWaitsOnALock();
      expect(stub.puts(s.keycloakId)).toHaveLength(1);

      hold.open();
      await Promise.all([demotion, backstop]);

      for (const put of stub.puts(s.keycloakId)) {
        expect(carried(put).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
      }
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
    });

    it('a write that lands after its caller gave up: narrowing is refused until it cannot land any more, and the rows are re-asserted', async () => {
      const s = await seed({
        memberships: [
          { in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] },
          { in: 'b', roles: ['DRIVER'], validUntil: new Date(Date.now() + 1500) },
        ],
      });
      const wide = await rowsGrant(s.userId);

      // A projection of the wide rows: Keycloak receives it and has not
      // applied it when the client's deadline passes. Aborting it did not
      // cancel it.
      stub.nextPut('hold');
      await expect(projector.project(s.userId, 'event')).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      });
      expect(stub.heldCount).toBe(1);
      expect(await fencesOf(s.userId)).toEqual([
        expect.objectContaining({ live: true, operation: 'replace_attributes' }),
      ]);

      // A demotion now could be overtaken by that write: refused, nothing sent.
      const puts = stub.puts(s.keycloakId).length;
      await expect(demote(s, 0, ['OPERATOR'])).rejects.toMatchObject({
        code: 'KEYCLOAK_WRITE_SETTLING',
      });
      expect(stub.puts(s.keycloakId)).toHaveLength(puts);

      // Membership b lapses meanwhile; then Keycloak finally applies the old
      // write: wider than the rows, which no longer grant b.
      await new Promise((resolve) => setTimeout(resolve, 1600));
      stub.releaseHeld();
      expect(stub.platform(s.keycloakId)).toEqual(wide);
      expect(isWithin(stub.platform(s.keycloakId), await rowsGrant(s.userId))).toBe(false);

      // It does not stay so: once the mark passes, the sweep projects the
      // rows again and acts on the lapse, under the lock.
      await new Promise((resolve) => setTimeout(resolve, TAKEOVER_MS - 1600));
      const only = new Set([s.memberships[1]]);
      const real = repository.findLapsedMemberships.bind(repository);
      jest
        .spyOn(repository, 'findLapsedMemberships')
        .mockImplementation(async (at, take, after, until) =>
          (await real(at, 1000, after, until)).filter((row) => only.has(row.id)).slice(0, take),
        );
      await scanner.scan();
      expect(stub.platform(s.keycloakId)).toEqual(await rowsGrant(s.userId));
      expect(stub.platform(s.keycloakId).organization_ids).toEqual([s.org.a]);

      // And now the demotion is the last write, and commits.
      await demote(s, 0, ['OPERATOR']);
      expect(stub.platform(s.keycloakId).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
    });

    it('decides on the rows read under the lock: a role granted while it waited is removed and written ahead', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR'] }] });
      // Read by the request before the lock: OPERATOR alone, so "nothing removed".
      const held = gate();
      const granted = gate();
      const holder = repository.transaction(async (tx) => {
        await repository.lockUserMemberships(tx, s.userId);
        await runUnscoped('test grants under the lock', () =>
          tx.membership.update({
            where: { id: s.memberships[0]! },
            data: { roles: ['OPERATOR', 'DRIVER'], updatedBy: 'ITEST' },
          }),
        );
        granted.open();
        await held.opened;
      });
      await granted.opened;

      const request = demote(s, 0, ['OPERATOR']);
      await someoneWaitsOnALock();
      held.open();
      await holder;
      await request;

      const [ahead] = stub.puts(s.keycloakId);
      expect(carried(ahead!).organization_roles).toEqual([`${s.org.a}:OPERATOR`]);
      const [revoked] = await events(s.memberships[0]!);
      expect(revoked).toMatchObject({ eventName: 'ROLE_REVOKED' });
      expect(revoked!.payload).toMatchObject({
        payload: { previousRoles: ['OPERATOR', 'DRIVER'], newRoles: ['OPERATOR'] },
      });
    });

    it('authorizes on the rows read under the lock: a role above the caller granted while it waited refuses it, before any Keycloak call', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR', 'DRIVER'] }] });
      const held = gate();
      const granted = gate();
      const holder = repository.transaction(async (tx) => {
        await repository.lockUserMemberships(tx, s.userId);
        await runUnscoped('test grants under the lock', () =>
          tx.membership.update({
            where: { id: s.memberships[0]! },
            data: { roles: ['OPERATOR', 'DRIVER', 'UNION_ADMIN'], updatedBy: 'ITEST' },
          }),
        );
        granted.open();
        await held.opened;
      });
      await granted.opened;
      const puts = stub.puts().length;

      const request = failure(demote(s, 0, ['OPERATOR']));
      await someoneWaitsOnALock();
      held.open();
      await holder;

      expect(await request).toMatchObject({ status: 403 });
      expect(stub.puts()).toHaveLength(puts);
      expect((await committedMembership(s.memberships[0]!))?.roles).toEqual([
        'OPERATOR',
        'DRIVER',
        'UNION_ADMIN',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  describe('tenancy', () => {
    it('another organization’s administrator is refused before any Keycloak call', async () => {
      const s = await seed({ memberships: [{ in: 'a', roles: ['OPERATOR', 'DRIVER'] }] });
      const requests = stub.requests.length;

      await expect(demote(s, 0, ['OPERATOR'], 'b')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(revoke(s, 0, 'b')).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect(stub.requests).toHaveLength(requests);
      expect((await committedMembership(s.memberships[0]!))?.roles).toEqual(['OPERATOR', 'DRIVER']);
    });

    it('writes only the target’s account; their other organization is unchanged in all four attributes; the allowlist holds', async () => {
      const s = await seed({
        memberships: [
          { in: 'a', roles: ['ORGANIZATION_ADMIN', 'OPERATOR'] },
          { in: 'b', roles: ['DRIVER', 'FLEET_MANAGER'] },
        ],
        active: 'b',
      });
      const bystander = await seed({ memberships: [{ in: 'a', roles: ['ORGANIZATION_ADMIN'] }] });
      const bystanderBefore = structuredClone(stub.accounts.get(bystander.keycloakId));

      await demote(s, 0, ['OPERATOR']);

      expect(stub.requests.filter((request) => request.userId === bystander.keycloakId)).toEqual(
        [],
      );
      expect(stub.accounts.get(bystander.keycloakId)).toEqual(bystanderBefore);

      const [ahead] = stub.puts(s.keycloakId);
      expect(carried(ahead!)).toEqual({
        rasta_user_id: [s.userId],
        organization_ids: [s.org.a, s.org.b].sort(),
        organization_roles: [
          `${s.org.a}:OPERATOR`,
          `${s.org.b}:DRIVER`,
          `${s.org.b}:FLEET_MANAGER`,
        ].sort(),
        active_organization_id: [s.org.b],
      });
      // The body is the allowlist (`keycloak.client.ts` `platformAttributesWrite`):
      // the three profile fields as read, and the attributes; nothing else.
      expect(Object.keys(ahead!.body!).sort()).toEqual([
        'attributes',
        'email',
        'firstName',
        'lastName',
      ]);
      const attributes = ahead!.body!.attributes as Record<string, string[]>;
      expect(attributes.locale).toEqual(['fa']);
      expect(attributes.rasta_activation).toEqual(['REG_FIXTURE']);
      expect(stub.accounts.get(s.keycloakId)).toMatchObject({ enabled: true, firstName: 'آزمون' });
    });
  });
});
