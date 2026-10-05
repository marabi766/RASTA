import request from 'supertest';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  actor,
  auditor,
  internalToken,
  person,
  startApi,
  systemAdminOf,
  type ApiHarness,
} from './api-helpers';
import {
  activateSigningPolicy,
  asPlatform,
  asSetter,
  cleanup,
  eventsOf,
  seedDraft,
  untilSessionsWaitOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * CON-003 PR 2 (ADR-068 § 2, Q-95 (1)): `POST /v1/contracts/{id}/sign`, from the real `AppModule`
 * over real guards and a real database. Each side signs separately; the contract is SIGNED only
 * when both have, in the transaction that records the second; every signature is an audit row and
 * an event; one person is never both sides; another organization is told `404`.
 */
describe('POST /v1/contracts/{id}/sign', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const key = (): string => `sign-${ulid()}`;
  const http = () => request(api.app.getHttpServer());
  const sign = (
    id: string,
    token: string | undefined,
    body: object = {},
    idempotencyKey = key(),
  ) => {
    const r = http().post(`/v1/contracts/${id}/sign`).set('idempotency-key', idempotencyKey);
    if (token) r.set('authorization', `Bearer ${token}`);
    return r.send(body);
  };
  const get = (id: string, token: string) =>
    http().get(`/v1/contracts/${id}`).set('authorization', `Bearer ${token}`);

  const employerSigner = (org: string) => person(org, ['ORGANIZATION_ADMIN']);
  const contractorSigner = (org: string) => person(org, ['CONTRACTOR']);

  const draft = () => seedDraft(w, organizations);
  const rowOf = (id: string) =>
    runUnscoped('the suite reads the contract', () =>
      w.prisma.client.contract.findFirstOrThrow({ where: { id } }),
    );
  const signaturesOf = (contractId: string) =>
    runUnscoped('the suite reads the signatures', () =>
      w.prisma.client.contractSignature.findMany({
        where: { contractId },
        orderBy: { signedAt: 'asc' },
      }),
    );
  const reasons = (body: { details?: { path: string; code: string }[] }) =>
    body.details?.map((detail) => `${detail.path}:${detail.code}`);
  /** Without the envelope's per-request fields, so two refusals can be compared. */
  const bare = (body: Record<string, unknown>) => {
    const { correlationId: _c, timestamp: _t, path: _p, ...rest } = body;
    return rest;
  };

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  describe('both parties sign, each separately', () => {
    it('the employer then the contractor: DRAFT after the first, SIGNED with the second, in one transaction each', async () => {
      const { id, employer, contractor, award } = await draft();
      const employerToken = employerSigner(employer);
      const contractorToken = contractorSigner(contractor);

      const first = await sign(id, employerToken).expect(200);
      expect(first.body).toMatchObject({
        id,
        status: 'DRAFT',
        version: 1,
        contractorSignedAt: null,
      });
      expect(first.body.employerSignedAt).toEqual(expect.any(String));
      expect(await signaturesOf(id)).toHaveLength(1);
      expect((await rowOf(id)).status).toBe('DRAFT');
      expect((await eventsOf(w.prisma, employer)).map((e) => e.eventName)).toEqual([
        'CONTRACT_DRAFTED',
        'CONTRACT_SIGNATURE_RECORDED',
      ]);

      const second = await sign(id, contractorToken).expect(200);
      expect(second.body).toMatchObject({ id, status: 'SIGNED', version: 2 });
      expect(second.body.employerSignedAt).toBe(first.body.employerSignedAt);
      expect(second.body.contractorSignedAt).toEqual(expect.any(String));

      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'SIGNED', version: 2 });
      expect(row.statusChangedAt.toISOString()).toBe(second.body.contractorSignedAt);

      const events = await eventsOf(w.prisma, employer);
      expect(events.map((e) => e.eventName)).toEqual([
        'CONTRACT_DRAFTED',
        'CONTRACT_SIGNATURE_RECORDED',
        'CONTRACT_SIGNATURE_RECORDED',
        'CONTRACT_SIGNED',
      ]);
      expect(events[3]!.payload).toEqual({
        contractId: id,
        tenderId: award.tenderId,
        projectId: award.projectId,
        organizationId: employer,
        contractorOrganizationId: contractor,
        winningBidId: award.winningBidId,
        employerSignedAt: first.body.employerSignedAt,
        contractorSignedAt: second.body.contractorSignedAt,
        signedAt: second.body.contractorSignedAt,
      });
      // No amount on any event, however it is written.
      expect(JSON.stringify(events)).not.toContain(award.amountMinor);
    });

    it('the contractor then the employer: the same contract, whichever signs first', async () => {
      const { id, employer, contractor } = await draft();

      const first = await sign(id, contractorSigner(contractor)).expect(200);
      expect(first.body).toMatchObject({ status: 'DRAFT', employerSignedAt: null });
      const second = await sign(id, employerSigner(employer)).expect(200);
      expect(second.body).toMatchObject({ status: 'SIGNED', version: 2 });

      const [one, two] = await signaturesOf(id);
      expect([one!.side, two!.side]).toEqual(['CONTRACTOR', 'EMPLOYER']);
      expect((await eventsOf(w.prisma, employer, 'CONTRACT_SIGNED'))[0]!.payload).toMatchObject({
        employerSignedAt: second.body.employerSignedAt,
        contractorSignedAt: first.body.contractorSignedAt,
      });
    });

    it('each signature is an audit record: who, for which party, under which authority, when', async () => {
      const { id, employer, contractor } = await draft();
      const employerClaims = { sub: `sub-${ulid()}`, rastaUserId: `USR-${ulid().slice(-8)}` };
      const contractorClaims = { sub: `sub-${ulid()}`, rastaUserId: `USR-${ulid().slice(-8)}` };
      await sign(id, person(employer, ['ORGANIZATION_ADMIN'], employerClaims)).expect(200);
      await sign(id, person(contractor, ['CONTRACTOR'], contractorClaims)).expect(200);

      const [one, two] = await signaturesOf(id);
      expect(one).toMatchObject({
        organizationId: employer,
        contractId: id,
        side: 'EMPLOYER',
        signerOrganizationId: employer,
        signedBy: employerClaims.rastaUserId,
        signedBySubject: employerClaims.sub,
        signedByIssuer: process.env.OIDC_ISSUER_URL,
        authorityRole: 'ORGANIZATION_ADMIN',
      });
      // The contractor's signature belongs to the contract's tenant — the employer's — and
      // names the organization the signer acted for.
      expect(two).toMatchObject({
        organizationId: employer,
        side: 'CONTRACTOR',
        signerOrganizationId: contractor,
        signedBy: contractorClaims.rastaUserId,
        signedBySubject: contractorClaims.sub,
        authorityRole: 'CONTRACTOR',
      });
      expect(one!.correlationId).toBeTruthy();
      expect(one!.signedAt.getTime()).toBeLessThan(two!.signedAt.getTime());

      const recorded = await eventsOf(w.prisma, employer, 'CONTRACT_SIGNATURE_RECORDED');
      expect(recorded.map((event) => event.payload)).toEqual([
        {
          contractId: id,
          organizationId: employer,
          side: 'EMPLOYER',
          signerOrganizationId: employer,
          signedBy: employerClaims.rastaUserId,
          authorityRole: 'ORGANIZATION_ADMIN',
          // The employer's side names the policy that authorised it; the contractor's has none.
          policyId: one!.policyId,
          policyVersion: 1,
          signedAt: one!.signedAt.toISOString(),
        },
        {
          contractId: id,
          organizationId: employer,
          side: 'CONTRACTOR',
          signerOrganizationId: contractor,
          signedBy: contractorClaims.rastaUserId,
          authorityRole: 'CONTRACTOR',
          policyId: null,
          policyVersion: null,
          signedAt: two!.signedAt.toISOString(),
        },
      ]);
      expect(one!.policyId).toMatch(/^APL_/);
      expect(two!.policyId).toBeNull();
    });

    it('a party sees that the other side accepted and when — never by whom', async () => {
      const { id, employer, contractor } = await draft();
      await sign(id, employerSigner(employer)).expect(200);

      const seen = await get(id, contractorSigner(contractor)).expect(200);
      expect(seen.body).toMatchObject({ status: 'DRAFT', contractorSignedAt: null });
      expect(seen.body.employerSignedAt).toEqual(expect.any(String));
      expect(JSON.stringify(seen.body)).not.toMatch(/signedBy|signer|USR/i);

      const listed = await http()
        .get('/v1/contracts')
        .set('authorization', `Bearer ${contractorSigner(contractor)}`)
        .expect(200);
      expect(listed.body.items[0]).toMatchObject({
        id,
        employerSignedAt: seen.body.employerSignedAt,
      });
    });

    it('moves nothing but the signature on the first acceptance: the draft’s version is the draft’s', async () => {
      const { id, employer } = await draft();
      const before = await rowOf(id);
      await sign(id, employerSigner(employer)).expect(200);
      const after = await rowOf(id);
      expect(after).toEqual(before);
    });
  });

  describe('the same side again, and another person for it', () => {
    it('the same person signing the same side again changes nothing and answers with the contract as it is', async () => {
      const { id, employer } = await draft();
      const claims = { sub: `sub-${ulid()}`, rastaUserId: `USR-${ulid().slice(-8)}` };
      const token = person(employer, ['ORGANIZATION_ADMIN'], claims);
      const first = await sign(id, token).expect(200);
      const events = (await eventsOf(w.prisma, employer)).length;

      const again = await sign(id, token).expect(200);
      expect(again.body).toEqual(first.body);
      expect(await signaturesOf(id)).toHaveLength(1);
      expect(await eventsOf(w.prisma, employer)).toHaveLength(events);
    });

    it('the same person is the same on another token of theirs: one subject, two user ids', async () => {
      const { id, employer } = await draft();
      const sub = `sub-${ulid()}`;
      await sign(
        id,
        person(employer, ['ORGANIZATION_ADMIN'], { sub, rastaUserId: 'USR-AAAAAAAA' }),
      ).expect(200);
      await sign(
        id,
        person(employer, ['ORGANIZATION_ADMIN'], { sub, rastaUserId: 'USR-BBBBBBBB' }),
      ).expect(200);
      expect(await signaturesOf(id)).toHaveLength(1);
    });

    it('and still the same person once the contract is SIGNED', async () => {
      const { id, employer, contractor } = await draft();
      const claims = { sub: `sub-${ulid()}`, rastaUserId: `USR-${ulid().slice(-8)}` };
      const token = person(employer, ['ORGANIZATION_ADMIN'], claims);
      await sign(id, token).expect(200);
      await sign(id, contractorSigner(contractor)).expect(200);

      const again = await sign(id, token).expect(200);
      expect(again.body.status).toBe('SIGNED');
      expect(await signaturesOf(id)).toHaveLength(2);
      expect(await eventsOf(w.prisma, employer, 'CONTRACT_SIGNED')).toHaveLength(1);
    });

    it('another person for a side that has signed is 409 SIDE_ALREADY_SIGNED and writes nothing', async () => {
      const { id, employer } = await draft();
      await sign(id, employerSigner(employer)).expect(200);
      const events = (await eventsOf(w.prisma, employer)).length;

      const other = await sign(id, employerSigner(employer)).expect(409);
      expect(other.body.code).toBe('ALREADY_EXISTS');
      expect(reasons(other.body)).toEqual(['signature:SIDE_ALREADY_SIGNED']);
      expect(await signaturesOf(id)).toHaveLength(1);
      expect(await eventsOf(w.prisma, employer)).toHaveLength(events);
    });
  });

  describe('separation of duties (#188): one person is never both sides', () => {
    it('refuses the person who signed the other side — on the same user id, or on the same issuer and subject', async () => {
      const { id, employer, contractor } = await draft();
      const sub = `sub-${ulid()}`;
      await sign(
        id,
        person(employer, ['ORGANIZATION_ADMIN'], { sub, rastaUserId: 'USR-CCCCCCCC' }),
      ).expect(200);

      // Another user id, the same person: the identity provider's subject is what stays the same.
      const asContractor = await sign(
        id,
        person(contractor, ['CONTRACTOR'], { sub, rastaUserId: 'USR-DDDDDDDD' }),
      ).expect(403);
      expect(asContractor.body.code).toBe('FORBIDDEN');
      expect(reasons(asContractor.body)).toEqual(['signature:SAME_PERSON_BOTH_SIDES']);
      // And the same user id under another subject.
      await sign(
        id,
        person(contractor, ['CONTRACTOR'], { sub: `sub-${ulid()}`, rastaUserId: 'USR-CCCCCCCC' }),
      ).expect(403);

      expect(await signaturesOf(id)).toHaveLength(1);
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('refuses a member of both parties, whichever side they act for, before anything is signed', async () => {
      const { id, employer, contractor } = await draft();
      const both = { memberships: [contractor] };
      const asEmployer = await sign(id, person(employer, ['ORGANIZATION_ADMIN'], both)).expect(403);
      expect(reasons(asEmployer.body)).toEqual(['signature:MEMBER_OF_BOTH_PARTIES']);

      const alsoEmployer = { memberships: [employer] };
      const asContractor = await sign(id, person(contractor, ['CONTRACTOR'], alsoEmployer)).expect(
        403,
      );
      expect(reasons(asContractor.body)).toEqual(['signature:MEMBER_OF_BOTH_PARTIES']);
      expect(await signaturesOf(id)).toHaveLength(0);
    });

    it('fails closed when the two signers cannot be told apart: 422 ACTOR_IDENTITY_UNKNOWN, nothing signed', async () => {
      const { id, employer, contractor } = await draft();
      await sign(id, employerSigner(employer)).expect(200);

      // Another issuer: a subject is only unique within its issuer, so nothing proves two people.
      const unknown = await sign(
        id,
        person(contractor, ['CONTRACTOR'], { iss: 'http://other-issuer.invalid/realms/x' }),
      ).expect(422);
      expect(unknown.body.code).toBe('ACTOR_IDENTITY_UNKNOWN');
      expect(reasons(unknown.body)).toEqual(['signature:ACTOR_IDENTITY_UNKNOWN']);
      expect(await signaturesOf(id)).toHaveLength(1);
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('a token without the platform user id signs nothing: 403, before anything is read', async () => {
      const { id, employer } = await draft();
      const res = await sign(
        id,
        person(employer, ['ORGANIZATION_ADMIN'], { rastaUserId: undefined }),
      ).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(await signaturesOf(id)).toHaveLength(0);
    });
  });

  describe('the authority to sign comes from the employer’s policy, not from code or the environment', () => {
    it('the employer’s side is the roles its policy names; any other role is 403', async () => {
      const { id, employer } = await draft();
      for (const roles of [['DRIVER'], ['FLEET_MANAGER'], ['CONTRACTOR']]) {
        const res = await sign(id, person(employer, roles)).expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
      }
      expect(await signaturesOf(id)).toHaveLength(0);
    });

    it('a policy that names another role signs for that role only — and the signature records the policy', async () => {
      const { id, employer } = await seedDraft(
        w,
        organizations,
        {},
        { signingPolicy: ['FLEET_MANAGER'] },
      );
      // The default role is not named by this employer's policy.
      await sign(id, person(employer, ['ORGANIZATION_ADMIN'])).expect(403);
      const res = await sign(id, person(employer, ['FLEET_MANAGER'])).expect(200);
      expect(res.body.employerSignedAt).toEqual(expect.any(String));

      const [signature] = await signaturesOf(id);
      const policy = await runUnscoped('the suite reads the policy', () =>
        w.prisma.client.approvalPolicy.findFirstOrThrow({
          where: { organizationId: employer, workflowKey: 'contract.signature', status: 'ACTIVE' },
        }),
      );
      expect(signature).toMatchObject({
        side: 'EMPLOYER',
        authorityRole: 'FLEET_MANAGER',
        policyId: policy.id,
        policyVersion: policy.policyVersion,
      });
      const [event] = await eventsOf(w.prisma, employer, 'CONTRACT_SIGNATURE_RECORDED');
      expect(event!.payload).toMatchObject({
        authorityRole: 'FLEET_MANAGER',
        policyId: policy.id,
        policyVersion: policy.policyVersion,
      });
    });

    it('a role in force at ANOTHER employer authorises nothing here: no policy of this employer, 422', async () => {
      // Employer A has a policy naming ORGANIZATION_ADMIN; employer B has none. A holder of the
      // role in B signs nothing for B — and the role in A is not a role in B (the service-wide
      // role list this replaced would have let both through).
      const a = await draft();
      const b = await seedDraft(w, organizations, {}, { signingPolicy: false });
      await sign(a.id, employerSigner(a.employer)).expect(200);
      const refused = await sign(b.id, employerSigner(b.employer)).expect(422);
      expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(reasons(refused.body)).toEqual(['signature:SIGNATURE_POLICY_REQUIRED']);
      expect(await signaturesOf(b.id)).toHaveLength(0);
      expect(await signaturesOf(a.id)).toHaveLength(1);
    });

    it('a policy retired takes the authority with it: 422 again, and the signatures already made stand', async () => {
      const { id, employer, contractor } = await draft();
      const signer = employerSigner(employer);
      await sign(id, signer).expect(200);
      const policy = await runUnscoped('the suite reads the policy', () =>
        w.prisma.client.approvalPolicy.findFirstOrThrow({
          where: { organizationId: employer, status: 'ACTIVE' },
        }),
      );
      await asSetter(employer, () =>
        w.policies.retire(policy.id, { expectedVersion: policy.version }),
      );

      // The same person signing the same side again changes nothing, whatever the policy has become.
      await sign(id, signer).expect(200);
      expect(await signaturesOf(id)).toHaveLength(1);
      // The contractor's side needs no policy: the contract completes with the employer's
      // signature that was made while the policy was in force.
      await sign(id, contractorSigner(contractor)).expect(200);
      expect((await rowOf(id)).status).toBe('SIGNED');

      // A different contract of the same employer: nobody signs for it now.
      const next = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const refused = await sign(next.id, employerSigner(next.employer)).expect(422);
      expect(reasons(refused.body)).toEqual(['signature:SIGNATURE_POLICY_REQUIRED']);
    });

    it('a replacement policy governs from its approval; the signature before it keeps the version it was made under', async () => {
      const { id, employer, contractor } = await draft();
      const first = await runUnscoped('the suite reads the policy', () =>
        w.prisma.client.approvalPolicy.findFirstOrThrow({
          where: { organizationId: employer, status: 'ACTIVE' },
        }),
      );
      await sign(id, employerSigner(employer)).expect(200);

      const second = await activateSigningPolicy(w, employer, ['FLEET_MANAGER']);
      const retired = await runUnscoped('the suite reads the policy', () =>
        w.prisma.client.approvalPolicy.findFirstOrThrow({ where: { id: first.id } }),
      );
      expect(retired.status).toBe('RETIRED');
      const [signature] = await signaturesOf(id);
      expect(signature).toMatchObject({ policyId: first.id, policyVersion: 1 });
      expect(second).not.toBe(first.id);
      await sign(id, contractorSigner(contractor)).expect(200);
    });

    it('the contractor’s side is the CONTRACTOR role of its own organization', async () => {
      const { id, contractor } = await draft();
      const res = await sign(id, person(contractor, ['ORGANIZATION_ADMIN'])).expect(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
      expect(await signaturesOf(id)).toHaveLength(0);
    });

    it('the platform administrator, the oversight role and a service never sign — whatever else the token holds', async () => {
      const { id, employer, contractor } = await draft();
      await sign(id, systemAdminOf(employer)).expect(403);
      await sign(id, person(employer, ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN'])).expect(403);
      await sign(id, person(contractor, ['SYSTEM_ADMIN', 'CONTRACTOR'])).expect(403);
      await sign(id, auditor(employer)).expect(403);
      await sign(id, auditor(contractor)).expect(403);
      for (const caller of ['economic-service', 'construction-service']) {
        await http()
          .post(`/v1/contracts/${id}/sign`)
          .set('idempotency-key', key())
          .set('x-internal-token', await internalToken(caller, { organizationId: employer }))
          .send({})
          .expect(403);
      }
      expect(await signaturesOf(id)).toHaveLength(0);
    });
  });

  describe('object-level authorization (S-03)', () => {
    it('another organization is told 404, identical to a contract that does not exist, whatever role it holds', async () => {
      const { id, employer } = await draft();
      const stranger = `ORG-STRANGER-${ulid()}`;
      organizations.push(stranger);

      const missing = await sign('CTR_does_not_exist', employerSigner(stranger)).expect(404);
      for (const roles of [['ORGANIZATION_ADMIN'], ['CONTRACTOR'], ['DRIVER']]) {
        const res = await sign(id, person(stranger, roles)).expect(404);
        expect(bare(res.body)).toEqual(bare(missing.body));
      }
      expect(await signaturesOf(id)).toHaveLength(0);
      expect(employer).not.toBe(stranger);
    });

    it('a contractor of another contract cannot sign this one, and an employer cannot sign another’s', async () => {
      const a = await draft();
      const b = await draft();
      await sign(a.id, contractorSigner(b.contractor)).expect(404);
      await sign(a.id, employerSigner(b.employer)).expect(404);
      await sign(b.id, employerSigner(a.employer)).expect(404);
      expect(await signaturesOf(a.id)).toHaveLength(0);
      expect(await signaturesOf(b.id)).toHaveLength(0);
    });

    it('a stranger’s Idempotency-Key is its own: it does not replay the party’s response', async () => {
      const { id, employer } = await draft();
      const stranger = `ORG-STRANGER-${ulid()}`;
      organizations.push(stranger);
      const shared = key();
      const body = {};

      const signed = await sign(id, employerSigner(employer), body, shared).expect(200);
      const refused = await sign(id, employerSigner(stranger), body, shared).expect(404);
      expect(refused.body).not.toMatchObject({ id: signed.body.id });
    });
  });

  describe('the contract must be a draft, at the version the caller read', () => {
    it('a contract that is not a draft is not signed: 422 CONTRACT_NOT_DRAFT', async () => {
      const { id, employer, contractor } = await draft();
      await runUnscoped('the suite cancels the draft through the runtime role', () =>
        w.prisma.client.$executeRawUnsafe(
          `UPDATE "contract" SET "status" = 'CANCELLED', "cancel_reason_code" = 'OTHER', "version" = 2, "updated_at" = now(), "status_changed_at" = now() WHERE id = '${id}'`,
        ),
      );
      for (const token of [employerSigner(employer), contractorSigner(contractor)]) {
        const res = await sign(id, token).expect(422);
        expect(res.body.code).toBe('BUSINESS_RULE_VIOLATION');
        expect(reasons(res.body)).toEqual(['signature:CONTRACT_NOT_DRAFT']);
      }
      expect(await signaturesOf(id)).toHaveLength(0);
    });

    it('expectedVersion, when given, must be the current version: 409 OPTIMISTIC_LOCK_FAILED and nothing signed', async () => {
      const { id, employer } = await draft();
      const stale = await sign(id, employerSigner(employer), { expectedVersion: 7 }).expect(409);
      expect(stale.body.code).toBe('OPTIMISTIC_LOCK_FAILED');
      expect(await signaturesOf(id)).toHaveLength(0);
      await sign(id, employerSigner(employer), { expectedVersion: 1 }).expect(200);
    });

    it('a body that tries to decide who signs, for whom or when is 400: nothing in it is the caller’s to choose', async () => {
      const { id, employer } = await draft();
      for (const body of [
        { side: 'CONTRACTOR' },
        { organizationId: 'ORG_x' },
        { signedBy: 'USR_x' },
        { signedAt: '2026-01-01T00:00:00.000Z' },
        { status: 'SIGNED' },
        { expectedVersion: 0 },
        { expectedVersion: '1' },
      ]) {
        await sign(id, employerSigner(employer), body).expect(400);
      }
      expect(await signaturesOf(id)).toHaveLength(0);
    });
  });

  describe('Idempotency-Key (docs/06 § 6.8)', () => {
    it('is required: none, too short and too long are 400, and nothing is signed', async () => {
      const { id, employer } = await draft();
      const token = employerSigner(employer);
      const call = (value?: string) => {
        const r = http().post(`/v1/contracts/${id}/sign`).set('authorization', `Bearer ${token}`);
        if (value !== undefined) r.set('idempotency-key', value);
        return r.send({});
      };
      for (const value of [undefined, '   ', 'short', 'x'.repeat(256)]) {
        const res = await call(value).expect(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await signaturesOf(id)).toHaveLength(0);
    });

    it('the same key, the same request and user: the first response again, and nothing done twice', async () => {
      const { id, employer } = await draft();
      const token = employerSigner(employer);
      const k = key();
      const first = await sign(id, token, {}, k).expect(200);
      const events = (await eventsOf(w.prisma, employer)).length;

      const replay = await sign(id, token, {}, k).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(await signaturesOf(id)).toHaveLength(1);
      expect(await eventsOf(w.prisma, employer)).toHaveLength(events);
    });

    it('the same key with another request, another contract or another user is 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const a = await draft();
      const b = await draft();
      const token = employerSigner(a.employer);
      const k = key();
      await sign(a.id, token, {}, k).expect(200);

      const otherBody = await sign(a.id, token, { expectedVersion: 1 }, k).expect(409);
      expect(otherBody.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const otherUser = await sign(a.id, employerSigner(a.employer), {}, k).expect(409);
      expect(otherUser.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      // The request names the contract: the same key, user and body for another contract is refused,
      // and signs nothing.
      const otherContract = await sign(b.id, token, {}, k).expect(409);
      expect(otherContract.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await signaturesOf(a.id)).toHaveLength(1);
      expect(await signaturesOf(b.id)).toHaveLength(0);
    });

    it('a refused command releases its key, so a corrected retry with that key can run', async () => {
      const { id, employer } = await draft();
      const k = key();
      // A person without the authority is refused…
      await sign(id, person(employer, ['DRIVER']), {}, k).expect(403);
      // …and the key is free for a person with it.
      await sign(id, employerSigner(employer), {}, k).expect(200);
      expect(await signaturesOf(id)).toHaveLength(1);
    });

    it('two requests with one key at once are one signature, and both answer it', async () => {
      const { id, employer } = await draft();
      const token = employerSigner(employer);
      const k = key();
      const [one, two] = await Promise.all([sign(id, token, {}, k), sign(id, token, {}, k)]);
      expect([one.status, two.status]).toEqual([200, 200]);
      expect(one.body).toEqual(two.body);
      expect(await signaturesOf(id)).toHaveLength(1);
      expect(await eventsOf(w.prisma, employer, 'CONTRACT_SIGNATURE_RECORDED')).toHaveLength(1);
    });
  });

  describe('concurrency: the two parties’ commands are ordered by the contract’s row lock', () => {
    it('both sides signing at once: both succeed, the contract is SIGNED exactly once, whichever commits first', async () => {
      const { id, employer, contractor } = await draft();

      // Hold the contract's lock, so both commands are provably queued behind it before either runs.
      let release!: () => void;
      let locked!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const gotLock = new Promise<void>((resolve) => (locked = resolve));
      const holder = w.prisma.transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM contract WHERE id = ${id} FOR UPDATE`;
          locked();
          await released;
        },
        { timeoutMs: 60_000 },
      );
      await gotLock;

      // Awaiting starts each request (supertest is lazy until then).
      const both = Promise.all([
        sign(id, employerSigner(employer)),
        sign(id, contractorSigner(contractor)),
      ]);
      await untilSessionsWaitOnALock(w.prisma, 2);
      release();
      await holder;
      const [a, b] = await both;

      expect([a.status, b.status]).toEqual([200, 200]);
      const statuses = [a.body.status, b.body.status].sort();
      // The command that ran second saw the other's signature and completed the contract.
      expect(statuses).toEqual(['DRAFT', 'SIGNED']);
      expect(await signaturesOf(id)).toHaveLength(2);
      const row = await rowOf(id);
      expect(row).toMatchObject({ status: 'SIGNED', version: 2 });
      expect(await eventsOf(w.prisma, employer, 'CONTRACT_SIGNED')).toHaveLength(1);
      expect(await eventsOf(w.prisma, employer, 'CONTRACT_SIGNATURE_RECORDED')).toHaveLength(2);
    });

    it('the same person double-submitting with two keys: one signature, the second answers it', async () => {
      const { id, employer } = await draft();
      const token = employerSigner(employer);
      const [one, two] = await Promise.all([sign(id, token), sign(id, token)]);
      expect([one.status, two.status]).toEqual([200, 200]);
      expect(await signaturesOf(id)).toHaveLength(1);
      expect(await eventsOf(w.prisma, employer, 'CONTRACT_SIGNATURE_RECORDED')).toHaveLength(1);
    });
  });

  describe('without a signing policy in force for the employer (Q-95 (1))', () => {
    it('nobody signs for the employer: 422 SIGNATURE_POLICY_REQUIRED — and the contractor still can', async () => {
      const { id, employer, contractor } = await seedDraft(
        w,
        organizations,
        {},
        {
          signingPolicy: false,
        },
      );

      const refused = await sign(id, actor(employer, ['ORGANIZATION_ADMIN'])).expect(422);
      expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(reasons(refused.body)).toEqual(['signature:SIGNATURE_POLICY_REQUIRED']);
      expect(await signaturesOf(id)).toHaveLength(0);

      await sign(id, actor(contractor, ['CONTRACTOR'])).expect(200);
      expect((await rowOf(id)).status).toBe('DRAFT');
    });

    it('a policy that is only written, or only submitted, authorises nothing: only the platform’s approval does', async () => {
      const { id, employer } = await seedDraft(w, organizations, {}, { signingPolicy: false });
      const policy = await asSetter(employer, () =>
        w.policies.create({
          organizationId: employer,
          workflowKey: 'contract.signature',
          label: 'Who signs',
          rationale: 'Written by the integration suite',
          isSample: true,
          steps: [
            {
              authorityOrganizationId: employer,
              authorityRole: 'ORGANIZATION_ADMIN',
              authorityLabel: 'Signer',
            },
          ],
        }),
      );
      await sign(id, employerSigner(employer)).expect(422);
      await asSetter(employer, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
      await sign(id, employerSigner(employer)).expect(422);
      await asPlatform(() => w.policies.approve(policy.id, { expectedVersion: 2 }));
      await sign(id, employerSigner(employer)).expect(200);
    });

    it('no environment value grants it: the old service-wide role list is not read', async () => {
      const withEnv = await startApi({ CONTRACT_OWNER_SIGNER_ROLES: 'ORGANIZATION_ADMIN' });
      try {
        const { id, employer } = await seedDraft(w, organizations, {}, { signingPolicy: false });
        const res = await request(withEnv.app.getHttpServer())
          .post(`/v1/contracts/${id}/sign`)
          .set('authorization', `Bearer ${actor(employer, ['ORGANIZATION_ADMIN'])}`)
          .set('idempotency-key', key())
          .send({})
          .expect(422);
        expect(reasons(res.body)).toEqual(['signature:SIGNATURE_POLICY_REQUIRED']);
      } finally {
        await withEnv.close();
      }
    });
  });
});
