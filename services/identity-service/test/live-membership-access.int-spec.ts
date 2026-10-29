import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { IdentityRepository } from '../src/identity/identity.repository';
import { serviceToken, startIdentityApi, type IdentityApiHarness } from './api-helpers';
import {
  addMembershipRow,
  bearerOf,
  eventNames,
  http,
  seedPerson,
  type MembershipSpec,
  type Person,
} from './identity-fixtures';
import { tenants } from './helpers';

/**
 * A membership proves access to a person only while it is live (task 117,
 * audit F3).
 *
 * `GET /v1/users/:id` and `PATCH /v1/users/:id` reached another person through
 * any undeleted membership in the caller's organization — expired, not yet
 * begun or suspended included — so a former member's email and phone stayed
 * readable, and their global profile editable, long after they left. And
 * `GET /v1/users` listed them. Now each decision uses the live predicate
 * (`liveMembershipWhere`: `ACTIVE`, not revoked, inside `[validFrom,
 * validUntil)`) on the database's clock, the list filters in SQL before the
 * page is cut, and the profile edit decides inside its write transaction.
 * Unchanged: a person's own profile, and notification-service's service access
 * to the list.
 */
describe('a membership proves access to a person only while it is live (task 117, F3)', () => {
  let harness: IdentityApiHarness;
  let api: ReturnType<typeof http>;

  beforeAll(async () => {
    harness = await startIdentityApi();
    api = http(harness);
  });

  afterAll(async () => {
    await harness?.close();
  });

  const HOUR = 3_600_000;
  const NOT_LIVE: Array<[string, (organizationId: string) => MembershipSpec]> = [
    [
      'expired',
      (organizationId) => ({
        organizationId,
        roles: ['OPERATOR'],
        validUntil: new Date(Date.now() - HOUR),
      }),
    ],
    [
      'not yet valid',
      (organizationId) => ({
        organizationId,
        roles: ['OPERATOR'],
        validFrom: new Date(Date.now() + HOUR),
      }),
    ],
    [
      'suspended',
      (organizationId) => ({ organizationId, roles: ['OPERATOR'], status: 'SUSPENDED' }),
    ],
    [
      'revoked',
      (organizationId) => ({
        organizationId,
        roles: ['OPERATOR'],
        status: 'REVOKED',
        deletedAt: new Date(Date.now() - HOUR),
      }),
    ],
  ];

  async function organization() {
    const org = tenants();
    const admin = await seedPerson(harness.prisma, 'LM-ADM', {
      organizationId: org.a,
      roles: ['ORGANIZATION_ADMIN'],
    });
    return { org, admin, bearer: bearerOf(admin, ['ORGANIZATION_ADMIN']) };
  }
  const profile = (userId: string) =>
    runUnscoped('test reads the profile', () =>
      harness.prisma.client.user.findFirstOrThrow({ where: { id: userId } }),
    );

  it('the control: a live member is read and edited', async () => {
    const { org, bearer } = await organization();
    const target = await seedPerson(harness.prisma, 'LM-T', {
      organizationId: org.a,
      roles: ['OPERATOR'],
    });

    const read = await api.getUser(bearer, target.userId);
    const edited = await api.patchUser(bearer, target.userId, { firstName: 'تازه' });

    expect([read.status, edited.status]).toEqual([200, 200]);
    expect(read.body).toMatchObject({ email: target.email, phone: '09120000000' });
    expect((await profile(target.userId)).firstName).toBe('تازه');
  });

  it.each(NOT_LIVE)(
    'a membership that is %s: 404 on read and on edit, the profile unchanged, no event',
    async (_label, spec) => {
      const { org, bearer } = await organization();
      const target = await seedPerson(harness.prisma, 'LM-T', spec(org.a));
      const before = await profile(target.userId);

      const read = await api.getUser(bearer, target.userId);
      const edited = await api.patchUser(bearer, target.userId, { firstName: 'دیگر' });

      expect([read.status, read.body.code]).toEqual([404, 'NOT_FOUND']);
      expect([edited.status, edited.body.code]).toEqual([404, 'NOT_FOUND']);
      expect(JSON.stringify(read.body)).not.toContain(target.email);
      expect(await profile(target.userId)).toEqual(before);
      expect(await eventNames(harness.prisma, target.userId)).toEqual([]);
    },
  );

  it('another organization’s live member: 404, as before', async () => {
    const { org, bearer } = await organization();
    const target = await seedPerson(harness.prisma, 'LM-T', {
      organizationId: org.b,
      roles: ['OPERATOR'],
    });

    expect((await api.getUser(bearer, target.userId)).status).toBe(404);
    expect((await api.patchUser(bearer, target.userId, { firstName: 'دیگر' })).status).toBe(404);
  });

  it('the person’s own profile is theirs whatever became of their membership', async () => {
    const org = tenants();
    const self = await seedPerson(harness.prisma, 'LM-SELF', {
      organizationId: org.a,
      roles: ['OPERATOR'],
      validUntil: new Date(Date.now() - HOUR),
    });
    const bearer = bearerOf(self, ['OPERATOR']);

    expect((await api.getUser(bearer, self.userId)).status).toBe(200);
    expect((await api.patchUser(bearer, self.userId, { firstName: 'خودم' })).status).toBe(200);
  });

  describe('the user list', () => {
    /** One organization: the admin, then four people whose membership is not live, then one who is. */
    async function listed() {
      const { org, admin, bearer } = await organization();
      const gone: Person[] = [];
      for (const [, spec] of NOT_LIVE)
        gone.push(await seedPerson(harness.prisma, 'LM-G', spec(org.a)));
      const live = await seedPerson(harness.prisma, 'LM-L', {
        organizationId: org.a,
        roles: ['OPERATOR'],
      });
      return { org, admin, bearer, gone, live };
    }
    const ids = (body: { items: { id: string }[] }) => body.items.map((item) => item.id);

    it('lists live members only, and cuts the page after filtering: no page is filtered empty', async () => {
      const { admin, bearer, live } = await listed();

      // Ordered by membership id: the four not-live rows lie between the two
      // live ones, so a filter after the cut would have answered
      // [admin, expired] and a cursor walking into nothing.
      const page = await api.listUsers(bearer, { limit: '2' });

      expect(page.status).toBe(200);
      expect(ids(page.body)).toEqual([admin.userId, live.userId]);
      expect(page.body).toMatchObject({ hasMore: false, nextCursor: null });
    });

    it('follows the cursor through to the end without an empty page', async () => {
      const { admin, bearer, live } = await listed();

      const first = await api.listUsers(bearer, { limit: '1' });
      expect(ids(first.body)).toEqual([admin.userId]);
      expect(first.body.hasMore).toBe(true);
      const second = await api.listUsers(bearer, { limit: '1', cursor: first.body.nextCursor });
      expect(ids(second.body)).toEqual([live.userId]);
      expect(second.body).toMatchObject({ hasMore: false, nextCursor: null });
    });

    it('a search is filtered before the cut too', async () => {
      const { bearer, live } = await listed();

      const page = await api.listUsers(bearer, { limit: '1', q: live.username });

      expect(ids(page.body)).toEqual([live.userId]);
      expect(page.body.hasMore).toBe(false);
    });

    it('notification-service still lists the organization’s members, live ones only', async () => {
      const { org, admin, live } = await listed();
      const token = await serviceToken('notification-service', org.a);

      const page = await request(harness.app.getHttpServer())
        .get('/v1/users')
        .query({ limit: '10' })
        .set('x-internal-token', token);

      expect(page.status).toBe(200);
      expect(ids(page.body)).toEqual([admin.userId, live.userId]);
    });
  });

  describe('the window’s end is exclusive, on the clock the decision is made on', () => {
    it('at exactly validUntil the membership proves nothing; a millisecond before, it does', async () => {
      const org = tenants();
      const validUntil = new Date(Date.now() + HOUR);
      const person = await seedPerson(harness.prisma, 'LM-EDGE', {
        organizationId: org.a,
        roles: ['ORGANIZATION_ADMIN'],
        validUntil,
      });
      const repository = harness.moduleRef.get(IdentityRepository);
      const before = new Date(validUntil.getTime() - 1);

      const atEnd = await repository.findLiveMembership(person.userId, org.a, validUntil);
      const justBefore = await repository.findLiveMembership(person.userId, org.a, before);
      const rolesAtEnd = await repository.transaction((tx) =>
        repository.findLiveRoles(tx, person.userId, org.a, validUntil),
      );
      const rolesBefore = await repository.transaction((tx) =>
        repository.findLiveRoles(tx, person.userId, org.a, before),
      );

      expect(atEnd).toBeNull();
      expect(justBefore?.id).toBe(person.membershipId);
      expect(rolesAtEnd).toBeNull();
      expect(rolesBefore).toEqual(['ORGANIZATION_ADMIN']);
    });

    it('the same at validFrom: from that instant on, and not before', async () => {
      const org = tenants();
      const validFrom = new Date(Date.now() + HOUR);
      const person = await seedPerson(harness.prisma, 'LM-EDGE', {
        organizationId: org.a,
        roles: ['OPERATOR'],
        validFrom,
      });
      // A second, live membership elsewhere does not lend the first anything.
      await addMembershipRow(harness.prisma, person.userId, {
        organizationId: org.b,
        roles: ['OPERATOR'],
      });
      const repository = harness.moduleRef.get(IdentityRepository);

      expect(await repository.findLiveMembership(person.userId, org.a, validFrom)).not.toBeNull();
      expect(
        await repository.findLiveMembership(
          person.userId,
          org.a,
          new Date(validFrom.getTime() - 1),
        ),
      ).toBeNull();
    });
  });
});
