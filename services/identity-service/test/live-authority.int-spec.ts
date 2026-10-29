import { runUnscoped } from '@rasta/nest-common';
import { startIdentityApi, type IdentityApiHarness } from './api-helpers';
import {
  bearerOf,
  eventNames,
  http,
  membershipRow,
  registrationBody,
  seedPerson,
  type Person,
} from './identity-fixtures';
import { id, tenants } from './helpers';

/**
 * Identity administration decides on the caller's **live** authority (task
 * 117, audit F1).
 *
 * Every request below carries a token minted while its holder was an
 * administrator, and still valid — the up-to-905-second window ADR-060 § 7
 * accepts. Before this, a token was all the administration routes measured:
 * a demoted `ORGANIZATION_ADMIN` could `POST /v1/memberships/<own>/roles` with
 * their old role and have it back for good. Each refusal here is the same
 * `403` an ordinary ladder refusal is, nothing changes, and no event is
 * written. The real `AppModule` over HTTP, the real PostgreSQL; Keycloak sync
 * off (the write-ahead is proven in `write-ahead-narrowing.int-spec.ts`).
 */
describe('identity administration decides on the caller’s live authority (task 117, F1)', () => {
  let harness: IdentityApiHarness;
  let api: ReturnType<typeof http>;

  beforeAll(async () => {
    harness = await startIdentityApi();
    api = http(harness);
  });

  afterAll(async () => {
    await harness?.close();
  });

  const admin = (organizationId: string, tag = 'LA-ADM') =>
    seedPerson(harness.prisma, tag, { organizationId, roles: ['ORGANIZATION_ADMIN'] });
  const member = (organizationId: string, roles = ['OPERATOR'], tag = 'LA-MEM') =>
    seedPerson(harness.prisma, tag, { organizationId, roles });
  /** The token an administrator was given while they were one. */
  const adminToken = (person: Person) => bearerOf(person, ['ORGANIZATION_ADMIN']);
  const rolesOf = async (membershipId: string) =>
    (await membershipRow(harness.prisma, membershipId))?.roles;
  const roleEvents = async (membershipId: string) =>
    (await eventNames(harness.prisma, membershipId)).filter((name) => name.startsWith('ROLE_'));
  const setMembership = (membershipId: string, data: Record<string, unknown>) =>
    runUnscoped('test moves a membership on', () =>
      harness.prisma.client.membership.update({ where: { id: membershipId }, data }),
    );

  it('the control: a live administrator’s token does what it always did', async () => {
    const org = tenants();
    const a = await admin(org.a);
    const c = await member(org.a);

    const promoted = await api.roles(adminToken(a), c.membershipId, ['OPERATOR', 'DRIVER']);

    expect(promoted.status).toBe(200);
    expect(await rolesOf(c.membershipId)).toEqual(['OPERATOR', 'DRIVER']);
  });

  it('a demoted administrator’s old token cannot grant the role back: 403, unchanged, no event', async () => {
    const org = tenants();
    const a = await admin(org.a, 'LA-A');
    const b = await admin(org.a, 'LA-B');
    const before = adminToken(a);

    expect((await api.roles(adminToken(b), a.membershipId, ['OPERATOR'])).status).toBe(200);
    const events = await eventNames(harness.prisma, a.membershipId);
    expect(events).toEqual(['ROLE_ASSIGNED', 'ROLE_REVOKED']);

    // The audit's trigger, exactly: the old token, the person's own membership.
    const regrant = await api.roles(before, a.membershipId, ['OPERATOR', 'ORGANIZATION_ADMIN']);

    expect(regrant.status).toBe(403);
    expect(regrant.body.code).toBe('INSUFFICIENT_ROLE');
    expect(await rolesOf(a.membershipId)).toEqual(['OPERATOR']);
    expect(await eventNames(harness.prisma, a.membershipId)).toEqual(events);
  });

  it('nor anything else an administrator does, with that token: every identity-administration write', async () => {
    const org = tenants();
    const a = await admin(org.a, 'LA-A');
    const b = await admin(org.a, 'LA-B');
    const c = await member(org.a);
    const outsider = await member(org.b, ['OPERATOR'], 'LA-OUT');
    const before = adminToken(a);
    await setMembership(a.membershipId, { roles: ['OPERATOR'] });
    const cBefore = await membershipRow(harness.prisma, c.membershipId);
    const username = `la-new-${id('U').slice(-10)}`.toLowerCase();

    const refused = [
      await api.roles(before, c.membershipId, ['ORGANIZATION_ADMIN']),
      await api.revoke(before, b.membershipId),
      await api.addMembership(before, outsider.userId, org.a, ['ORGANIZATION_ADMIN']),
      await api.createUser(before, `la-${username}`, {
        username,
        email: `${username}@example.test`,
        firstName: 'آزمون',
        lastName: 'تازه',
        organizationId: org.a,
        roles: ['ORGANIZATION_ADMIN'],
      }),
      await api.patchUser(before, c.userId, { firstName: 'دیگر' }),
    ];

    expect(refused.map((response) => [response.status, response.body.code])).toEqual(
      Array(5).fill([403, 'INSUFFICIENT_ROLE']),
    );
    expect(await membershipRow(harness.prisma, c.membershipId)).toEqual(cBefore);
    expect((await membershipRow(harness.prisma, b.membershipId))?.deletedAt).toBeNull();
    expect(await eventNames(harness.prisma, c.membershipId)).toEqual([]);
    expect(await eventNames(harness.prisma, b.membershipId)).toEqual([]);
    expect(await eventNames(harness.prisma, c.userId)).toEqual([]);
    const created = await runUnscoped('test looks for what was not made', async () => ({
      memberships: await harness.prisma.client.membership.count({
        where: { userId: outsider.userId, organizationId: org.a },
      }),
      users: await harness.prisma.client.user.count({ where: { username } }),
      intents: await harness.prisma.client.userProvisioningIntent.count({
        where: { actorId: a.userId },
      }),
      firstName: (await harness.prisma.client.user.findFirst({ where: { id: c.userId } }))
        ?.firstName,
    }));
    expect(created).toEqual({ memberships: 0, users: 0, intents: 0, firstName: 'آزمون' });
  });

  it('revoked, then the old token reinstates itself: 403, no membership, no event', async () => {
    const org = tenants();
    const a = await admin(org.a, 'LA-A');
    const b = await admin(org.a, 'LA-B');
    const before = adminToken(a);

    expect((await api.revoke(adminToken(b), a.membershipId)).status).toBe(204);

    const reinstated = await api.addMembership(before, a.userId, org.a, ['ORGANIZATION_ADMIN']);

    expect(reinstated.status).toBe(403);
    expect(reinstated.body.code).toBe('INSUFFICIENT_ROLE');
    const live = await runUnscoped('test reads every membership of the person', () =>
      harness.prisma.client.membership.findMany({ where: { userId: a.userId } }),
    );
    expect(live.map((m) => [m.id, m.status, m.deletedAt !== null])).toEqual([
      [a.membershipId, 'REVOKED', true],
    ]);
    expect(await eventNames(harness.prisma, a.membershipId)).toEqual(['MEMBERSHIP_REVOKED']);
  });

  it.each([
    ['expired', { validUntil: new Date(Date.now() - 60_000) }],
    ['not yet valid', { validFrom: new Date(Date.now() + 3_600_000) }],
    ['suspended', { status: 'SUSPENDED' }],
  ])(
    'a caller whose membership is %s: the token still names the role, and is refused',
    async (_label, change) => {
      const org = tenants();
      const a = await admin(org.a, 'LA-A');
      const c = await member(org.a);
      const before = adminToken(a);
      await setMembership(a.membershipId, change);

      const regrant = await api.roles(before, a.membershipId, ['ORGANIZATION_ADMIN', 'DRIVER']);
      const promote = await api.roles(before, c.membershipId, ['ORGANIZATION_ADMIN']);

      expect([regrant.status, promote.status]).toEqual([403, 403]);
      expect(await rolesOf(a.membershipId)).toEqual(['ORGANIZATION_ADMIN']);
      expect(await rolesOf(c.membershipId)).toEqual(['OPERATOR']);
      // No role event. (The expiry sweep may record the lapse meanwhile.)
      expect(await roleEvents(a.membershipId)).toEqual([]);
      expect(await roleEvents(c.membershipId)).toEqual([]);
    },
  );

  it('partly demoted — UNION_ADMIN taken away, ORGANIZATION_ADMIN kept: may no longer grant what only the role taken away could', async () => {
    const org = tenants();
    const a = await seedPerson(harness.prisma, 'LA-UA', {
      organizationId: org.a,
      roles: ['UNION_ADMIN', 'ORGANIZATION_ADMIN'],
    });
    const c = await member(org.a);
    const before = bearerOf(a, ['UNION_ADMIN', 'ORGANIZATION_ADMIN']);
    await setMembership(a.membershipId, { roles: ['ORGANIZATION_ADMIN'] });

    const union = await api.roles(before, c.membershipId, ['OPERATOR', 'UNION_ADMIN']);
    const organization = await api.roles(before, c.membershipId, ['OPERATOR', 'DRIVER']);

    expect([union.status, union.body.code]).toEqual([403, 'INSUFFICIENT_ROLE']);
    expect(organization.status).toBe(200);
    expect(await rolesOf(c.membershipId)).toEqual(['OPERATOR', 'DRIVER']);
  });

  it('a caller with no membership at all in the organization the token names: refused', async () => {
    const org = tenants();
    const c = await member(org.a);
    const stranger = { userId: id('USR-LA-NONE'), organizationId: org.a };

    const response = await api.roles(bearerOf(stranger, ['ORGANIZATION_ADMIN']), c.membershipId, [
      'DRIVER',
    ]);

    expect(response.status).toBe(403);
    expect(await rolesOf(c.membershipId)).toEqual(['OPERATOR']);
  });

  it('a registration reviewer demoted since their token: approve and reject both refused, the request still pending', async () => {
    const org = tenants();
    const reviewer = await seedPerson(harness.prisma, 'LA-REV', {
      organizationId: org.a,
      roles: ['UNION_ADMIN'],
    });
    const before = bearerOf(reviewer, ['UNION_ADMIN']);
    const username = `la-reg-${id('R').slice(-10)}`.toLowerCase();
    expect(
      (await api.register(registrationBody(username, `${username}@example.test`, org.a))).status,
    ).toBe(202);
    const listed = await api.listRegistrations(before, { username });
    expect(listed.status).toBe(200);
    const registrationId = (listed.body as { items: { id: string }[] }).items[0]!.id;
    await setMembership(reviewer.membershipId, { roles: ['OPERATOR'] });

    const approved = await api.approve(before, registrationId);
    const rejected = await api.reject(before, registrationId);

    expect([approved.status, rejected.status]).toEqual([403, 403]);
    const request = await runUnscoped('test reads the request', () =>
      harness.prisma.client.registrationRequest.findUniqueOrThrow({
        where: { id: registrationId },
      }),
    );
    expect(request.status).toBe('PENDING');
    expect(await eventNames(harness.prisma, registrationId)).toEqual(['REGISTRATION_SUBMITTED']);
  });

  it('SYSTEM_ADMIN is realm authority, not membership data: its token decides, with no membership', async () => {
    const org = tenants();
    const c = await member(org.a);
    const operator = { userId: id('USR-LA-SYS'), organizationId: org.a };

    const response = await api.roles(bearerOf(operator, ['SYSTEM_ADMIN']), c.membershipId, [
      'OPERATOR',
      'FLEET_MANAGER',
    ]);

    expect(response.status).toBe(200);
    expect(await rolesOf(c.membershipId)).toEqual(['OPERATOR', 'FLEET_MANAGER']);
  });

  it('two administrators demoting each other at once: one wins, the other is refused — never both, never a deadlock', async () => {
    for (let round = 0; round < 8; round += 1) {
      const org = tenants();
      const a = await admin(org.a, 'LA-A');
      const b = await admin(org.a, 'LA-B');

      const [aDemotesB, bDemotesA] = await Promise.all([
        api.roles(adminToken(a), b.membershipId, ['OPERATOR']),
        api.roles(adminToken(b), a.membershipId, ['OPERATOR']),
      ]);

      expect([aDemotesB.status, bDemotesA.status].sort()).toEqual([200, 403]);
      const standing = [await rolesOf(a.membershipId), await rolesOf(b.membershipId)];
      expect(standing).toContainEqual(['ORGANIZATION_ADMIN']);
      expect(standing).toContainEqual(['OPERATOR']);
    }
  });

  describe('the locks', () => {
    /** Holds `userId`'s row lock in a transaction of its own until `release`. */
    async function holdUserLock(userId: string) {
      let release!: () => void;
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const released = new Promise<void>((resolve) => (release = resolve));
      const done = harness.prisma.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 30_000 },
      );
      await isLocked;
      return { release, done };
    }
    /** Sent now: a supertest request goes out only once something awaits it. */
    const sent = <T>(call: PromiseLike<T>): Promise<T> => Promise.resolve(call);
    const settledWithin = async (promise: Promise<unknown>, ms: number) =>
      Promise.race([
        promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);

    it('a membership creation waits on the user’s lock, as every other membership change does — before it reads anything', async () => {
      const org = tenants();
      const a = await admin(org.a);
      const target = await member(org.b, ['OPERATOR'], 'LA-TGT');
      const held = await holdUserLock(target.userId);

      const adding = sent(api.addMembership(adminToken(a), target.userId, org.a, ['DRIVER']));

      expect(await settledWithin(adding, 500)).toBe(false);
      // Waiting at the user lock itself, not further on: the foreign key of
      // the membership insert would wait on the held row too, but only after
      // the decisions before it were made without the lock.
      const waiting = await harness.prisma.client.$queryRaw<Array<{ query: string }>>`
        SELECT query FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      expect(waiting.map((row) => row.query)).toEqual([
        expect.stringMatching(/FROM "user" WHERE id = \$1 FOR UPDATE/),
      ]);
      held.release();
      await held.done;
      expect((await adding).status).toBe(201);
    });

    it('the caller’s row is not locked against the caller: one administrator’s writes on two users run side by side', async () => {
      const org = tenants();
      const a = await admin(org.a);
      const x = await member(org.a, ['OPERATOR'], 'LA-X');
      const y = await member(org.a, ['OPERATOR'], 'LA-Y');
      const held = await holdUserLock(x.userId);

      const onX = sent(api.roles(adminToken(a), x.membershipId, ['DRIVER']));
      const onY = await api.roles(adminToken(a), y.membershipId, ['DRIVER']);

      expect(onY.status).toBe(200);
      held.release();
      await held.done;
      expect((await onX).status).toBe(200);
    });

    it('a demotion of the caller waits for the caller’s write in flight, and the write then decided on what held', async () => {
      const org = tenants();
      const a = await admin(org.a, 'LA-A');
      const b = await admin(org.a, 'LA-B');
      const x = await member(org.a, ['OPERATOR'], 'LA-X');
      // A's write on X waits on X's lock, holding A's own row KEY SHARE —
      // A's lock first: `USR-LA-A-…` sorts before `USR-LA-X-…`.
      const held = await holdUserLock(x.userId);
      const aOnX = sent(api.roles(adminToken(a), x.membershipId, ['DRIVER']));
      await new Promise((resolve) => setTimeout(resolve, 200));

      // B demoting A needs A's row FOR UPDATE: it waits for A's write.
      const bOnA = sent(api.roles(adminToken(b), a.membershipId, ['OPERATOR']));
      expect(await settledWithin(bOnA, 500)).toBe(false);

      held.release();
      await held.done;
      expect((await aOnX).status).toBe(200);
      expect((await bOnA).status).toBe(200);
      expect(await rolesOf(x.membershipId)).toEqual(['DRIVER']);
      expect(await rolesOf(a.membershipId)).toEqual(['OPERATOR']);
    });
  });
});
