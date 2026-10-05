import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  actor,
  auditor,
  internalToken,
  orgAdmin,
  person,
  startApi,
  type ApiHarness,
} from './api-helpers';
import { cleanup, eventsOf, newOrganizationId, policyEventsOf } from './helpers';

/**
 * The approval policies that say who signs for an employer (ADR-068 § 5, Q-70 (7)): construction-
 * service's mechanism over the real `AppModule`, real guards and a real database. A union writes for
 * its own organization or one beneath it (organization-service confirms; the suites' hierarchy is
 * given), a different platform administrator puts it in force, and what is in force is the only
 * thing that ever authorises a signature.
 */
describe('approval policies (contract.signature)', () => {
  let api: ApiHarness;
  const organizations: string[] = [];

  const http = () => request(api.app.getHttpServer());
  const key = (): string => `policy-${ulid()}`;
  const newOrg = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };

  /** union → employer, so the union may write for it; `elsewhere` is nobody's child. */
  let union: string;
  let employer: string;
  let elsewhere: string;
  let unionAdmin: string;
  let platformAdmin: string;
  let otherPlatformAdmin: string;

  const platform = (): string => person('ORG-ITEST-PLATFORM', ['SYSTEM_ADMIN']);

  const stepFor = (organizationId: string, role = 'ORGANIZATION_ADMIN') => ({
    authorityOrganizationId: organizationId,
    authorityRole: role,
    authorityLabel: `Signer ${role}`,
  });
  const body = (organizationId: string, roles = ['ORGANIZATION_ADMIN']) => ({
    organizationId,
    workflowKey: 'contract.signature',
    label: 'Who signs for the employer',
    rationale: 'Decided by the union for the integration suite',
    isSample: true,
    steps: roles.map((role) => stepFor(organizationId, role)),
  });

  /** `idempotencyKey` null sends none. */
  const create = (
    token: string | undefined,
    payload: object,
    idempotencyKey: string | null = key(),
  ) => {
    const r = http().post('/v1/approval-policies');
    if (token) r.set('authorization', `Bearer ${token}`);
    if (idempotencyKey !== null) r.set('idempotency-key', idempotencyKey);
    return r.send(payload);
  };
  const command = (token: string, id: string, verb: string, payload: object) =>
    http()
      .post(`/v1/approval-policies/${id}/${verb}`)
      .set('authorization', `Bearer ${token}`)
      .send(payload);
  const get = (token: string, id: string) =>
    http().get(`/v1/approval-policies/${id}`).set('authorization', `Bearer ${token}`);
  const reasons = (res: { body: { details?: { path: string; code: string }[] } }) =>
    res.body.details?.map((detail) => `${detail.path}:${detail.code}`);

  /** A policy written by the union, submitted, ready for a platform administrator. */
  async function pending(target = employer, roles = ['ORGANIZATION_ADMIN']) {
    const written = await create(unionAdmin, body(target, roles)).expect(201);
    const submitted = await command(unionAdmin, written.body.id, 'submit', {
      expectedVersion: written.body.version,
    }).expect(200);
    return submitted.body as { id: string; version: number; status: string };
  }

  beforeAll(async () => {
    api = await startApi();
    api.hierarchy.everyoneIsMine = false;
  });

  afterAll(async () => {
    await cleanup(organizations);
    await api.close();
  });

  beforeEach(() => {
    union = newOrg();
    employer = newOrg();
    elsewhere = newOrg();
    api.hierarchy.adopt(union, employer);
    api.hierarchy.unavailable = false;
    api.hierarchy.timedOut = false;
    unionAdmin = person(union, ['UNION_ADMIN']);
    platformAdmin = platform();
    otherPlatformAdmin = platform();
  });

  describe('who writes', () => {
    it('a union writes a DRAFT for an organization beneath it; it governs nothing yet', async () => {
      const res = await create(unionAdmin, body(employer)).expect(201);
      expect(res.body).toMatchObject({
        organizationId: employer,
        authorOrganizationId: union,
        authorRole: 'UNION_ADMIN',
        workflowKey: 'contract.signature',
        policyVersion: 1,
        status: 'DRAFT',
        version: 1,
        submittedAt: null,
        activatedAt: null,
      });
      expect(res.body.steps).toEqual([
        {
          stepOrder: 1,
          authorityOrganizationId: employer,
          authorityRole: 'ORGANIZATION_ADMIN',
          authorityLabel: 'Signer ORGANIZATION_ADMIN',
        },
      ]);
      // Its version is the next of the line, not a number the client chose.
      const second = await create(unionAdmin, body(employer)).expect(201);
      expect(second.body.policyVersion).toBe(2);
    });

    it('a union writes for its own organization, but not for one outside its hierarchy: 403', async () => {
      await create(unionAdmin, body(union)).expect(201);
      const refused = await create(unionAdmin, body(elsewhere)).expect(403);
      expect(refused.body.code).toBe('FORBIDDEN');
      expect(refused.body.message).toMatch(/only for its own organization or one beneath it/);
    });

    it('the platform administrator writes for any organization that exists', async () => {
      const res = await create(platformAdmin, body(elsewhere)).expect(201);
      expect(res.body).toMatchObject({ authorRole: 'SYSTEM_ADMIN', status: 'DRAFT' });
    });

    it('an organization administrator never writes its own policy, nor does a contractor, the oversight role or a service', async () => {
      await create(orgAdmin(employer), body(employer)).expect(403);
      await create(actor(employer, ['CONTRACTOR']), body(employer)).expect(403);
      await create(auditor(employer), body(employer)).expect(403);
      // A service token reaches no route here: none names a service caller (403).
      const service = await internalToken('economic-service', { organizationId: employer });
      await http()
        .post('/v1/approval-policies')
        .set('x-internal-token', service)
        .set('idempotency-key', key())
        .send(body(employer))
        .expect(403);
      await create(undefined, body(employer)).expect(401);
    });

    it('a token without the platform user id writes nothing: 403', async () => {
      await create(
        person(union, ['UNION_ADMIN'], { rastaUserId: undefined }),
        body(employer),
      ).expect(403);
    });

    it('names the governed organization’s own roles only: another organization’s role is 422', async () => {
      const res = await create(unionAdmin, {
        ...body(employer),
        steps: [stepFor(elsewhere)],
      }).expect(422);
      expect(res.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(reasons(res)).toEqual(['policy:AUTHORITY_NOT_GOVERNED_ORGANIZATION']);
    });

    it.each(['AUDITOR', 'SYSTEM_ADMIN', 'WIZARD'])(
      'never names %s as an authority: 400',
      async (role) => {
        await create(unionAdmin, { ...body(employer), steps: [stepFor(employer, role)] }).expect(
          400,
        );
      },
    );

    it.each([
      ['an unknown field', { status: 'ACTIVE' }],
      ['another workflow', { workflowKey: 'contract.amendment' }],
      ['no steps', { steps: [] }],
      ['a blank rationale', { rationale: '   ' }],
    ])('refuses %s: 400', async (_label, change) => {
      await create(unionAdmin, { ...body(employer), ...change }).expect(400);
    });

    it('fails closed when organization-service cannot confirm: 503, and 504 when it is too slow — nothing is written', async () => {
      api.hierarchy.unavailable = true;
      const down = await create(unionAdmin, body(employer)).expect(503);
      expect(down.body.code).toBe('UPSTREAM_UNAVAILABLE');
      api.hierarchy.unavailable = false;
      api.hierarchy.timedOut = true;
      const slow = await create(unionAdmin, body(employer)).expect(504);
      expect(slow.body.code).toBe('UPSTREAM_TIMEOUT');
      api.hierarchy.timedOut = false;
      const listed = await http()
        .get('/v1/approval-policies')
        .set('authorization', `Bearer ${orgAdmin(employer)}`)
        .expect(200);
      expect(listed.body.items).toEqual([]);
    });
  });

  describe('Idempotency-Key on the create', () => {
    it('is required, 8 to 255 characters: 400 and nothing written', async () => {
      await create(unionAdmin, body(employer), null).expect(400);
      await create(unionAdmin, body(employer), 'short').expect(400);
    });

    it('a retry returns the first response and writes nothing again', async () => {
      const k = key();
      const one = await create(unionAdmin, body(employer), k).expect(201);
      const two = await create(unionAdmin, body(employer), k).expect(201);
      expect(two.body).toEqual(one.body);
      const events = await eventsOf(api.prisma, employer, 'APPROVAL_POLICY_CREATED');
      expect(events).toHaveLength(1);
    });

    it('the same key with another body is 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const k = key();
      await create(unionAdmin, body(employer), k).expect(201);
      const reused = await create(
        unionAdmin,
        { ...body(employer), label: 'Another label' },
        k,
      ).expect(409);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  describe('the lifecycle: write, submit, approve (a different platform administrator)', () => {
    it('DRAFT → PENDING_PLATFORM_APPROVAL → ACTIVE, each with its who, when and event', async () => {
      const written = await create(unionAdmin, body(employer)).expect(201);
      const submitted = await command(unionAdmin, written.body.id, 'submit', {
        expectedVersion: 1,
      }).expect(200);
      expect(submitted.body).toMatchObject({ status: 'PENDING_PLATFORM_APPROVAL', version: 2 });
      expect(submitted.body.submittedAt).toEqual(expect.any(String));

      const approved = await command(platformAdmin, written.body.id, 'approve', {
        expectedVersion: 2,
      }).expect(200);
      expect(approved.body).toMatchObject({ status: 'ACTIVE', version: 3 });
      expect(approved.body.activatedAt).toEqual(expect.any(String));
      expect(approved.body.activatedBy).not.toBe(written.body.createdBy);

      const events = await policyEventsOf(api.prisma, employer);
      expect(events.map((e) => e.eventName)).toEqual([
        'APPROVAL_POLICY_CREATED',
        'APPROVAL_POLICY_SUBMITTED',
        'APPROVAL_POLICY_ACTIVATED',
      ]);
      // What an event says: identifiers, versions, instants — never the label, rationale or steps.
      for (const event of events) {
        expect(JSON.stringify(event.payload)).not.toMatch(/rationale|label|authorityRole|Signer/);
      }
      expect(events[2]!.payload).toMatchObject({
        policyId: written.body.id,
        organizationId: employer,
        workflowKey: 'contract.signature',
        policyVersion: 1,
        retiredPolicyId: null,
      });
    });

    it('only the organization that wrote it submits it: another union learns nothing (404), a stranger neither', async () => {
      const written = await create(unionAdmin, body(employer)).expect(201);
      await command(person(newOrg(), ['UNION_ADMIN']), written.body.id, 'submit', {
        expectedVersion: 1,
      }).expect(404);
      await command(orgAdmin(employer), written.body.id, 'submit', { expectedVersion: 1 }).expect(
        403,
      );
      await command(orgAdmin(elsewhere), written.body.id, 'submit', { expectedVersion: 1 }).expect(
        404,
      );
    });

    it('cannot be approved before it is submitted, or twice: 422', async () => {
      const written = await create(unionAdmin, body(employer)).expect(201);
      const early = await command(platformAdmin, written.body.id, 'approve', {
        expectedVersion: 1,
      }).expect(422);
      expect(early.body.message).toMatch(/cannot move from DRAFT to ACTIVE/);
      const submitted = await pending();
      await command(platformAdmin, submitted.id, 'approve', {
        expectedVersion: submitted.version,
      }).expect(200);
      await command(otherPlatformAdmin, submitted.id, 'approve', {
        expectedVersion: submitted.version + 1,
      }).expect(422);
    });

    it('only a platform administrator approves, rejects or reads the queue — not the union, not the organization', async () => {
      const p = await pending();
      for (const token of [unionAdmin, orgAdmin(employer), auditor(employer)]) {
        await command(token, p.id, 'approve', { expectedVersion: p.version }).expect(403);
        await command(token, p.id, 'reject', {
          expectedVersion: p.version,
          reason: 'not mine to refuse',
        }).expect(403);
      }
      await http()
        .get('/v1/approval-policies/pending-platform-approval')
        .set('authorization', `Bearer ${unionAdmin}`)
        .expect(403);
      const queue = await http()
        .get('/v1/approval-policies/pending-platform-approval')
        .set('authorization', `Bearer ${platformAdmin}`)
        .expect(200);
      expect(queue.body.items.map((item: { id: string }) => item.id)).toContain(p.id);
      expect(
        queue.body.items.every(
          (item: { status: string }) => item.status === 'PENDING_PLATFORM_APPROVAL',
        ),
      ).toBe(true);
    });

    it('a stale expectedVersion is 409 OPTIMISTIC_LOCK_FAILED, and nothing moves', async () => {
      const written = await create(unionAdmin, body(employer)).expect(201);
      const stale = await command(unionAdmin, written.body.id, 'submit', {
        expectedVersion: 7,
      }).expect(409);
      expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect((await get(unionAdmin, written.body.id).expect(200)).body.status).toBe('DRAFT');
    });

    it('approving a replacement retires the policy in force in the same transaction', async () => {
      const one = await pending();
      await command(platformAdmin, one.id, 'approve', { expectedVersion: one.version }).expect(200);
      const two = await pending(employer, ['ORGANIZATION_ADMIN', 'FLEET_MANAGER']);
      const approved = await command(otherPlatformAdmin, two.id, 'approve', {
        expectedVersion: two.version,
      }).expect(200);
      expect(approved.body.policyVersion).toBe(2);
      const first = (await get(platformAdmin, one.id).expect(200)).body;
      expect(first).toMatchObject({ status: 'RETIRED' });
      expect(first.retiredBy).toBe(approved.body.activatedBy);

      const events = await policyEventsOf(api.prisma, employer);
      const names = events.map((e) => e.eventName);
      expect(names.filter((n) => n === 'APPROVAL_POLICY_RETIRED')).toHaveLength(1);
      const activated = events.filter((e) => e.eventName === 'APPROVAL_POLICY_ACTIVATED');
      expect(activated[1]!.payload).toMatchObject({ policyVersion: 2, retiredPolicyId: one.id });
      // One policy in force, and it is the replacement.
      const inForce = await runUnscoped('the suite reads the policies in force', () =>
        api.prisma.client.approvalPolicy.findMany({
          where: { organizationId: employer, status: 'ACTIVE' },
        }),
      );
      expect(inForce.map((row) => row.id)).toEqual([two.id]);
    });

    it('a rejection says why; the reason stays with the policy and is on no event; a rejected policy never governs', async () => {
      const p = await pending();
      await command(platformAdmin, p.id, 'reject', {
        expectedVersion: p.version,
        reason: 'short',
      }).expect(400);
      const rejected = await command(platformAdmin, p.id, 'reject', {
        expectedVersion: p.version,
        reason: 'The named role is not the one the charter gives',
      }).expect(200);
      expect(rejected.body).toMatchObject({
        status: 'REJECTED',
        rejectionReason: 'The named role is not the one the charter gives',
      });
      const events = await eventsOf(api.prisma, employer, 'APPROVAL_POLICY_REJECTED');
      expect(JSON.stringify(events[0]!.payload)).not.toContain('charter');
      await command(platformAdmin, p.id, 'approve', {
        expectedVersion: rejected.body.version,
      }).expect(422);
    });

    it('retiring takes an ACTIVE policy out of force with no replacement — by the platform or the author organization', async () => {
      const a = await pending();
      await command(platformAdmin, a.id, 'approve', { expectedVersion: a.version }).expect(200);
      const retiredByUnion = await command(unionAdmin, a.id, 'retire', {
        expectedVersion: a.version + 1,
      }).expect(200);
      expect(retiredByUnion.body.status).toBe('RETIRED');
      await command(unionAdmin, a.id, 'retire', { expectedVersion: a.version + 2 }).expect(422);

      const b = await pending();
      await command(platformAdmin, b.id, 'approve', { expectedVersion: b.version }).expect(200);
      await command(orgAdmin(employer), b.id, 'retire', { expectedVersion: b.version + 1 }).expect(
        403,
      );
      await command(otherPlatformAdmin, b.id, 'retire', { expectedVersion: b.version + 1 }).expect(
        200,
      );
    });
  });

  describe('four eyes: the approver is neither the author nor the submitter', () => {
    it('a platform administrator never approves the policy it wrote or submitted', async () => {
      const admin = platform();
      const written = await create(admin, body(employer)).expect(201);
      await command(admin, written.body.id, 'submit', { expectedVersion: 1 }).expect(200);
      const refused = await command(admin, written.body.id, 'approve', {
        expectedVersion: 2,
      }).expect(403);
      expect(refused.body.message).toMatch(/different platform administrator/);
      await command(otherPlatformAdmin, written.body.id, 'approve', { expectedVersion: 2 }).expect(
        200,
      );
    });

    it('a policy a union wrote is approved by someone else, always — even with the flag off', async () => {
      const relaxed = await startApi({ CONTRACT_POLICY_FOUR_EYES: 'false' });
      relaxed.hierarchy.everyoneIsMine = false;
      relaxed.hierarchy.adopt(union, employer);
      try {
        const unionToken = person(union, ['UNION_ADMIN']);
        const r = () => request(relaxed.app.getHttpServer());
        const written = await r()
          .post('/v1/approval-policies')
          .set('authorization', `Bearer ${unionToken}`)
          .set('idempotency-key', key())
          .send(body(employer))
          .expect(201);
        await r()
          .post(`/v1/approval-policies/${written.body.id}/submit`)
          .set('authorization', `Bearer ${unionToken}`)
          .send({ expectedVersion: 1 })
          .expect(200);
        // The union is not a platform administrator at all; a SYSTEM_ADMIN who is also that person is.
        const same = bearerAsSamePerson(unionToken, ['SYSTEM_ADMIN', 'UNION_ADMIN']);
        const refused = await r()
          .post(`/v1/approval-policies/${written.body.id}/approve`)
          .set('authorization', `Bearer ${same}`)
          .send({ expectedVersion: 2 })
          .expect(403);
        expect(refused.body.message).toMatch(/approved by a different person, always/);
      } finally {
        await relaxed.close();
      }
    });

    it('with the flag off, a platform administrator may approve its own policy — and says so at startup only', async () => {
      const relaxed = await startApi({ CONTRACT_POLICY_FOUR_EYES: 'false' });
      try {
        const admin = platform();
        const r = () => request(relaxed.app.getHttpServer());
        const written = await r()
          .post('/v1/approval-policies')
          .set('authorization', `Bearer ${admin}`)
          .set('idempotency-key', key())
          .send(body(employer))
          .expect(201);
        await r()
          .post(`/v1/approval-policies/${written.body.id}/submit`)
          .set('authorization', `Bearer ${admin}`)
          .send({ expectedVersion: 1 })
          .expect(200);
        await r()
          .post(`/v1/approval-policies/${written.body.id}/approve`)
          .set('authorization', `Bearer ${admin}`)
          .send({ expectedVersion: 2 })
          .expect(200);
      } finally {
        await relaxed.close();
      }
    });
  });

  describe('who sees a policy', () => {
    it('its author organization, the governed organization’s contract readers and the platform; anyone else 404', async () => {
      const p = await pending();
      await get(unionAdmin, p.id).expect(200);
      await get(orgAdmin(employer), p.id).expect(200);
      await get(platformAdmin, p.id).expect(200);
      await get(orgAdmin(elsewhere), p.id).expect(404);
      // A contractor of the same organization is no reader of its policies: told nothing (404).
      await get(actor(employer, ['CONTRACTOR']), p.id).expect(404);
      await get(auditor(employer), p.id).expect(403);
      await get(orgAdmin(employer), `APL_${ulid()}`).expect(404);
    });

    it('lists only what an organization governs or wrote', async () => {
      const mine = await pending();
      const another = newOrg();
      api.hierarchy.adopt(union, another);
      const other = await pending(another);
      const asEmployer = await http()
        .get('/v1/approval-policies')
        .set('authorization', `Bearer ${orgAdmin(employer)}`)
        .expect(200);
      expect(asEmployer.body.items.map((item: { id: string }) => item.id)).toEqual([mine.id]);
      const asUnion = await http()
        .get('/v1/approval-policies')
        .set('authorization', `Bearer ${unionAdmin}`)
        .expect(200);
      expect(asUnion.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [mine.id, other.id].sort(),
      );
      const asStranger = await http()
        .get('/v1/approval-policies')
        .set('authorization', `Bearer ${orgAdmin(elsewhere)}`)
        .expect(200);
      expect(asStranger.body.items).toEqual([]);
    });

    it('the same Idempotency-Key in two organizations is two requests: one tenant never reaches another’s stored response', async () => {
      const k = key();
      const one = await create(unionAdmin, body(employer), k).expect(201);
      const otherUnion = newOrg();
      api.hierarchy.adopt(otherUnion, employer);
      const theirs = await create(person(otherUnion, ['UNION_ADMIN']), body(employer), k).expect(
        201,
      );
      expect(theirs.body.id).not.toBe(one.body.id);
      expect(theirs.body.authorOrganizationId).toBe(otherUnion);
    });
  });
});

/** The same person (same `sub`, same user id) holding other roles: a token of the first, re-issued. */
function bearerAsSamePerson(token: string, roles: string[]): string {
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  return `test.${Buffer.from(JSON.stringify({ ...claims, roles }), 'utf8').toString('base64url')}`;
}
