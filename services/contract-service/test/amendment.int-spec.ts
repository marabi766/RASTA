import request from 'supertest';
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
  amendmentRows,
  amendmentSignatures,
  bare,
  contractRow,
  http,
  idemKey,
  propose,
  proposeBody,
  reasons,
  seedSigned,
  signAmendment,
} from './amendment-helpers';
import {
  cleanup,
  eventsOf,
  seedDraft,
  untilSessionsWaitOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * CON-003 PR 3 (ADR-068 § 9, Q-100): the amendments of a SIGNED contract, from the real
 * `AppModule` over real guards and a real database. The employer proposes; each party signs
 * separately, the way the contract was signed; the second signature — under the contract's row
 * lock, in one transaction — makes the amendment effective and moves the contract's amendments
 * total, exactly once. Another organization is told `404`. Amounts are bigints at every edge.
 */
describe('amendments of a signed contract', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const signed = (overrides = {}) => seedSigned(api, w, organizations, overrides);
  const get = (contractId: string, amendmentId: string, token: string) =>
    http(api)
      .get(`/v1/contracts/${contractId}/amendments/${amendmentId}`)
      .set('authorization', `Bearer ${token}`);
  const list = (contractId: string, token: string, query = '') =>
    http(api)
      .get(`/v1/contracts/${contractId}/amendments${query}`)
      .set('authorization', `Bearer ${token}`);
  const refusedEvents = (employer: string) =>
    eventsOf(w.prisma, employer, 'CONTRACT_AUTHORITY_REFUSED');

  /** Proposes as the contract's employer and signs it as both, so it is effective. */
  async function effective(
    contract: Awaited<ReturnType<typeof signed>>,
    body: object = proposeBody(),
  ): Promise<string> {
    const proposed = await propose(api, contract.id, contract.employerToken, body).expect(201);
    const id = proposed.body.id as string;
    await signAmendment(api, contract.id, id, contract.employerToken).expect(200);
    await signAmendment(api, contract.id, id, contract.contractorToken).expect(200);
    return id;
  }

  beforeAll(async () => {
    api = await startApi({
      CONTRACT_AMENDMENT_REASON_CODES: 'SCOPE_CHANGE,PRICE_ADJUSTMENT,OTHER',
    });
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  describe('POST /v1/contracts/{id}/amendments', () => {
    it('the employer proposes: PROPOSED, numbered, with its event — and the price has not moved', async () => {
      const c = await signed();
      const before = await contractRow(w, c.id);

      const res = await propose(api, c.id, c.employerToken).expect(201);
      expect(res.body).toMatchObject({
        contractId: c.id,
        organizationId: c.employer,
        amendmentNumber: 1,
        deltaMinor: '250000000',
        reasonCode: 'SCOPE_CHANGE',
        reasonText: 'Additional pile work agreed on site',
        status: 'PROPOSED',
        employerSignedAt: null,
        contractorSignedAt: null,
        effectiveAt: null,
        authorityReviewRequired: false,
        version: 1,
      });
      expect(res.body.id).toMatch(/^AMD_/);

      const after = await contractRow(w, c.id);
      expect(after.amendmentsTotalMinor).toBe(0n);
      expect(after.version).toBe(before.version);

      const events = (await eventsOf(w.prisma, c.employer)).filter(
        (e) => e.eventName === 'CONTRACT_AMENDMENT_PROPOSED',
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({
        contractId: c.id,
        amendmentId: res.body.id,
        amendmentNumber: 1,
        organizationId: c.employer,
        contractorOrganizationId: c.contractor,
        reasonCode: 'SCOPE_CHANGE',
        proposedBy: expect.any(String),
        proposedAt: res.body.proposedAt,
      });
      // Neither the amount nor the text is on the shared topic.
      const text = JSON.stringify(events);
      expect(text).not.toContain('250000000');
      expect(text).not.toContain('pile work');

      const second = await propose(
        api,
        c.id,
        c.employerToken,
        proposeBody({ deltaMinor: '1' }),
      ).expect(201);
      expect(second.body.amendmentNumber).toBe(2);
    });

    it('both parties read the list and each amendment; the contractor sees what it is asked to sign', async () => {
      const c = await signed();
      const a1 = (await propose(api, c.id, c.employerToken).expect(201)).body;
      const a2 = (
        await propose(api, c.id, c.employerToken, proposeBody({ deltaMinor: '7' })).expect(201)
      ).body;
      await propose(api, c.id, c.employerToken, proposeBody({ deltaMinor: '9' })).expect(201);

      for (const token of [c.employerToken, c.contractorToken]) {
        const one = await get(c.id, a1.id, token).expect(200);
        expect(one.body).toMatchObject({ id: a1.id, deltaMinor: '250000000', status: 'PROPOSED' });

        const page = await list(c.id, token, '?limit=2').expect(200);
        expect(page.body.items.map((i: { id: string }) => i.id)).toEqual([a1.id, a2.id]);
        expect(page.body).toMatchObject({ hasMore: true, nextCursor: '2' });
        const next = await list(c.id, token, `?limit=2&cursor=${page.body.nextCursor}`).expect(200);
        expect(next.body.items.map((i: { amendmentNumber: number }) => i.amendmentNumber)).toEqual([
          3,
        ]);
        expect(next.body).toMatchObject({ hasMore: false, nextCursor: null });
      }
      await list(c.id, c.employerToken, '?cursor=abc').expect(400);
      await get(c.id, 'AMD_missing', c.employerToken).expect(404);
    });

    describe('the amount is a bigint at every edge', () => {
      it.each([
        ['zero', '0'],
        ['negative', '-1'],
        ['the smallest negative bigint', '-9223372036854775808'],
      ])(
        '%s is refused as a rule: 422 AMENDMENT_DELTA_NOT_POSITIVE, nothing written',
        async (_n, deltaMinor) => {
          const c = await signed();
          const res = await propose(api, c.id, c.employerToken, proposeBody({ deltaMinor })).expect(
            422,
          );
          expect(res.body.code).toBe('BUSINESS_RULE_VIOLATION');
          expect(reasons(res.body)).toEqual(['amendment:AMENDMENT_DELTA_NOT_POSITIVE']);
          expect(await amendmentRows(w, c.id)).toEqual([]);
        },
      );

      it.each([
        ['past a bigint', '9223372036854775808'],
        ['thirty digits', '999999999999999999999999999999'],
        ['a decimal', '1.5'],
        ['an exponent', '1e6'],
        ['blank', ''],
      ])('%s is a 400 at the boundary', async (_n, deltaMinor) => {
        const c = await signed();
        await propose(api, c.id, c.employerToken, proposeBody({ deltaMinor })).expect(400);
        expect(await amendmentRows(w, c.id)).toEqual([]);
      });

      it('a JSON number is a 400: money is never a float', async () => {
        const c = await signed();
        await propose(api, c.id, c.employerToken, proposeBody({ deltaMinor: 1000 })).expect(400);
      });

      it('1 is the smallest change and is exact; so is a delta past 2^53', async () => {
        const c = await signed();
        const one = await propose(
          api,
          c.id,
          c.employerToken,
          proposeBody({ deltaMinor: '1' }),
        ).expect(201);
        expect(one.body.deltaMinor).toBe('1');
        const big = await propose(
          api,
          c.id,
          c.employerToken,
          proposeBody({ deltaMinor: '9007199254740993' }),
        ).expect(201);
        expect(big.body.deltaMinor).toBe('9007199254740993');
        const stored = await amendmentRows(w, c.id);
        expect(stored.map((row) => row.deltaMinor)).toEqual([1n, 9007199254740993n]);
      });

      it('the price plus its amendments never passes a bigint: refused when proposed and again when signed', async () => {
        const max = 9_223_372_036_854_775_807n;
        // The award's price leaves room for 7 and no more.
        const c = await signed({ amountMinor: (max - 7n).toString() });

        // 8 does not fit at all.
        const tooBig = await propose(
          api,
          c.id,
          c.employerToken,
          proposeBody({ deltaMinor: '8' }),
        ).expect(422);
        expect(reasons(tooBig.body)).toEqual(['amendment:AMENDMENT_EXCEEDS_LIMIT']);
        expect(await amendmentRows(w, c.id)).toEqual([]);

        // Two sevens each fit alone. The first becomes effective: the price stands at the edge.
        const first = (
          await propose(api, c.id, c.employerToken, proposeBody({ deltaMinor: '7' })).expect(201)
        ).body;
        const second = (
          await propose(api, c.id, c.employerToken, proposeBody({ deltaMinor: '7' })).expect(201)
        ).body;
        await signAmendment(api, c.id, first.id, c.employerToken).expect(200);
        await signAmendment(api, c.id, first.id, c.contractorToken).expect(200);
        const row = await contractRow(w, c.id);
        expect(row.amendmentsTotalMinor).toBe(7n);
        expect(row.amountMinor + row.amendmentsTotalMinor).toBe(max);

        // The second no longer fits: refused at its signature, whichever side signs, and nothing is recorded.
        const refused = await signAmendment(api, c.id, second.id, c.employerToken).expect(422);
        expect(reasons(refused.body)).toEqual(['amendment:AMENDMENT_EXCEEDS_LIMIT']);
        await signAmendment(api, c.id, second.id, c.contractorToken).expect(422);
        expect(await amendmentSignatures(w, second.id)).toEqual([]);
        expect((await contractRow(w, c.id)).amendmentsTotalMinor).toBe(7n);

        // And nothing more can be proposed.
        await propose(api, c.id, c.employerToken, proposeBody({ deltaMinor: '1' })).expect(422);
      });
    });

    it('refuses what the shape does not allow: a body that names the status, the proposer or the number', async () => {
      const c = await signed();
      for (const extra of ['status', 'proposedBy', 'amendmentNumber', 'organizationId', 'side']) {
        await propose(api, c.id, c.employerToken, proposeBody({ [extra]: 'x' })).expect(400);
      }
      await propose(api, c.id, c.employerToken, proposeBody({ reasonText: '' })).expect(400);
      await propose(api, c.id, c.employerToken, proposeBody({ reasonText: 'a‮b' })).expect(400);
      await propose(
        api,
        c.id,
        c.employerToken,
        proposeBody({ reasonText: 'x'.repeat(1001) }),
      ).expect(400);
      expect(await amendmentRows(w, c.id)).toEqual([]);
    });

    it('a reason outside the configured list is 422 AMENDMENT_REASON_NOT_ALLOWED', async () => {
      const c = await signed();
      const res = await propose(
        api,
        c.id,
        c.employerToken,
        proposeBody({ reasonCode: 'SCHEDULE_CHANGE' }),
      ).expect(422);
      expect(reasons(res.body)).toEqual(['amendment:AMENDMENT_REASON_NOT_ALLOWED']);
    });

    it('only a SIGNED contract is amended: a draft is 422 CONTRACT_NOT_SIGNED', async () => {
      const draft = await seedDraft(w, organizations);
      const token = person(draft.employer, ['ORGANIZATION_ADMIN']);
      const res = await propose(api, draft.id, token).expect(422);
      expect(reasons(res.body)).toEqual(['amendment:CONTRACT_NOT_SIGNED']);
    });

    it('takes an optional contract version: a stale one is 409 and writes nothing', async () => {
      const c = await signed();
      const row = await contractRow(w, c.id);
      await propose(
        api,
        c.id,
        c.employerToken,
        proposeBody({ expectedVersion: row.version + 1 }),
      ).expect(409);
      expect(await amendmentRows(w, c.id)).toEqual([]);
      await propose(
        api,
        c.id,
        c.employerToken,
        proposeBody({ expectedVersion: row.version }),
      ).expect(201);
    });

    describe('who proposes', () => {
      it('the contractor is 403 PROPOSER_NOT_EMPLOYER, and the refusal is an audit record', async () => {
        const c = await signed();
        const res = await propose(api, c.id, c.contractorToken).expect(403);
        expect(res.body.code).toBe('FORBIDDEN');
        expect(reasons(res.body)).toEqual(['amendment:PROPOSER_NOT_EMPLOYER']);
        expect(await amendmentRows(w, c.id)).toEqual([]);
        const refused = await refusedEvents(c.employer);
        expect(refused).toHaveLength(1);
        expect(refused[0]!.payload).toMatchObject({
          contractId: c.id,
          action: 'PROPOSE_AMENDMENT',
          side: 'CONTRACTOR',
          subjectId: null,
          reason: 'NOT_EMPLOYER',
          policyId: null,
        });
        expect(refused[0]!.payload.refusedBy).toEqual(expect.any(String));
      });

      it('an employer role CONTRACT_AMENDMENT_ROLES does not name is 403 INSUFFICIENT_ROLE, recorded', async () => {
        const c = await signed();
        const res = await propose(api, c.id, person(c.employer, ['FLEET_MANAGER'])).expect(403);
        expect(res.body.code).toBe('INSUFFICIENT_ROLE');
        const refused = await refusedEvents(c.employer);
        expect(refused.map((e) => e.payload.reason)).toEqual(['ROLE_NOT_PERMITTED']);
      });

      it('the platform administrator, the oversight role, a service token and a token without a user id are refused before anything is read', async () => {
        const c = await signed();
        const refusedBefore = (await refusedEvents(c.employer)).length;
        await propose(api, c.id, systemAdminOf(c.employer)).expect(403);
        await propose(api, c.id, auditor(c.employer)).expect(403);
        await http(api)
          .post(`/v1/contracts/${c.id}/amendments`)
          .set(
            'x-internal-token',
            await internalToken('construction-service', { organizationId: c.employer }),
          )
          .set('idempotency-key', idemKey('svc'))
          .send(proposeBody())
          .expect(403);
        await propose(
          api,
          c.id,
          person(c.employer, ['ORGANIZATION_ADMIN'], { rastaUserId: undefined }),
        ).expect(403);
        await propose(api, c.id, undefined).expect(401);
        expect(await amendmentRows(w, c.id)).toEqual([]);
        expect((await refusedEvents(c.employer)).length).toBe(refusedBefore);
      });
    });
  });

  describe('POST /v1/contracts/{id}/amendments/{amendmentId}/sign', () => {
    it('the employer then the contractor: PROPOSED after the first, EFFECTIVE with the second, which moves the contract total in the same transaction', async () => {
      const c = await signed();
      const contractBefore = await contractRow(w, c.id);
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;

      const first = await signAmendment(api, c.id, proposed.id, c.employerToken).expect(200);
      expect(first.body).toMatchObject({ status: 'PROPOSED', version: 1, effectiveAt: null });
      expect(first.body.employerSignedAt).toEqual(expect.any(String));
      expect(first.body.contractorSignedAt).toBeNull();
      expect((await contractRow(w, c.id)).amendmentsTotalMinor).toBe(0n);

      const second = await signAmendment(api, c.id, proposed.id, c.contractorToken).expect(200);
      expect(second.body).toMatchObject({ status: 'EFFECTIVE', version: 2 });
      expect(second.body.effectiveAt).toBe(second.body.contractorSignedAt);

      const contract = await contractRow(w, c.id);
      expect(contract.amendmentsTotalMinor).toBe(250_000_000n);
      expect(contract.version).toBe(contractBefore.version + 1);
      expect(contract.status).toBe('SIGNED');
      expect(contract.amountMinor).toBe(contractBefore.amountMinor);

      const view = await http(api)
        .get(`/v1/contracts/${c.id}`)
        .set('authorization', `Bearer ${c.contractorToken}`)
        .expect(200);
      expect(view.body).toMatchObject({
        amountMinor: c.award.amountMinor,
        amendmentsTotalMinor: '250000000',
        currentAmountMinor: (BigInt(c.award.amountMinor) + 250_000_000n).toString(),
      });

      const events = (await eventsOf(w.prisma, c.employer)).filter((e) =>
        e.eventName.startsWith('CONTRACT_AMEND'),
      );
      expect(events.map((e) => e.eventName)).toEqual([
        'CONTRACT_AMENDMENT_PROPOSED',
        'CONTRACT_AMENDMENT_SIGNATURE_RECORDED',
        'CONTRACT_AMENDMENT_SIGNATURE_RECORDED',
        'CONTRACT_AMENDED',
      ]);
      expect(events[3]!.payload).toEqual({
        contractId: c.id,
        amendmentId: proposed.id,
        amendmentNumber: 1,
        organizationId: c.employer,
        contractorOrganizationId: c.contractor,
        reasonCode: 'SCOPE_CHANGE',
        employerSignedAt: first.body.employerSignedAt,
        contractorSignedAt: second.body.contractorSignedAt,
        effectiveAt: second.body.contractorSignedAt,
      });
      // No amount, no text, on any event of the amendment.
      expect(JSON.stringify(events)).not.toContain('250000000');
      expect(JSON.stringify(events)).not.toContain('pile work');
    });

    it('the contractor first, the employer second: the same amendment, whichever signs first', async () => {
      const c = await signed();
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
      const first = await signAmendment(api, c.id, proposed.id, c.contractorToken).expect(200);
      expect(first.body.status).toBe('PROPOSED');
      const second = await signAmendment(api, c.id, proposed.id, c.employerToken).expect(200);
      expect(second.body.status).toBe('EFFECTIVE');
      expect((await contractRow(w, c.id)).amendmentsTotalMinor).toBe(250_000_000n);
    });

    it('records what each signature rested on: the policy for the employer, the CONTRACTOR role for the contractor, and the hierarchy answer', async () => {
      const c = await signed();
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
      await signAmendment(api, c.id, proposed.id, c.employerToken).expect(200);
      await signAmendment(api, c.id, proposed.id, c.contractorToken).expect(200);

      const [employer, contractor] = (await amendmentSignatures(w, proposed.id)).sort((a, b) =>
        a.side === 'EMPLOYER' ? -1 : b.side === 'EMPLOYER' ? 1 : 0,
      );
      expect(employer).toMatchObject({
        side: 'EMPLOYER',
        signerOrganizationId: c.employer,
        authorityRole: 'ORGANIZATION_ADMIN',
        policyVersion: 1,
        hierarchyAnswer: 'WITHIN',
      });
      expect(employer!.policyId).toEqual(expect.any(String));
      expect(employer!.hierarchyVersion).toBe(1n);
      expect(employer!.hierarchyCommitDeadline!.getTime()).toBeGreaterThan(
        employer!.hierarchyReadAt!.getTime(),
      );
      expect(contractor).toMatchObject({
        side: 'CONTRACTOR',
        signerOrganizationId: c.contractor,
        authorityRole: 'CONTRACTOR',
        policyId: null,
        policyVersion: null,
        hierarchyReadAt: null,
        hierarchyVersion: null,
      });
    });

    it('is idempotent in substance: the same person on the same side again changes nothing, even once effective', async () => {
      const c = await signed();
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
      await signAmendment(api, c.id, proposed.id, c.employerToken).expect(200);
      await signAmendment(api, c.id, proposed.id, c.employerToken).expect(200);
      expect(await amendmentSignatures(w, proposed.id)).toHaveLength(1);
      await signAmendment(api, c.id, proposed.id, c.contractorToken).expect(200);
      const again = await signAmendment(api, c.id, proposed.id, c.contractorToken).expect(200);
      expect(again.body.status).toBe('EFFECTIVE');
      expect(await amendmentSignatures(w, proposed.id)).toHaveLength(2);
      expect((await contractRow(w, c.id)).amendmentsTotalMinor).toBe(250_000_000n);
      const events = await eventsOf(w.prisma, c.employer, 'CONTRACT_AMENDED');
      expect(events).toHaveLength(1);
    });

    it('another person for a side that has signed is 409 SIDE_ALREADY_SIGNED and writes nothing', async () => {
      const c = await signed();
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
      await signAmendment(api, c.id, proposed.id, c.employerToken).expect(200);
      const events = (await eventsOf(w.prisma, c.employer)).length;
      const other = await signAmendment(
        api,
        c.id,
        proposed.id,
        person(c.employer, ['ORGANIZATION_ADMIN']),
      ).expect(409);
      expect(other.body.code).toBe('ALREADY_EXISTS');
      expect(reasons(other.body)).toEqual(['amendment:SIDE_ALREADY_SIGNED']);
      expect(await amendmentSignatures(w, proposed.id)).toHaveLength(1);
      expect(await eventsOf(w.prisma, c.employer)).toHaveLength(events);
    });

    it('a signature by a new person once the amendment is effective is 409 SIDE_ALREADY_SIGNED, and changes nothing', async () => {
      const c = await signed();
      const id = await effective(c);
      const late = await signAmendment(
        api,
        c.id,
        id,
        person(c.employer, ['ORGANIZATION_ADMIN']),
      ).expect(409);
      expect(reasons(late.body)).toEqual(['amendment:SIDE_ALREADY_SIGNED']);
    });

    describe('separation of duties (#188), as for the contract', () => {
      it('refuses the person who signed the other side, on the same subject under another user id and on the same user id under another subject', async () => {
        const c = await signed();
        const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
        const sub = `sub-${ulid()}`;
        await signAmendment(
          api,
          c.id,
          proposed.id,
          person(c.employer, ['ORGANIZATION_ADMIN'], { sub, rastaUserId: 'USR-AAAAAAA1' }),
        ).expect(200);

        const asContractor = await signAmendment(
          api,
          c.id,
          proposed.id,
          person(c.contractor, ['CONTRACTOR'], { sub, rastaUserId: 'USR-AAAAAAA2' }),
        ).expect(403);
        expect(reasons(asContractor.body)).toEqual(['amendment:SAME_PERSON_BOTH_SIDES']);
        await signAmendment(
          api,
          c.id,
          proposed.id,
          person(c.contractor, ['CONTRACTOR'], {
            sub: `sub-${ulid()}`,
            rastaUserId: 'USR-AAAAAAA1',
          }),
        ).expect(403);
        expect(await amendmentSignatures(w, proposed.id)).toHaveLength(1);
      });

      it('refuses a member of both parties, whichever side they act for', async () => {
        const c = await signed();
        const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
        const asEmployer = await signAmendment(
          api,
          c.id,
          proposed.id,
          person(c.employer, ['ORGANIZATION_ADMIN'], { memberships: [c.contractor] }),
        ).expect(403);
        expect(reasons(asEmployer.body)).toEqual(['amendment:MEMBER_OF_BOTH_PARTIES']);
        await signAmendment(
          api,
          c.id,
          proposed.id,
          person(c.contractor, ['CONTRACTOR'], { memberships: [c.employer] }),
        ).expect(403);
        expect(await amendmentSignatures(w, proposed.id)).toEqual([]);
      });

      it('fails closed when the two signers cannot be told apart: 422 ACTOR_IDENTITY_UNKNOWN', async () => {
        const c = await signed();
        const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
        await signAmendment(api, c.id, proposed.id, c.employerToken).expect(200);
        const unknown = await signAmendment(
          api,
          c.id,
          proposed.id,
          person(c.contractor, ['CONTRACTOR'], { iss: 'http://other-issuer.invalid/realms/x' }),
        ).expect(422);
        expect(unknown.body.code).toBe('ACTOR_IDENTITY_UNKNOWN');
        expect(reasons(unknown.body)).toEqual(['amendment:ACTOR_IDENTITY_UNKNOWN']);
        expect(await amendmentSignatures(w, proposed.id)).toHaveLength(1);
      });
    });

    describe('authority is the employer’s policy and the contractor’s own role', () => {
      it('an employer role the signing policy does not name is 403 INSUFFICIENT_ROLE, recorded as ROLE_NOT_PERMITTED; so is a contractor without the role', async () => {
        const c = await signed();
        const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
        const employer = await signAmendment(
          api,
          c.id,
          proposed.id,
          person(c.employer, ['FLEET_MANAGER']),
        ).expect(403);
        expect(employer.body.code).toBe('INSUFFICIENT_ROLE');
        const contractor = await signAmendment(
          api,
          c.id,
          proposed.id,
          person(c.contractor, ['DRIVER']),
        ).expect(403);
        expect(contractor.body.code).toBe('INSUFFICIENT_ROLE');
        const refused = await refusedEvents(c.employer);
        expect(refused.map((e) => [e.payload.action, e.payload.side, e.payload.reason])).toEqual([
          ['SIGN_AMENDMENT', 'EMPLOYER', 'ROLE_NOT_PERMITTED'],
          ['SIGN_AMENDMENT', 'CONTRACTOR', 'ROLE_NOT_PERMITTED'],
        ]);
        expect(refused[0]!.payload.subjectId).toBe(proposed.id);
        expect(await amendmentSignatures(w, proposed.id)).toEqual([]);
      });

      it('the platform administrator, the oversight role, a service token and a token without a user id sign nothing', async () => {
        const c = await signed();
        const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
        await signAmendment(api, c.id, proposed.id, systemAdminOf(c.employer)).expect(403);
        await signAmendment(api, c.id, proposed.id, auditor(c.employer)).expect(403);
        await http(api)
          .post(`/v1/contracts/${c.id}/amendments/${proposed.id}/sign`)
          .set(
            'x-internal-token',
            await internalToken('construction-service', { organizationId: c.employer }),
          )
          .set('idempotency-key', idemKey('svc'))
          .send({})
          .expect(403);
        await signAmendment(
          api,
          c.id,
          proposed.id,
          person(c.employer, ['ORGANIZATION_ADMIN'], { rastaUserId: undefined }),
        ).expect(403);
        await signAmendment(api, c.id, proposed.id, undefined).expect(401);
        expect(await amendmentSignatures(w, proposed.id)).toEqual([]);
      });
    });

    it('takes an optional amendment version: a stale one is 409 and records nothing', async () => {
      const c = await signed();
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
      await signAmendment(api, c.id, proposed.id, c.employerToken, { expectedVersion: 5 }).expect(
        409,
      );
      expect(await amendmentSignatures(w, proposed.id)).toEqual([]);
      await signAmendment(api, c.id, proposed.id, c.employerToken, { expectedVersion: 1 }).expect(
        200,
      );
    });

    it('refuses a body that names a side, a signer or a policy', async () => {
      const c = await signed();
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
      for (const extra of ['side', 'signedBy', 'policyId', 'organizationId']) {
        await signAmendment(api, c.id, proposed.id, c.employerToken, { [extra]: 'x' }).expect(400);
      }
    });
  });

  describe('amendments accumulate, each exactly once', () => {
    it('three effective amendments sum on the contract: the total is the sum of the deltas, the version moves each time', async () => {
      const c = await signed();
      const start = await contractRow(w, c.id);
      for (const deltaMinor of ['100', '2000', '30000']) {
        await effective(c, proposeBody({ deltaMinor }));
      }
      const row = await contractRow(w, c.id);
      expect(row.amendmentsTotalMinor).toBe(32_100n);
      expect(row.version).toBe(start.version + 3);
      const view = await http(api)
        .get(`/v1/contracts/${c.id}`)
        .set('authorization', `Bearer ${c.employerToken}`)
        .expect(200);
      expect(view.body.currentAmountMinor).toBe((BigInt(c.award.amountMinor) + 32_100n).toString());
    });

    it('a proposal nobody signs counts for nothing', async () => {
      const c = await signed();
      await effective(c, proposeBody({ deltaMinor: '5' }));
      await propose(api, c.id, c.employerToken, proposeBody({ deltaMinor: '99999' })).expect(201);
      expect((await contractRow(w, c.id)).amendmentsTotalMinor).toBe(5n);
    });

    it('both parties signing at the same moment: both 200, one effective amendment, the total moved once, one CONTRACT_AMENDED', async () => {
      const c = await signed();
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
      const [a, b] = await Promise.all([
        signAmendment(api, c.id, proposed.id, c.employerToken),
        signAmendment(api, c.id, proposed.id, c.contractorToken),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a.body.status, b.body.status].sort()).toEqual(['EFFECTIVE', 'PROPOSED']);
      expect((await amendmentRows(w, c.id))[0]).toMatchObject({ status: 'EFFECTIVE', version: 2 });
      expect((await contractRow(w, c.id)).amendmentsTotalMinor).toBe(250_000_000n);
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_AMENDED')).toHaveLength(1);
      expect(await amendmentSignatures(w, proposed.id)).toHaveLength(2);
    });

    it('queued behind the contract’s lock, the signatures of three amendments are ordered and every delta is counted once — no lost update', async () => {
      const c = await signed();
      const ids: string[] = [];
      for (const deltaMinor of ['11', '22', '33']) {
        ids.push(
          (await propose(api, c.id, c.employerToken, proposeBody({ deltaMinor })).expect(201)).body
            .id,
        );
      }
      // Hold the contract's row lock, start all six signatures, and prove they are queued on it.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const lockTaken = new Promise<void>((resolve) => (locked = resolve));
      const holder = w.prisma.transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM contract WHERE organization_id = ${c.employer} AND id = ${c.id} FOR UPDATE`;
          locked();
          await held;
        },
        { timeoutMs: 60_000 },
      );
      await lockTaken;
      // Awaiting starts each request (supertest is lazy until then).
      const running = Promise.all(
        ids.flatMap((id) => [
          signAmendment(api, c.id, id, c.employerToken),
          signAmendment(api, c.id, id, c.contractorToken),
        ]),
      );
      await untilSessionsWaitOnALock(w.prisma, 6);
      release();
      await holder;
      const results = await running;
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);

      const row = await contractRow(w, c.id);
      expect(row.amendmentsTotalMinor).toBe(66n);
      expect((await amendmentRows(w, c.id)).map((a) => a.status)).toEqual([
        'EFFECTIVE',
        'EFFECTIVE',
        'EFFECTIVE',
      ]);
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_AMENDED')).toHaveLength(3);
    });
  });

  describe('an effective amendment is history', () => {
    it('the database refuses to change, delete or truncate it, its signatures or the total it made — whatever the code forgets', async () => {
      const c = await signed();
      const id = await effective(c);
      const refuses = async (sql: string, pattern: RegExp) =>
        expect(w.prisma.client.$executeRawUnsafe(sql)).rejects.toThrow(pattern);

      await refuses(
        `UPDATE amendment SET reason_text = 'edited' WHERE id = '${id}'`,
        /ck_amendment_immutable/,
      );
      await refuses(
        `UPDATE amendment SET delta_minor = 1 WHERE id = '${id}'`,
        /ck_amendment_immutable/,
      );
      await refuses(`DELETE FROM amendment WHERE id = '${id}'`, /ck_amendment_not_erasable/);
      await refuses(
        `UPDATE amendment_signature SET signed_by = 'x' WHERE amendment_id = '${id}'`,
        /ck_amendment_signature_immutable/,
      );
      await refuses(
        `DELETE FROM amendment_signature WHERE amendment_id = '${id}'`,
        /ck_amendment_signature_immutable/,
      );
      await refuses(
        `UPDATE contract SET amendments_total_minor = 0 WHERE id = '${c.id}'`,
        /ck_contract_amendments_total_exact/,
      );
      expect((await contractRow(w, c.id)).amendmentsTotalMinor).toBe(250_000_000n);
      expect((await amendmentRows(w, c.id))[0]).toMatchObject({
        status: 'EFFECTIVE',
        deltaMinor: 250_000_000n,
        reasonText: 'Additional pile work agreed on site',
      });
    });

    it('the API has no route that edits, withdraws or deletes one', async () => {
      const c = await signed();
      const id = await effective(c);
      for (const method of ['patch', 'put', 'delete'] as const) {
        await request(api.app.getHttpServer())
          [method](`/v1/contracts/${c.id}/amendments/${id}`)
          .set('authorization', `Bearer ${c.employerToken}`)
          .send({})
          .expect(404);
      }
    });
  });

  describe('Idempotency-Key on every command (docs/06 § 6.8)', () => {
    it('is required: without one, or one outside 8 to 255 characters, 400 and nothing is done', async () => {
      const c = await signed();
      const bare = () => http(api).post(`/v1/contracts/${c.id}/amendments`);
      await bare()
        .set('authorization', `Bearer ${c.employerToken}`)
        .send(proposeBody())
        .expect(400);
      await bare()
        .set('authorization', `Bearer ${c.employerToken}`)
        .set('idempotency-key', 'short')
        .send(proposeBody())
        .expect(400);
      await bare()
        .set('authorization', `Bearer ${c.employerToken}`)
        .set('idempotency-key', 'k'.repeat(256))
        .send(proposeBody())
        .expect(400);
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
      await http(api)
        .post(`/v1/contracts/${c.id}/amendments/${proposed.id}/sign`)
        .set('authorization', `Bearer ${c.employerToken}`)
        .send({})
        .expect(400);
      expect(await amendmentRows(w, c.id)).toHaveLength(1);
      expect(await amendmentSignatures(w, proposed.id)).toEqual([]);
    });

    it('a retried proposal answers the first response and proposes once; the same key with another body or user is 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const c = await signed();
      const key = idemKey('retry');
      const first = await propose(api, c.id, c.employerToken, proposeBody(), key).expect(201);
      const again = await propose(api, c.id, c.employerToken, proposeBody(), key).expect(201);
      expect(again.body).toEqual(first.body);
      expect(await amendmentRows(w, c.id)).toHaveLength(1);
      expect(await eventsOf(w.prisma, c.employer, 'CONTRACT_AMENDMENT_PROPOSED')).toHaveLength(1);

      const other = await propose(
        api,
        c.id,
        c.employerToken,
        proposeBody({ deltaMinor: '999' }),
        key,
      ).expect(409);
      expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const otherUser = await propose(
        api,
        c.id,
        person(c.employer, ['ORGANIZATION_ADMIN']),
        proposeBody(),
        key,
      ).expect(409);
      expect(otherUser.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await amendmentRows(w, c.id)).toHaveLength(1);
    });

    it('a retried signature answers the amendment as it is now, and records once', async () => {
      const c = await signed();
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
      const key = idemKey('retry-sign');
      const first = await signAmendment(api, c.id, proposed.id, c.employerToken, {}, key).expect(
        200,
      );
      expect(first.body.status).toBe('PROPOSED');
      await signAmendment(api, c.id, proposed.id, c.contractorToken).expect(200);
      // The replay is the amendment as of now — effective — not the stored snapshot.
      const replay = await signAmendment(api, c.id, proposed.id, c.employerToken, {}, key).expect(
        200,
      );
      expect(replay.body.status).toBe('EFFECTIVE');
      expect(await amendmentSignatures(w, proposed.id)).toHaveLength(2);
    });

    it('is scoped to the organization: the same key by the two parties is two requests', async () => {
      const c = await signed();
      const proposed = (await propose(api, c.id, c.employerToken).expect(201)).body;
      const key = idemKey('both-sides');
      await signAmendment(api, c.id, proposed.id, c.employerToken, {}, key).expect(200);
      const second = await signAmendment(api, c.id, proposed.id, c.contractorToken, {}, key).expect(
        200,
      );
      expect(second.body.status).toBe('EFFECTIVE');
    });

    it('the same key used by a stranger finds no contract: 404, never the first caller’s response', async () => {
      const c = await signed();
      const key = idemKey('replay-404');
      await propose(api, c.id, c.employerToken, proposeBody(), key).expect(201);
      // The same organization's key, replayed by someone of another organization, is another key.
      const stranger = person(`ORG_${ulid()}`, ['ORGANIZATION_ADMIN']);
      await propose(api, c.id, stranger, proposeBody(), key).expect(404);
    });
  });

  describe('tenant isolation (S-03): another organization is told 404, as for a contract that is not there', () => {
    it('cannot list, read, propose or sign — and leaves no trace and no audit record', async () => {
      const c = await signed();
      const id = await effective(c);
      const pending = (await propose(api, c.id, c.employerToken).expect(201)).body;
      const strangerOrg = `ORG_${ulid()}`;
      organizations.push(strangerOrg);
      const strangers = [
        person(strangerOrg, ['ORGANIZATION_ADMIN']),
        person(strangerOrg, ['CONTRACTOR']),
        person(strangerOrg, ['ORGANIZATION_ADMIN', 'CONTRACTOR']),
      ];
      const audit = (await refusedEvents(c.employer)).length;
      const rows = (await amendmentRows(w, c.id)).length;
      const signatures = (await amendmentSignatures(w, pending.id)).length;

      for (const token of strangers) {
        await list(c.id, token).expect(404);
        await get(c.id, id, token).expect(404);
        await propose(api, c.id, token).expect(404);
        await signAmendment(api, c.id, pending.id, token).expect(404);
      }
      expect((await refusedEvents(c.employer)).length).toBe(audit);
      expect((await amendmentRows(w, c.id)).length).toBe(rows);
      expect((await amendmentSignatures(w, pending.id)).length).toBe(signatures);
    });

    it('the answer is the very 404 a contract that does not exist gets', async () => {
      const c = await signed();
      const stranger = person(`ORG_${ulid()}`, ['ORGANIZATION_ADMIN']);
      const real = await list(c.id, stranger).expect(404);
      const missing = await list(`CTR_${ulid()}`, stranger).expect(404);
      expect(bare(real.body).code).toBe(bare(missing.body).code);
      expect(Object.keys(bare(real.body))).toEqual(Object.keys(bare(missing.body)));
    });

    it('a party of one contract is a stranger to another: the winning contractor of one cannot touch the amendments of the next', async () => {
      const one = await signed();
      const two = await signed();
      const pending = (await propose(api, two.id, two.employerToken).expect(201)).body;
      await list(two.id, one.contractorToken).expect(404);
      await signAmendment(api, two.id, pending.id, one.contractorToken).expect(404);
      await signAmendment(api, two.id, pending.id, one.employerToken).expect(404);
      await propose(api, two.id, one.employerToken).expect(404);
    });

    it('an amendment is found only under its own contract: another contract’s amendment id is 404', async () => {
      const one = await signed();
      const two = await signed();
      const mine = (await propose(api, one.id, one.employerToken).expect(201)).body;
      await get(two.id, mine.id, two.employerToken).expect(404);
      await signAmendment(api, two.id, mine.id, two.employerToken).expect(404);
    });

    it('the AUDITOR and a service token read nothing', async () => {
      const c = await signed();
      await list(c.id, auditor(c.employer)).expect(403);
      await list(c.id, actor(c.employer, ['AUDITOR'])).expect(403);
      await http(api)
        .get(`/v1/contracts/${c.id}/amendments`)
        .set(
          'x-internal-token',
          await internalToken('economic-service', { organizationId: c.employer }),
        )
        .expect(403);
    });
  });
});
