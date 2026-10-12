import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  auditor,
  internalToken,
  person,
  startApi,
  systemAdminOf,
  type ApiHarness,
} from './api-helpers';
import {
  bare,
  contractRow,
  http,
  idemKey,
  milestoneRows,
  reasons,
  seedSigned,
} from './amendment-helpers';
import { cleanup, eventsOf, seedDraft, wire, type Wiring } from './helpers';

/**
 * CON-003 PR 3 (ADR-068 § 9, Q-100): the planned milestones of a SIGNED contract, from the real
 * `AppModule` over real guards and a real database. The employer plans and edits them while no
 * statement refers to them; both parties read; the planned day is a date, never an instant.
 */
describe('milestones of a signed contract', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const signed = () => seedSigned(api, w, organizations);
  const body = (overrides: Record<string, unknown> = {}) => ({
    title: 'Foundation complete',
    plannedDate: '2026-12-01',
    ...overrides,
  });
  const plan = (
    contractId: string,
    token: string | undefined,
    payload: object = body(),
    key = idemKey('mls'),
  ) => {
    const r = http(api).post(`/v1/contracts/${contractId}/milestones`).set('idempotency-key', key);
    if (token) r.set('authorization', `Bearer ${token}`);
    return r.send(payload);
  };
  const change = (
    contractId: string,
    milestoneId: string,
    token: string | undefined,
    payload: object,
    key = idemKey('mls-patch'),
  ) => {
    const r = http(api)
      .patch(`/v1/contracts/${contractId}/milestones/${milestoneId}`)
      .set('idempotency-key', key);
    if (token) r.set('authorization', `Bearer ${token}`);
    return r.send(payload);
  };
  const read = (contractId: string, milestoneId: string, token: string) =>
    http(api)
      .get(`/v1/contracts/${contractId}/milestones/${milestoneId}`)
      .set('authorization', `Bearer ${token}`);
  const list = (contractId: string, token: string) =>
    http(api).get(`/v1/contracts/${contractId}/milestones`).set('authorization', `Bearer ${token}`);
  const refusedEvents = (employer: string) =>
    eventsOf(w.prisma, employer, 'CONTRACT_AUTHORITY_REFUSED');
  /** What only a statement (PR 4) does: marks the milestone as referenced. */
  const reference = (id: string) =>
    runUnscoped('the suite stands in for the statement of PR 4', () =>
      w.prisma.client.milestone.updateMany({
        where: { id },
        data: { firstReferencedAt: new Date() },
      }),
    );

  beforeAll(async () => {
    api = await startApi({ CONTRACT_MILESTONE_LIMIT: '3' });
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  describe('POST /v1/contracts/{id}/milestones', () => {
    it('the employer plans one: a date, not an instant, with its event and no free text on the topic', async () => {
      const c = await signed();
      const res = await plan(c.id, c.employerToken, body({ plannedShareBp: 2500 })).expect(201);
      expect(res.body).toMatchObject({
        contractId: c.id,
        organizationId: c.employer,
        title: 'Foundation complete',
        plannedDate: '2026-12-01',
        plannedShareBp: 2500,
        referenced: false,
        version: 1,
      });
      expect(res.body.id).toMatch(/^MLS_/);

      const [row] = await milestoneRows(w, c.id);
      expect(row!.plannedDate.toISOString()).toBe('2026-12-01T00:00:00.000Z');
      expect(row!.firstReferencedAt).toBeNull();

      const events = await eventsOf(w.prisma, c.employer, 'CONTRACT_MILESTONE_PLANNED');
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({
        contractId: c.id,
        milestoneId: res.body.id,
        organizationId: c.employer,
        contractorOrganizationId: c.contractor,
        plannedBy: expect.any(String),
        plannedAt: expect.any(String),
      });
      const text = JSON.stringify(events);
      expect(text).not.toContain('Foundation');
      expect(text).not.toContain('2026-12-01');
      expect(text).not.toContain('2500');
    });

    it('the share is optional, and a day is exact whatever the time zone: the calendar edges and a leap day', async () => {
      const c = await signed();
      for (const plannedDate of ['2028-02-29', '2026-12-31', '2027-01-01']) {
        const res = await plan(c.id, c.employerToken, body({ plannedDate })).expect(201);
        expect(res.body.plannedDate).toBe(plannedDate);
        expect(res.body.plannedShareBp).toBeNull();
      }
    });

    it('refuses a planned day that is not a calendar date, or is an instant (400)', async () => {
      const c = await signed();
      for (const plannedDate of [
        '2026-02-29',
        '2026-13-01',
        '2026-12-01T00:00:00.000Z',
        '2026-12-01T20:30:00+03:30',
        '0001-01-01',
        '',
      ]) {
        await plan(c.id, c.employerToken, body({ plannedDate })).expect(400);
      }
      await plan(c.id, c.employerToken, { title: 'No day' }).expect(400);
      expect(await milestoneRows(w, c.id)).toEqual([]);
    });

    it('refuses a share outside 1 to 10000 basis points, a title that is blank, too long or bidi-unsafe, and any field it does not publish', async () => {
      const c = await signed();
      for (const plannedShareBp of [0, -1, 10_001, 12.5, '2500']) {
        await plan(c.id, c.employerToken, body({ plannedShareBp })).expect(400);
      }
      for (const title of ['', '   ', 'x'.repeat(201), 'a‮b', 'a؜b']) {
        await plan(c.id, c.employerToken, body({ title })).expect(400);
      }
      for (const extra of ['contractId', 'createdBy', 'firstReferencedAt', 'version', 'status']) {
        await plan(c.id, c.employerToken, body({ [extra]: 'x' })).expect(400);
      }
      await plan(c.id, c.employerToken, body({ plannedShareBp: 1 })).expect(201);
      await plan(c.id, c.employerToken, body({ plannedShareBp: 10_000 })).expect(201);
    });

    it('keeps Persian titles intact, with the zero-width non-joiner', async () => {
      const c = await signed();
      const title = 'تحویل فونداسیون می‌شود';
      const res = await plan(c.id, c.employerToken, body({ title })).expect(201);
      expect(res.body.title).toBe(title);
    });

    it('keeps no sum of the shares: no document defines one (Q-100)', async () => {
      const c = await signed();
      await plan(c.id, c.employerToken, body({ plannedShareBp: 7000 })).expect(201);
      await plan(c.id, c.employerToken, body({ plannedShareBp: 7000 })).expect(201);
      expect((await milestoneRows(w, c.id)).length).toBe(2);
    });

    it('a contract holds at most CONTRACT_MILESTONE_LIMIT: the next is 422 MILESTONE_LIMIT_REACHED', async () => {
      const c = await signed();
      for (let n = 0; n < 3; n += 1) await plan(c.id, c.employerToken).expect(201);
      const res = await plan(c.id, c.employerToken).expect(422);
      expect(reasons(res.body)).toEqual(['milestone:MILESTONE_LIMIT_REACHED']);
      expect(await milestoneRows(w, c.id)).toHaveLength(3);
    });

    it('only a SIGNED contract: a draft is 422 CONTRACT_NOT_SIGNED', async () => {
      const draft = await seedDraft(w, organizations);
      const res = await plan(draft.id, person(draft.employer, ['ORGANIZATION_ADMIN'])).expect(422);
      expect(reasons(res.body)).toEqual(['milestone:CONTRACT_NOT_SIGNED']);
    });

    describe('who plans', () => {
      it('the contractor is 403 EDITOR_NOT_EMPLOYER, recorded; a role CONTRACT_MILESTONE_ROLES does not name is 403 INSUFFICIENT_ROLE, recorded', async () => {
        const c = await signed();
        const asContractor = await plan(c.id, c.contractorToken).expect(403);
        expect(reasons(asContractor.body)).toEqual(['milestone:EDITOR_NOT_EMPLOYER']);
        const asOther = await plan(c.id, person(c.employer, ['FLEET_MANAGER'])).expect(403);
        expect(asOther.body.code).toBe('INSUFFICIENT_ROLE');
        expect(await milestoneRows(w, c.id)).toEqual([]);
        const refused = await refusedEvents(c.employer);
        expect(refused.map((e) => [e.payload.action, e.payload.side, e.payload.reason])).toEqual([
          ['PLAN_MILESTONE', 'CONTRACTOR', 'NOT_EMPLOYER'],
          ['PLAN_MILESTONE', 'EMPLOYER', 'ROLE_NOT_PERMITTED'],
        ]);
      });

      it('the platform administrator, the oversight role, a service token and a token without a user id plan nothing', async () => {
        const c = await signed();
        const audits = (await refusedEvents(c.employer)).length;
        await plan(c.id, systemAdminOf(c.employer)).expect(403);
        await plan(c.id, auditor(c.employer)).expect(403);
        await http(api)
          .post(`/v1/contracts/${c.id}/milestones`)
          .set(
            'x-internal-token',
            await internalToken('construction-service', { organizationId: c.employer }),
          )
          .set('idempotency-key', idemKey('svc'))
          .send(body())
          .expect(403);
        await plan(
          c.id,
          person(c.employer, ['ORGANIZATION_ADMIN'], { rastaUserId: undefined }),
        ).expect(403);
        await plan(c.id, undefined).expect(401);
        expect(await milestoneRows(w, c.id)).toEqual([]);
        expect((await refusedEvents(c.employer)).length).toBe(audits);
      });
    });
  });

  describe('PATCH /v1/contracts/{id}/milestones/{milestoneId}', () => {
    it('changes what is given and leaves the rest; the version moves; the event names no content', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken, body({ plannedShareBp: 1000 })).expect(201))
        .body;

      const renamed = await change(c.id, made.id, c.employerToken, {
        title: 'Piles complete',
      }).expect(200);
      expect(renamed.body).toMatchObject({
        title: 'Piles complete',
        plannedDate: '2026-12-01',
        plannedShareBp: 1000,
        version: 2,
      });
      const moved = await change(c.id, made.id, c.employerToken, {
        plannedDate: '2027-01-15',
        plannedShareBp: null,
      }).expect(200);
      expect(moved.body).toMatchObject({
        title: 'Piles complete',
        plannedDate: '2027-01-15',
        plannedShareBp: null,
        version: 3,
      });
      const [row] = await milestoneRows(w, c.id);
      expect(row).toMatchObject({ title: 'Piles complete', plannedShareBp: null, version: 3 });
      expect(row!.plannedDate.toISOString()).toBe('2027-01-15T00:00:00.000Z');

      const events = await eventsOf(w.prisma, c.employer, 'CONTRACT_MILESTONE_CHANGED');
      expect(events.map((e) => e.payload.version)).toEqual([2, 3]);
      expect(JSON.stringify(events)).not.toMatch(/Piles|2027|1000/);
    });

    it('a change that changes nothing answers the milestone as it is and writes nothing: no version, no event', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken, body({ plannedShareBp: 500 })).expect(201))
        .body;
      const same = await change(c.id, made.id, c.employerToken, {
        title: made.title,
        plannedDate: made.plannedDate,
        plannedShareBp: 500,
      }).expect(200);
      expect(same.body).toEqual(made);
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_MILESTONE_CHANGED')).toEqual([]);
      expect((await milestoneRows(w, c.id))[0]!.version).toBe(1);
    });

    it('needs a field to change, refuses an unpublished one and validates what it is given (400)', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      await change(c.id, made.id, c.employerToken, {}).expect(400);
      await change(c.id, made.id, c.employerToken, { expectedVersion: 1 }).expect(400);
      await change(c.id, made.id, c.employerToken, { contractId: 'CTR_x', title: 'x' }).expect(400);
      await change(c.id, made.id, c.employerToken, { plannedDate: '2026-02-30' }).expect(400);
      await change(c.id, made.id, c.employerToken, { plannedShareBp: 0 }).expect(400);
      await change(c.id, made.id, c.employerToken, { title: '' }).expect(400);
    });

    it('is refused for a milestone a statement refers to: 422 MILESTONE_REFERENCED, by the service and by the database', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      await reference(made.id);

      const res = await change(c.id, made.id, c.employerToken, { title: 'Too late' }).expect(422);
      expect(reasons(res.body)).toEqual(['milestone:MILESTONE_REFERENCED']);
      expect((await read(c.id, made.id, c.contractorToken).expect(200)).body.referenced).toBe(true);
      expect((await milestoneRows(w, c.id))[0]).toMatchObject({ title: 'Foundation complete' });

      // The database says the same, to a write path that forgot to ask.
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE milestone SET title = 'sneaked' WHERE id = '${made.id}'`,
        ),
      ).rejects.toThrow(/ck_milestone_referenced/);
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE milestone SET first_referenced_at = NULL WHERE id = '${made.id}'`,
        ),
      ).rejects.toThrow(/ck_milestone_referenced/);
    });

    it('takes an optional milestone version: a stale one is 409 and writes nothing', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      await change(c.id, made.id, c.employerToken, { title: 'New', expectedVersion: 4 }).expect(
        409,
      );
      expect((await milestoneRows(w, c.id))[0]!.title).toBe('Foundation complete');
      await change(c.id, made.id, c.employerToken, { title: 'New', expectedVersion: 1 }).expect(
        200,
      );
    });

    it('two edits at once are ordered by the contract’s lock: both apply, the version counts both', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      const [a, b] = await Promise.all([
        change(c.id, made.id, c.employerToken, { title: 'First edit' }),
        change(c.id, made.id, c.employerToken, { plannedShareBp: 4000 }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((await milestoneRows(w, c.id))[0]).toMatchObject({ version: 3 });
    });

    it('the contractor and an employer without the role are refused, recorded; the other contract’s milestone id is 404', async () => {
      const c = await signed();
      const other = await signed();
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      const theirs = (await plan(other.id, other.employerToken).expect(201)).body;

      const asContractor = await change(c.id, made.id, c.contractorToken, {
        title: 'Mine now',
      }).expect(403);
      expect(reasons(asContractor.body)).toEqual(['milestone:EDITOR_NOT_EMPLOYER']);
      await change(c.id, made.id, person(c.employer, ['DRIVER']), { title: 'x' }).expect(403);
      const refused = await refusedEvents(c.employer);
      expect(refused.map((e) => [e.payload.action, e.payload.reason, e.payload.subjectId])).toEqual(
        [
          ['CHANGE_MILESTONE', 'NOT_EMPLOYER', made.id],
          ['CHANGE_MILESTONE', 'ROLE_NOT_PERMITTED', made.id],
        ],
      );
      await change(c.id, theirs.id, c.employerToken, { title: 'x' }).expect(404);
      expect((await milestoneRows(w, c.id))[0]!.title).toBe('Foundation complete');
    });

    it('there is no delete: the API has no route, the database refuses (Q-100)', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      await http(api)
        .delete(`/v1/contracts/${c.id}/milestones/${made.id}`)
        .set('authorization', `Bearer ${c.employerToken}`)
        .expect(404);
      await expect(
        w.prisma.client.$executeRawUnsafe(`DELETE FROM milestone WHERE id = '${made.id}'`),
      ).rejects.toThrow(/ck_milestone_not_erasable/);
      expect(await milestoneRows(w, c.id)).toHaveLength(1);
    });
  });

  describe('reading', () => {
    it('both parties read the plan, ordered by planned day; the contractor reads what it is held to', async () => {
      const c = await signed();
      const late = (
        await plan(
          c.id,
          c.employerToken,
          body({ title: 'Late', plannedDate: '2027-03-01' }),
        ).expect(201)
      ).body;
      const early = (
        await plan(
          c.id,
          c.employerToken,
          body({ title: 'Early', plannedDate: '2026-11-01' }),
        ).expect(201)
      ).body;
      for (const token of [c.employerToken, c.contractorToken]) {
        const page = await list(c.id, token).expect(200);
        expect(page.body.items.map((i: { id: string }) => i.id)).toEqual([early.id, late.id]);
        expect(page.body).toMatchObject({ hasMore: false, nextCursor: null });
        expect((await read(c.id, early.id, token).expect(200)).body).toMatchObject({
          title: 'Early',
          plannedDate: '2026-11-01',
        });
      }
      await read(c.id, 'MLS_missing', c.employerToken).expect(404);
    });

    it('the AUDITOR and a service token read nothing', async () => {
      const c = await signed();
      await list(c.id, auditor(c.employer)).expect(403);
      await http(api)
        .get(`/v1/contracts/${c.id}/milestones`)
        .set(
          'x-internal-token',
          await internalToken('economic-service', { organizationId: c.employer }),
        )
        .expect(403);
    });
  });

  describe('Idempotency-Key on every command (docs/06 § 6.8)', () => {
    it('is required: without one, or outside 8 to 255 characters, 400 and nothing is done', async () => {
      const c = await signed();
      const raw = () => http(api).post(`/v1/contracts/${c.id}/milestones`);
      await raw().set('authorization', `Bearer ${c.employerToken}`).send(body()).expect(400);
      await raw()
        .set('authorization', `Bearer ${c.employerToken}`)
        .set('idempotency-key', 'short')
        .send(body())
        .expect(400);
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      await http(api)
        .patch(`/v1/contracts/${c.id}/milestones/${made.id}`)
        .set('authorization', `Bearer ${c.employerToken}`)
        .send({ title: 'x' })
        .expect(400);
      expect(await milestoneRows(w, c.id)).toHaveLength(1);
      expect((await milestoneRows(w, c.id))[0]!.title).toBe('Foundation complete');
    });

    it('a retried plan answers the first response and plans once; another body or user under the key is 409', async () => {
      const c = await signed();
      const key = idemKey('retry');
      const first = await plan(c.id, c.employerToken, body(), key).expect(201);
      const again = await plan(c.id, c.employerToken, body(), key).expect(201);
      expect(again.body).toEqual(first.body);
      expect(await milestoneRows(w, c.id)).toHaveLength(1);
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_MILESTONE_PLANNED')).toHaveLength(1);
      const other = await plan(c.id, c.employerToken, body({ title: 'Another' }), key).expect(409);
      expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      await plan(c.id, person(c.employer, ['ORGANIZATION_ADMIN']), body(), key).expect(409);
      expect(await milestoneRows(w, c.id)).toHaveLength(1);
    });

    it('a retried change applies once', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      const key = idemKey('retry-patch');
      const first = await change(c.id, made.id, c.employerToken, { title: 'Once' }, key).expect(
        200,
      );
      const again = await change(c.id, made.id, c.employerToken, { title: 'Once' }, key).expect(
        200,
      );
      expect(again.body).toEqual(first.body);
      expect((await milestoneRows(w, c.id))[0]!.version).toBe(2);
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_MILESTONE_CHANGED')).toHaveLength(1);
    });
  });

  describe('tenant isolation (S-03): another organization is told 404', () => {
    it('cannot list, read, plan or change — and leaves no trace and no audit record', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      const strangerOrg = `ORG_${ulid()}`;
      organizations.push(strangerOrg);
      const audits = (await refusedEvents(c.employer)).length;

      for (const token of [
        person(strangerOrg, ['ORGANIZATION_ADMIN']),
        person(strangerOrg, ['CONTRACTOR']),
        person(strangerOrg, ['ORGANIZATION_ADMIN', 'CONTRACTOR']),
      ]) {
        await list(c.id, token).expect(404);
        await read(c.id, made.id, token).expect(404);
        await plan(c.id, token).expect(404);
        await change(c.id, made.id, token, { title: 'Hijacked' }).expect(404);
      }
      expect(await milestoneRows(w, c.id)).toHaveLength(1);
      expect((await milestoneRows(w, c.id))[0]!.title).toBe('Foundation complete');
      expect((await refusedEvents(c.employer)).length).toBe(audits);
    });

    it('the answer is the very 404 a contract that does not exist gets', async () => {
      const c = await signed();
      const stranger = person(`ORG_${ulid()}`, ['ORGANIZATION_ADMIN']);
      const real = await list(c.id, stranger).expect(404);
      const missing = await list(`CTR_${ulid()}`, stranger).expect(404);
      expect(Object.keys(bare(real.body))).toEqual(Object.keys(bare(missing.body)));
      expect(bare(real.body).code).toBe(bare(missing.body).code);
    });

    it('a milestone is found only under its own contract, and another contract’s party cannot touch it', async () => {
      const one = await signed();
      const two = await signed();
      const mine = (await plan(one.id, one.employerToken).expect(201)).body;
      await read(two.id, mine.id, two.employerToken).expect(404);
      await change(two.id, mine.id, two.employerToken, { title: 'x' }).expect(404);
      await change(one.id, mine.id, two.employerToken, { title: 'x' }).expect(404);
      await plan(one.id, two.contractorToken).expect(404);
    });
  });

  describe('the database keeps the plan, whatever the code forgets', () => {
    it('refuses a milestone on a contract that is not SIGNED, a share outside its range, a bidi title and a change of what it belongs to', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      const draft = await seedDraft(w, organizations);
      const refuses = (sql: string, pattern: RegExp) =>
        expect(w.prisma.client.$executeRawUnsafe(sql)).rejects.toThrow(pattern);

      await refuses(
        `INSERT INTO milestone (id, organization_id, contract_id, title, planned_date, created_at, created_by, created_correlation_id, updated_at, updated_by)
         VALUES ('MLS_x1', '${draft.employer}', '${draft.id}', 't', '2026-12-01', now(), 'u', 'c', now(), 'u')`,
        /ck_milestone_contract_signed/,
      );
      await refuses(
        `UPDATE milestone SET planned_share_bp = 10001 WHERE id = '${made.id}'`,
        /ck_milestone_share/,
      );
      await refuses(
        `UPDATE milestone SET planned_share_bp = 0 WHERE id = '${made.id}'`,
        /ck_milestone_share/,
      );
      await refuses(
        `UPDATE milestone SET title = E'a\\u202Eb' WHERE id = '${made.id}'`,
        /ck_milestone_title/,
      );
      await refuses(
        `UPDATE milestone SET contract_id = '${draft.id}' WHERE id = '${made.id}'`,
        /ck_milestone_origin_immutable/,
      );
      await refuses(
        `UPDATE milestone SET created_by = 'someone-else' WHERE id = '${made.id}'`,
        /ck_milestone_origin_immutable/,
      );
      expect((await milestoneRows(w, c.id))[0]).toMatchObject({ title: 'Foundation complete' });
    });

    it('the contract moving on (COMPLETED) freezes the plan: no edit once the contract is not SIGNED', async () => {
      const c = await signed();
      const made = (await plan(c.id, c.employerToken).expect(201)).body;
      // Stand in for PR 6's `complete`, through the owner role, which may lift a guard.
      const row = await contractRow(w, c.id);
      expect(row.status).toBe('SIGNED');
      // The runtime role cannot make this change (the guard allows SIGNED → COMPLETED, PR 6's), so
      // the contract's status is moved the one way it can be: the declared transition.
      await w.prisma.client.$executeRawUnsafe(
        `UPDATE contract SET status = 'COMPLETED', status_changed_at = now(), status_changed_by = 'suite', updated_at = now(), version = version + 1 WHERE id = '${c.id}'`,
      );
      const res = await change(c.id, made.id, c.employerToken, {
        title: 'After completion',
      }).expect(422);
      expect(reasons(res.body)).toEqual(['milestone:CONTRACT_NOT_SIGNED']);
      await plan(c.id, c.employerToken).expect(422);
    });
  });
});
