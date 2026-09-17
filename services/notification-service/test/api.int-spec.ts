import request from 'supertest';
import { ulid } from 'ulid';
import { cleanup, newOrganizationId, newUserId } from './helpers';
import {
  internalToken,
  rowById,
  seedNotification,
  startApi,
  userToken,
  type ApiHarness,
} from './api-helpers';
import { encodeCursor } from '../src/api/notification.cursor';

/**
 * The read API against the real application and the real database.
 *
 * Every assertion selects by this run's organization and user ids and never
 * by a global count: the database is shared with every other suite in the
 * run, and the CI lesson of NTF-001 is that a count is a claim about rows one
 * does not own.
 */
describe('notification read API (real application)', () => {
  let api: ApiHarness;
  const organizations: string[] = [];

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  beforeAll(async () => {
    api = await startApi();
  }, 120_000);

  afterAll(async () => {
    await cleanup(api.prisma, organizations);
    await api.close();
  }, 120_000);

  const get = (path: string, token: string) =>
    request(api.server).get(path).set('authorization', `Bearer ${token}`);
  const post = (path: string, token: string) =>
    request(api.server).post(path).set('authorization', `Bearer ${token}`);

  // -------------------------------------------------------------------------
  // Given/When/Then rows of the plan (§ 3)
  // -------------------------------------------------------------------------

  it('lists only the caller’s own rows in the selected organization, newest first, with a cursor', async () => {
    const org = organization();
    const me = newUserId();
    const colleague = newUserId();
    const base = Date.now() - 60_000;
    const mine = [];
    for (let i = 0; i < 5; i += 1) {
      mine.push(
        await seedNotification(api.prisma, {
          organizationId: org,
          userId: me,
          createdAt: new Date(base + i * 1000),
        }),
      );
    }
    await seedNotification(api.prisma, {
      organizationId: org,
      userId: colleague,
      title: 'COLLEAGUE ROW',
    });

    const first = await get('/v1/notifications?limit=2', userToken(me, org));
    expect(first.status).toBe(200);
    expect(first.body.items.map((i: { id: string }) => i.id)).toEqual([mine[4]!.id, mine[3]!.id]);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.items[0].state).toBe('UNREAD');

    const second = await get(
      `/v1/notifications?limit=2&cursor=${first.body.nextCursor}`,
      userToken(me, org),
    );
    expect(second.status).toBe(200);
    expect(second.body.items.map((i: { id: string }) => i.id)).toEqual([mine[2]!.id, mine[1]!.id]);

    const third = await get(
      `/v1/notifications?limit=2&cursor=${second.body.nextCursor}`,
      userToken(me, org),
    );
    expect(third.body.items.map((i: { id: string }) => i.id)).toEqual([mine[0]!.id]);
    expect(third.body.hasMore).toBe(false);
    expect(third.body.nextCursor).toBeNull();

    // The colleague's row is absent from every page — asserted on the bodies.
    const all = [...first.body.items, ...second.body.items, ...third.body.items];
    expect(all.some((i: { title: string }) => i.title === 'COLLEAGUE ROW')).toBe(false);
    expect(all).toHaveLength(5);
  });

  it('marks read idempotently: the second call answers 200 with the original readAt and no second change', async () => {
    const org = organization();
    const me = newUserId();
    const { id } = await seedNotification(api.prisma, { organizationId: org, userId: me });

    const first = await post(`/v1/notifications/${id}/read`, userToken(me, org));
    expect(first.status).toBe(200);
    expect(first.body.state).toBe('READ');
    expect(first.body.readAt).toEqual(expect.any(String));
    expect(first.body.dismissedAt).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await post(`/v1/notifications/${id}/read`, userToken(me, org));
    expect(second.status).toBe(200);
    expect(second.body.readAt).toBe(first.body.readAt);

    const stored = await rowById(api.prisma, id);
    expect(stored!.readAt!.toISOString()).toBe(first.body.readAt);
  });

  it('answers 404 for another person’s row, in this organization or any other, exactly like a missing id', async () => {
    const org = organization();
    const other = organization();
    const me = newUserId();
    const colleague = newUserId();
    const stranger = newUserId();
    const { id: colleagueRow } = await seedNotification(api.prisma, {
      organizationId: org,
      userId: colleague,
    });
    const { id: strangerRow } = await seedNotification(api.prisma, {
      organizationId: other,
      userId: stranger,
    });
    const missing = `NTN_${ulid()}`;

    const shapes = new Set<string>();
    for (const target of [colleagueRow, strangerRow, missing]) {
      for (const call of [
        () => get(`/v1/notifications/${target}`, userToken(me, org)),
        () => post(`/v1/notifications/${target}/read`, userToken(me, org)),
        () => post(`/v1/notifications/${target}/dismiss`, userToken(me, org)),
      ]) {
        const response = await call();
        expect(response.status).toBe(404);
        expect(response.body.code).toBe('NOT_FOUND');
        // Identical shape: the same keys and the same message, whatever the
        // reason. Only the per-request fields — correlation id, timestamp and
        // the path that names the id asked for — differ.
        const { correlationId: _c, timestamp: _t, path: _p, ...rest } = response.body;
        shapes.add(JSON.stringify({ keys: Object.keys(response.body).sort(), rest }));
      }
    }
    expect(shapes.size).toBe(1);

    // Nothing moved on the rows the caller could not see.
    expect((await rowById(api.prisma, colleagueRow))!.readAt).toBeNull();
    expect((await rowById(api.prisma, strangerRow))!.readAt).toBeNull();
  });

  it('dismisses an unread row: both readAt and dismissedAt are set, the row is not deleted', async () => {
    const org = organization();
    const me = newUserId();
    const { id } = await seedNotification(api.prisma, { organizationId: org, userId: me });

    const response = await post(`/v1/notifications/${id}/dismiss`, userToken(me, org));
    expect(response.status).toBe(200);
    expect(response.body.state).toBe('DISMISSED');
    expect(response.body.readAt).toEqual(expect.any(String));
    expect(response.body.dismissedAt).toBe(response.body.readAt);

    const stored = await rowById(api.prisma, id);
    expect(stored).not.toBeNull();
    expect(stored!.dismissedAt).not.toBeNull();

    // Out of the inbox, still readable, still there under the archive filter.
    const inbox = await get('/v1/notifications', userToken(me, org));
    expect(inbox.body.items.map((i: { id: string }) => i.id)).not.toContain(id);
    const archive = await get('/v1/notifications?state=DISMISSED', userToken(me, org));
    expect(archive.body.items.map((i: { id: string }) => i.id)).toContain(id);
    expect((await get(`/v1/notifications/${id}`, userToken(me, org))).status).toBe(200);

    // Idempotent, and the original readAt of an already-read row survives.
    const again = await post(`/v1/notifications/${id}/dismiss`, userToken(me, org));
    expect(again.body.dismissedAt).toBe(response.body.dismissedAt);
    expect(again.body.readAt).toBe(response.body.readAt);
  });

  // -------------------------------------------------------------------------
  // The rest of the surface
  // -------------------------------------------------------------------------

  it('filters by state and hides expired rows everywhere', async () => {
    const org = organization();
    const me = newUserId();
    const unread = await seedNotification(api.prisma, { organizationId: org, userId: me });
    const read = await seedNotification(api.prisma, {
      organizationId: org,
      userId: me,
      readAt: new Date(),
    });
    const dismissed = await seedNotification(api.prisma, {
      organizationId: org,
      userId: me,
      readAt: new Date(),
      dismissedAt: new Date(),
    });
    const expired = await seedNotification(api.prisma, {
      organizationId: org,
      userId: me,
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      expiresAt: new Date(Date.now() - 86_400_000),
    });

    const ids = (response: request.Response) =>
      response.body.items.map((i: { id: string }) => i.id).sort();
    expect(ids(await get('/v1/notifications', userToken(me, org)))).toEqual(
      [unread.id, read.id].sort(),
    );
    expect(ids(await get('/v1/notifications?state=UNREAD', userToken(me, org)))).toEqual([
      unread.id,
    ]);
    expect(ids(await get('/v1/notifications?state=READ', userToken(me, org)))).toEqual([read.id]);
    expect(ids(await get('/v1/notifications?state=DISMISSED', userToken(me, org)))).toEqual([
      dismissed.id,
    ]);
    expect((await get(`/v1/notifications/${expired.id}`, userToken(me, org))).status).toBe(404);
    expect((await post(`/v1/notifications/${expired.id}/read`, userToken(me, org))).status).toBe(
      404,
    );
  });

  it('counts unread rows and caps the badge at 99', async () => {
    const org = organization();
    const me = newUserId();
    for (let i = 0; i < 3; i += 1)
      await seedNotification(api.prisma, { organizationId: org, userId: me });
    await seedNotification(api.prisma, { organizationId: org, userId: me, readAt: new Date() });

    const count = await get('/v1/notifications/unread-count', userToken(me, org));
    expect(count.status).toBe(200);
    expect(count.body).toEqual({ count: 3, capped: false });

    // The cap: a hundred more rows answer 99 and say so.
    const busy = newUserId();
    for (let i = 0; i < 100; i += 1)
      await seedNotification(api.prisma, { organizationId: org, userId: busy });
    const capped = await get('/v1/notifications/unread-count', userToken(busy, org));
    expect(capped.body).toEqual({ count: 99, capped: true });
  }, 120_000);

  it('read-all changes only the caller’s rows in the current organization, asserted on the rows', async () => {
    const org = organization();
    const elsewhere = organization();
    const me = newUserId();
    const colleague = newUserId();
    const mine = [
      await seedNotification(api.prisma, { organizationId: org, userId: me }),
      await seedNotification(api.prisma, { organizationId: org, userId: me }),
    ];
    const alreadyRead = await seedNotification(api.prisma, {
      organizationId: org,
      userId: me,
      readAt: new Date(),
    });
    const colleagues = await seedNotification(api.prisma, {
      organizationId: org,
      userId: colleague,
    });
    // The same human, a different organization: untouched under this hat.
    const mineElsewhere = await seedNotification(api.prisma, {
      organizationId: elsewhere,
      userId: me,
    });

    const response = await post(
      '/v1/notifications/read-all',
      userToken(me, org, ['FLEET_MANAGER'], [org, elsewhere]),
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ updated: 2 });

    for (const { id } of mine) expect((await rowById(api.prisma, id))!.readAt).not.toBeNull();
    expect((await rowById(api.prisma, alreadyRead.id))!.readAt).not.toBeNull();
    expect((await rowById(api.prisma, colleagues.id))!.readAt).toBeNull();
    expect((await rowById(api.prisma, mineElsewhere.id))!.readAt).toBeNull();

    const again = await post('/v1/notifications/read-all', userToken(me, org));
    expect(again.body).toEqual({ updated: 0 });
  });

  it('shows the same human only the active organization’s rows, and a switch shows the other', async () => {
    const a = organization();
    const b = organization();
    const me = newUserId();
    const inA = await seedNotification(api.prisma, { organizationId: a, userId: me });
    const inB = await seedNotification(api.prisma, { organizationId: b, userId: me });

    const underA = await get('/v1/notifications', userToken(me, a, ['FLEET_MANAGER'], [a, b]));
    expect(underA.body.items.map((i: { id: string }) => i.id)).toEqual([inA.id]);

    const underB = await request(api.server)
      .get('/v1/notifications')
      .set('authorization', `Bearer ${userToken(me, a, ['FLEET_MANAGER'], [a, b])}`)
      .set('x-organization-id', b);
    expect(underB.body.items.map((i: { id: string }) => i.id)).toEqual([inB.id]);

    // A tenant the token does not belong to is refused, never resolved.
    const stranger = await request(api.server)
      .get('/v1/notifications')
      .set('authorization', `Bearer ${userToken(me, a)}`)
      .set('x-organization-id', b);
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe('TENANT_MISMATCH');
  });

  it('publishes no address, no owner and no sensitive key in any body', async () => {
    const org = organization();
    const me = newUserId();
    const { id } = await seedNotification(api.prisma, { organizationId: org, userId: me });

    const bodies = [
      (await get('/v1/notifications', userToken(me, org))).body,
      (await get(`/v1/notifications/${id}`, userToken(me, org))).body,
      (await post(`/v1/notifications/${id}/read`, userToken(me, org))).body,
      (await get('/v1/notifications/unread-count', userToken(me, org))).body,
    ];
    const text = JSON.stringify(bodies);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    for (const key of [
      'userId',
      'organizationId',
      'email',
      'phone',
      'deliveryId',
      'intentId',
      'token',
      'password',
    ]) {
      expect(text).not.toContain(`"${key}"`);
    }
    expect(text).not.toContain(me);
    expect(text).not.toContain(org);
  });

  // -------------------------------------------------------------------------
  // Cursor
  // -------------------------------------------------------------------------

  it('keeps the order stable across pages and refuses an edited cursor as VALIDATION_FAILED', async () => {
    const org = organization();
    const me = newUserId();
    const same = new Date(Date.now() - 30_000);
    // Three rows with the *same* createdAt: only the id tie-breaker orders them.
    const rows = [];
    for (let i = 0; i < 3; i += 1)
      rows.push(
        await seedNotification(api.prisma, { organizationId: org, userId: me, createdAt: same }),
      );
    const expected = rows
      .map((r) => r.id)
      .sort()
      .reverse();

    const page1 = await get('/v1/notifications?limit=2', userToken(me, org));
    const page2 = await get(
      `/v1/notifications?limit=2&cursor=${page1.body.nextCursor}`,
      userToken(me, org),
    );
    expect([...page1.body.items, ...page2.body.items].map((i: { id: string }) => i.id)).toEqual(
      expected,
    );

    for (const bad of [
      'garbage',
      `${page1.body.nextCursor}x`,
      Buffer.from('{"c":"2026-01-01T00:00:00Z"}').toString('base64url'),
    ]) {
      const response = await get(
        `/v1/notifications?cursor=${encodeURIComponent(bad)}`,
        userToken(me, org),
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('applies a cursor lifted from another person’s page inside the caller’s own inbox only', async () => {
    const org = organization();
    const me = newUserId();
    const other = newUserId();
    const mine = await seedNotification(api.prisma, {
      organizationId: org,
      userId: me,
      createdAt: new Date(Date.now() - 10_000),
    });
    const theirs = await seedNotification(api.prisma, {
      organizationId: org,
      userId: other,
      createdAt: new Date(),
    });

    // A cursor positioned at the other person's newest row: paging "after" it
    // shows the caller's own older rows, and never the other person's.
    const forged = encodeCursor({ createdAt: new Date(), id: theirs.id });
    const response = await get(`/v1/notifications?cursor=${forged}`, userToken(me, org));
    expect(response.status).toBe(200);
    expect(response.body.items.map((i: { id: string }) => i.id)).toEqual([mine.id]);
  });

  // -------------------------------------------------------------------------
  // Validation and closed-by-default
  // -------------------------------------------------------------------------

  it('refuses a limit above 200, a non-integer limit, an unknown parameter and a malformed id with VALIDATION_FAILED', async () => {
    const org = organization();
    const me = newUserId();
    for (const path of [
      '/v1/notifications?limit=201',
      '/v1/notifications?limit=0',
      '/v1/notifications?limit=ten',
      '/v1/notifications?state=unread',
      `/v1/notifications?organizationId=${org}`,
      '/v1/notifications/not%20an%20id',
    ]) {
      const response = await get(path, userToken(me, org));
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    }
    expect(
      (await post('/v1/notifications/read-all?organizationId=x', userToken(me, org))).status,
    ).toBe(400);
  });

  it('is closed by default: anonymous 401, service tokens 403, relay 401, no active organization 403', async () => {
    const org = organization();
    for (const path of [
      '/v1/notifications',
      '/v1/notifications/unread-count',
      `/v1/notifications/NTN_${ulid()}`,
    ]) {
      expect((await request(api.server).get(path)).status).toBe(401);
      expect(
        (await request(api.server).get(path).set('authorization', 'Bearer not-a-token')).status,
      ).toBe(401);
    }
    expect((await request(api.server).post('/v1/notifications/read-all')).status).toBe(401);

    // A service token — any caller, tenant claim or not — is refused: no
    // endpoint here carries @AllowService.
    for (const token of [
      await internalToken('marketplace-service', 'SERVICE', org),
      await internalToken('identity-service', 'SERVICE'),
      await internalToken('notification-service', 'SERVICE', org),
    ]) {
      const response = await request(api.server)
        .get('/v1/notifications')
        .set('x-internal-token', token);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    }
    const relay = await request(api.server)
      .get('/v1/notifications')
      .set('x-internal-token', await internalToken('api-gateway', 'RELAY'));
    expect(relay.status).toBe(401);

    const homeless = await get('/v1/notifications', userToken(newUserId(), undefined));
    expect(homeless.status).toBe(403);
    expect(homeless.body.code).toBe('FORBIDDEN');
  });

  it('lets every role — AUDITOR included — read its own inbox and nobody else’s', async () => {
    const org = organization();
    for (const role of [
      'AUDITOR',
      'DRIVER',
      'SUPPLIER',
      'SYSTEM_ADMIN',
      'UNION_ADMIN',
      'ORGANIZATION_ADMIN',
    ]) {
      const me = newUserId();
      const other = newUserId();
      const mine = await seedNotification(api.prisma, { organizationId: org, userId: me });
      await seedNotification(api.prisma, { organizationId: org, userId: other });

      const response = await get('/v1/notifications', userToken(me, org, [role]));
      expect(response.status).toBe(200);
      expect(response.body.items.map((i: { id: string }) => i.id)).toEqual([mine.id]);
    }
  });

  it('has no DELETE and no administrative route', async () => {
    const org = organization();
    const me = newUserId();
    const { id } = await seedNotification(api.prisma, { organizationId: org, userId: me });
    expect(
      (
        await request(api.server)
          .delete(`/v1/notifications/${id}`)
          .set('authorization', `Bearer ${userToken(me, org)}`)
      ).status,
    ).toBe(404);
    expect(
      (await get(`/v1/notifications?userId=${newUserId()}`, userToken(me, org, ['SYSTEM_ADMIN'])))
        .status,
    ).toBe(400);
    expect(await rowById(api.prisma, id)).not.toBeNull();
  });

  it('is the gateway’s `notifications` prefix: no role restriction and no idempotency key requirement', () => {
    // The gateway's route table is configuration in another service; asserted
    // here by reading it as text, because importing it would cross a service
    // boundary (AGENTS.md A-02). `api-gateway`'s own spec asserts the same row.
    const routes = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'api-gateway', 'src', 'config', 'routes.ts'),
      'utf8',
    ) as string;
    expect(routes).toMatch(/\{ prefix: 'notifications', service: 'notification' \}/);
  });
});
