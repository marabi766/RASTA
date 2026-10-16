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
import { http, idemKey, seedSigned, type SignedContract } from './amendment-helpers';
import {
  activateStatementPolicies,
  cleanup,
  eventsOf,
  newOrganizationId,
  wire,
  type SuiteStep,
  type Wiring,
} from './helpers';

/**
 * CON-003 PR 6a (ADR-068 § 6 (2), ADR-061 § 4, Q-97 (2)): `GET /v1/internal/statements/{id}`, the
 * read economic-service builds its obligation from. Only economic-service's service token, signed
 * for the employer; the stored row, whatever its status; the net as an exact decimal string. Any
 * other organization is 404 like a statement that does not exist; a user token, another service
 * and a token signed for no organization are 403. From the real `AppModule` over real guards, real
 * internal tokens and a real database.
 */
describe('the settlement read of a statement (CON-003 PR 6a)', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const MAX = 9223372036854775807n; // 2^63 - 1
  const ECONOMIC = 'economic-service';

  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const at = (organizationId: string, role = 'ORGANIZATION_ADMIN'): SuiteStep => ({
    authorityOrganizationId: organizationId,
    authorityRole: role,
  });
  /** A user's bearer token, or a service's internal token (`x-internal-token`, as services send it). */
  type Credential = { user: string } | { service: string };
  const read = (
    statementId: string,
    credential: Credential | undefined,
    organizationHeader?: string,
  ) => {
    const r = http(api).get(`/v1/internal/statements/${statementId}`);
    if (credential && 'user' in credential) r.set('authorization', `Bearer ${credential.user}`);
    if (credential && 'service' in credential) r.set('x-internal-token', credential.service);
    if (organizationHeader) r.set('x-organization-id', organizationHeader);
    return r;
  };
  const serviceFor = async (service: string, organizationId?: string): Promise<Credential> => ({
    service: await internalToken(service, organizationId ? { organizationId } : {}),
  });
  const economicFor = (organizationId: string) => serviceFor(ECONOMIC, organizationId);

  /** A signed contract whose chains are one employer step each: technical, then financial. */
  const contract = async (
    amountMinor = '1000000000',
    consultant?: string,
  ): Promise<SignedContract> => {
    const c = await seedSigned(api, w, organizations, { amountMinor });
    await activateStatementPolicies(w, c.employer, {
      technical: [consultant ? at(consultant, 'FLEET_MANAGER') : at(c.employer, 'FLEET_MANAGER')],
      financial: [at(c.employer)],
    });
    return c;
  };
  const drafted = async (c: SignedContract, amountMinor: string): Promise<string> =>
    (
      await http(api)
        .post(`/v1/contracts/${c.id}/statements`)
        .set('authorization', `Bearer ${c.contractorToken}`)
        .set('idempotency-key', idemKey('stm'))
        .send({ lines: [{ description: 'Piles and caps', amountMinor }] })
        .expect(201)
    ).body.id;
  const submit = (c: SignedContract, statementId: string) =>
    http(api)
      .post(`/v1/contracts/${c.id}/statements/${statementId}/submit`)
      .set('authorization', `Bearer ${c.contractorToken}`)
      .set('idempotency-key', idemKey('submit'))
      .send({})
      .expect(200);
  const decide = (
    c: SignedContract,
    statementId: string,
    token: string,
    chain: 'TECHNICAL' | 'FINANCIAL',
    decision: 'APPROVE' | 'REJECT' = 'APPROVE',
  ) =>
    http(api)
      .post(`/v1/contracts/${c.id}/statements/${statementId}/decisions`)
      .set('authorization', `Bearer ${token}`)
      .set('idempotency-key', idemKey('decide'))
      .send({ chain, stepOrder: 1, decision })
      .expect(200);
  const technicalToken = (c: SignedContract, consultant?: string) =>
    person(consultant ?? c.employer, ['FLEET_MANAGER']);
  /** A statement of `c` taken through both chains to APPROVED. */
  const approved = async (
    c: SignedContract,
    amountMinor: string,
    consultant?: string,
  ): Promise<string> => {
    const id = await drafted(c, amountMinor);
    await submit(c, id);
    await decide(c, id, technicalToken(c, consultant), 'TECHNICAL');
    await decide(c, id, person(c.employer, ['ORGANIZATION_ADMIN']), 'FINANCIAL');
    return id;
  };

  const statementRow = (id: string) =>
    runUnscoped('the suite reads a statement', () =>
      w.prisma.client.statement.findFirst({ where: { id } }),
    );
  const outboxCount = (organizationId: string) =>
    runUnscoped('the suite counts the outbox', () =>
      w.prisma.client.outboxMessage.count({ where: { organizationId } }),
    );

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  describe('economic-service, signed for the employer', () => {
    it('reads an APPROVED statement: the net as the exact decimal string at 2^63 - 1, rials, the employer pays the contractor, approved when STATEMENT_APPROVED says — which carries no amount — and nothing is written', async () => {
      const c = await contract(MAX.toString());
      const id = await approved(c, MAX.toString());
      const before = await statementRow(id);
      const outboxBefore = await outboxCount(c.employer);

      const res = await read(id, await economicFor(c.employer)).expect(200);

      const [event] = await eventsOf(w.prisma, c.employer, 'STATEMENT_APPROVED');
      expect(event).toBeDefined();
      expect(res.body).toEqual({
        statementId: id,
        contractId: c.id,
        status: 'APPROVED',
        netMinor: '9223372036854775807',
        currency: 'IRR',
        payerOrganizationId: c.employer,
        beneficiaryOrganizationId: c.contractor,
        approvedAt: event!.payload.approvedAt,
      });
      // The amount is exact in the raw body too, not a number a JSON parser could round.
      expect(res.text).toContain('"netMinor":"9223372036854775807"');
      // ADR-068 § 6 (2): the amount comes from this answer, never from the event.
      expect(Object.keys(event!.payload)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/amount|minor|net|gross/i)]),
      );
      // A read: the row and the outbox are as they were.
      expect(await statementRow(id)).toEqual(before);
      expect(await outboxCount(c.employer)).toBe(outboxBefore);
    });

    it('states the net — the gross less the deductions — from the stored row', async () => {
      const c = await contract('2000000000');
      const id = await approved(c, '1500000001');
      const row = await statementRow(id);
      const res = await read(id, await economicFor(c.employer)).expect(200);
      expect(res.body.netMinor).toBe(row!.netMinor.toString());
      expect(res.body.netMinor).toBe('1500000001');
    });

    it('answers a statement that is not APPROVED with its stored status and no approval instant — the reader refuses it, this route does not decide', async () => {
      const c = await contract();

      const draft = await drafted(c, '100');
      const submitted = await drafted(c, '200');
      await submit(c, submitted);
      const technicallyApproved = await drafted(c, '300');
      await submit(c, technicallyApproved);
      await decide(c, technicallyApproved, technicalToken(c), 'TECHNICAL');
      const rejected = await drafted(c, '400');
      await submit(c, rejected);
      await decide(c, rejected, technicalToken(c), 'TECHNICAL', 'REJECT');

      for (const [id, status, net] of [
        [draft, 'DRAFT', '100'],
        [submitted, 'SUBMITTED', '200'],
        [technicallyApproved, 'TECHNICALLY_APPROVED', '300'],
        [rejected, 'REJECTED', '400'],
      ] as const) {
        const res = await read(id, await economicFor(c.employer)).expect(200);
        expect(res.body).toEqual({
          statementId: id,
          contractId: c.id,
          status,
          netMinor: net,
          currency: 'IRR',
          payerOrganizationId: c.employer,
          beneficiaryOrganizationId: c.contractor,
          approvedAt: null,
        });
      }
    });
  });

  describe('every other organization is 404, exactly as a statement that does not exist (S-03)', () => {
    it('the contractor, a consultant its chain names, a stranger, and an id that does not exist all answer the same 404', async () => {
      const consultant = org();
      const stranger = org();
      const c = await contract('1000000000', consultant);
      const id = await approved(c, '5000', consultant);

      const missing = await read(`STM_${ulid()}`, await economicFor(c.employer)).expect(404);
      expect(missing.body).toMatchObject({ code: 'NOT_FOUND', message: 'Statement not found' });
      for (const organizationId of [c.contractor, consultant, stranger]) {
        const res = await read(id, await economicFor(organizationId)).expect(404);
        expect({ organizationId, code: res.body.code, message: res.body.message }).toEqual({
          organizationId,
          code: missing.body.code,
          message: missing.body.message,
        });
      }
    });

    it('the tenant is the signed one: X-Organization-Id cannot move a token to the employer (403), and agreeing with it changes nothing', async () => {
      const c = await contract();
      const id = await approved(c, '7000');
      const res = await read(id, await economicFor(c.contractor), c.employer).expect(403);
      expect(res.body.code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
      await read(id, await economicFor(c.employer), c.employer).expect(200);
    });
  });

  describe('only economic-service’s service token (ADR-061 § 4)', () => {
    let c: SignedContract;
    let id: string;

    beforeAll(async () => {
      c = await contract();
      id = await approved(c, '9000');
    });

    it('refuses every user token with 403 — the employer’s administrator, the platform administrator acting for it, the contractor, the oversight role', async () => {
      for (const [who, token] of [
        ['employer admin', person(c.employer, ['ORGANIZATION_ADMIN'])],
        ['system admin for the employer', systemAdminOf(c.employer)],
        ['contractor', person(c.contractor, ['CONTRACTOR'])],
        ['auditor', auditor(c.employer)],
      ] as const) {
        const res = await read(id, { user: token }, c.employer);
        expect({ who, status: res.status }).toEqual({ who, status: 403 });
        expect(res.body).not.toHaveProperty('netMinor');
      }
      // A user token beside economic-service's internal token is still a user (the gateway's
      // relay shape: the user token wins).
      const relayed = http(api)
        .get(`/v1/internal/statements/${id}`)
        .set('authorization', `Bearer ${person(c.employer, ['ORGANIZATION_ADMIN'])}`)
        .set('x-internal-token', await internalToken(ECONOMIC, { organizationId: c.employer }));
      expect((await relayed).status).toBe(403);
      // The refusal is the caller's, not the statement's: a user is 403 on one that does not exist too.
      const res = await read(`STM_${ulid()}`, { user: person(c.employer, ['ORGANIZATION_ADMIN']) });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('refuses every other service with 403, even signed for the employer', async () => {
      for (const service of [
        'marketplace-service',
        'construction-service',
        'audit-service',
        'contract-service',
      ]) {
        const res = await read(id, await serviceFor(service, c.employer));
        expect({ service, status: res.status, code: res.body.code }).toEqual({
          service,
          status: 403,
          code: 'FORBIDDEN',
        });
      }
    });

    it('refuses economic-service’s token signed for no organization with 403, and no token at all with 401', async () => {
      const unsigned = await read(id, await serviceFor(ECONOMIC));
      expect(unsigned.status).toBe(403);
      expect(unsigned.body.code).toBe('SERVICE_TENANT_CONTEXT_INVALID');
      await read(id, undefined).expect(401);
    });
  });

  describe('tenant isolation (AGENTS.md § 4)', () => {
    it('two employers: each reads only its own statements, the other’s is 404, and reading changes neither', async () => {
      const a = await contract('900000000000');
      const b = await contract('800000000000');
      const ofA = await approved(a, '123456789012');
      const ofB = await approved(b, '987654321');
      const rowsBefore = [await statementRow(ofA), await statementRow(ofB)];
      const tokenA = await economicFor(a.employer);
      const tokenB = await economicFor(b.employer);

      expect((await read(ofA, tokenA).expect(200)).body).toMatchObject({
        statementId: ofA,
        payerOrganizationId: a.employer,
        beneficiaryOrganizationId: a.contractor,
        netMinor: '123456789012',
      });
      expect((await read(ofB, tokenB).expect(200)).body).toMatchObject({
        statementId: ofB,
        payerOrganizationId: b.employer,
        beneficiaryOrganizationId: b.contractor,
        netMinor: '987654321',
      });
      for (const [statementId, token] of [
        [ofB, tokenA],
        [ofA, tokenB],
      ] as const) {
        const res = await read(statementId, token).expect(404);
        expect(res.body).toMatchObject({ code: 'NOT_FOUND', message: 'Statement not found' });
        expect(res.text).not.toContain('netMinor');
      }
      expect([await statementRow(ofA), await statementRow(ofB)]).toEqual(rowsBefore);
    });
  });
});
