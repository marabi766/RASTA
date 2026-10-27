import type { Server } from 'node:http';
import { expectNotDisclosed } from '@rasta/testing';
import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { StatementRepository } from '../src/statement/statement.repository';
import {
  auditor,
  internalToken,
  person,
  startApi,
  systemAdminOf,
  type ApiHarness,
} from './api-helpers';
import { http, idemKey, reasons, seedSigned, type SignedContract } from './amendment-helpers';
import {
  activatePolicy,
  activateStatementPolicies,
  asPlatform,
  asSetter,
  cleanup,
  eventsOf,
  newOrganizationId,
  untilSessionsWaitOnALock,
  wire,
  type SuiteStep,
  type Wiring,
} from './helpers';

/**
 * CON-003 PR 5 (ADR-068 § 5, Q-96 (1)–(3), Q-100 (4)): the contractor submits a draft statement,
 * and the submission snapshots both approval chains — the employer's `contract.statement.technical`
 * and `contract.statement.financial` policies in force, each reduced to the steps that apply to the
 * gross — in the transaction that moves it to SUBMITTED, marks its milestones referenced and writes
 * `STATEMENT_SUBMITTED`. No policy, or no step that applies, is 422: never a default approval. From
 * the real `AppModule` over real guards and a real database.
 */
describe('submitting a statement (CON-003 PR 5)', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];
  /** Barriers a test parks a request on; released after every test, so none is stranded. */
  const releases: (() => void)[] = [];

  const signed = (contractor?: string): Promise<SignedContract> =>
    seedSigned(api, w, organizations, contractor ? { winnerOrganizationId: contractor } : {});
  const own = (organizationId: string, role = 'ORGANIZATION_ADMIN'): SuiteStep => ({
    authorityOrganizationId: organizationId,
    authorityRole: role,
  });
  const lines = (...amounts: string[]) =>
    amounts.map((amountMinor, index) => ({ description: `Work ${index + 1}`, amountMinor }));
  const draft = async (
    c: SignedContract,
    body: object = { lines: lines('1200000000', '300000001') },
  ): Promise<{ id: string; version: number }> =>
    (
      await http(api)
        .post(`/v1/contracts/${c.id}/statements`)
        .set('authorization', `Bearer ${c.contractorToken}`)
        .set('idempotency-key', idemKey('stm'))
        .send(body)
        .expect(201)
    ).body;
  const submit = (
    contractId: string,
    statementId: string,
    token: string | undefined,
    body: object = {},
    /** `null`: no Idempotency-Key at all. */
    key: string | null = idemKey('submit'),
  ) => {
    const r = http(api).post(`/v1/contracts/${contractId}/statements/${statementId}/submit`);
    if (token) r.set('authorization', `Bearer ${token}`);
    if (key) r.set('idempotency-key', key);
    return r.send(body);
  };
  const read = (contractId: string, statementId: string, token: string) =>
    http(api)
      .get(`/v1/contracts/${contractId}/statements/${statementId}`)
      .set('authorization', `Bearer ${token}`);
  const plan = async (c: SignedContract) =>
    (
      await http(api)
        .post(`/v1/contracts/${c.id}/milestones`)
        .set('authorization', `Bearer ${c.employerToken}`)
        .set('idempotency-key', idemKey('mls'))
        .send({ title: 'Foundations poured', plannedDate: '2027-03-01' })
        .expect(201)
    ).body as { id: string; version: number };

  const statementRow = (id: string) =>
    runUnscoped('the suite reads a statement', () =>
      w.prisma.client.statement.findFirst({ where: { id }, include: { approvalSteps: true } }),
    );
  const snapshotRows = (statementId: string) =>
    runUnscoped('the suite reads the snapshot', () =>
      w.prisma.client.statementApprovalStep.findMany({
        where: { statementId },
        orderBy: [{ chain: 'desc' }, { stepOrder: 'asc' }],
      }),
    );
  const milestoneRow = (id: string) =>
    runUnscoped('the suite reads a milestone', () =>
      w.prisma.client.milestone.findFirst({ where: { id } }),
    );
  const submittedEvents = (employer: string) => eventsOf(w.prisma, employer, 'STATEMENT_SUBMITTED');
  const refusalsOf = async (employer: string) =>
    (await eventsOf(w.prisma, employer, 'CONTRACT_AUTHORITY_REFUSED')).map((e) => e.payload);
  /** Nothing of a refused submission is anywhere. */
  const untouched = async (c: SignedContract, statementId: string) => {
    expect(await statementRow(statementId)).toMatchObject({
      status: 'DRAFT',
      submittedAt: null,
      submittedBy: null,
      technicalStepCount: null,
      financialStepCount: null,
      version: 1,
      approvalSteps: [],
    });
    expect(await submittedEvents(c.employer)).toEqual([]);
  };

  beforeAll(async () => {
    api = await startApi();
    w = wire();
    // Listening before any request: a request parked on a barrier must not hold up supertest's
    // per-request listen/close of an idle server.
    const server = api.app.getHttpServer() as Server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });

  afterEach(() => {
    for (const release of releases.splice(0)) release();
    api.hierarchy.everyoneIsMine = true;
    api.hierarchy.unavailable = false;
    api.hierarchy.timedOut = false;
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  it('the contractor submits a draft: SUBMITTED, both chains snapshotted in policy order, who and when recorded, an event with no amount', async () => {
    const c = await signed();
    const consultant = newOrganizationId();
    organizations.push(consultant);
    const policies = await activateStatementPolicies(w, c.employer, {
      technical: [own(consultant), own(c.employer, 'FLEET_MANAGER')],
      financial: [own(c.employer)],
    });
    const made = await draft(c);

    const res = await submit(c.id, made.id, c.contractorToken, { expectedVersion: 1 }).expect(200);
    expect(res.body).toMatchObject({
      id: made.id,
      status: 'SUBMITTED',
      version: 2,
      submittedAt: expect.any(String),
      approvalChains: {
        technical: {
          policyId: policies.technical,
          policyVersion: 1,
          steps: [
            {
              stepOrder: 1,
              authorityOrganizationId: consultant,
              authorityRole: 'ORGANIZATION_ADMIN',
              authorityLabel: 'Authority 1',
            },
            {
              stepOrder: 2,
              authorityOrganizationId: c.employer,
              authorityRole: 'FLEET_MANAGER',
              authorityLabel: 'Authority 2',
            },
          ],
        },
        financial: {
          policyId: policies.financial,
          policyVersion: 1,
          steps: [
            {
              stepOrder: 1,
              authorityOrganizationId: c.employer,
              authorityRole: 'ORGANIZATION_ADMIN',
              authorityLabel: 'Authority 1',
            },
          ],
        },
      },
    });
    // Both parties read it as it was answered.
    expect((await read(c.id, made.id, c.employerToken).expect(200)).body).toEqual(res.body);

    const row = await statementRow(made.id);
    expect(row).toMatchObject({
      status: 'SUBMITTED',
      technicalStepCount: 2,
      financialStepCount: 1,
      submittedBy: expect.stringMatching(/^USR-APITEST-/),
      submittedByIssuer: expect.any(String),
      submittedBySubject: expect.any(String),
    });
    expect(row!.submittedAt!.toISOString()).toBe(res.body.submittedAt);
    expect(
      row!.approvalSteps.every((step) => step.createdAt.getTime() === row!.submittedAt!.getTime()),
    ).toBe(true);

    const [event] = await submittedEvents(c.employer);
    expect(event!.payload).toEqual({
      contractId: c.id,
      statementId: made.id,
      statementNumber: 1,
      organizationId: c.employer,
      contractorOrganizationId: c.contractor,
      technicalPolicyId: policies.technical,
      technicalPolicyVersion: 1,
      financialPolicyId: policies.financial,
      financialPolicyVersion: 1,
      milestoneIds: [],
      submittedBy: row!.submittedBy,
      submittedAt: res.body.submittedAt,
    });
    expectNotDisclosed(event, ['1500000001', '1200000000', 'Work 1', row!.submittedBySubject!]);
  });

  it('two steps naming the same organization and role are both snapshotted, in order: a chain asks two people, not one authority once', async () => {
    const c = await signed();
    await activateStatementPolicies(w, c.employer, {
      technical: [own(c.employer), own(c.employer)],
      financial: [own(c.employer), own(c.employer, 'FLEET_MANAGER'), own(c.employer)],
    });
    const made = await draft(c);
    const res = await submit(c.id, made.id, c.contractorToken).expect(200);
    const chain = (steps: { stepOrder: number; authorityRole: string }[]) =>
      steps.map((step) => [step.stepOrder, step.authorityRole]);
    expect(chain(res.body.approvalChains.technical.steps)).toEqual([
      [1, 'ORGANIZATION_ADMIN'],
      [2, 'ORGANIZATION_ADMIN'],
    ]);
    expect(chain(res.body.approvalChains.financial.steps)).toEqual([
      [1, 'ORGANIZATION_ADMIN'],
      [2, 'FLEET_MANAGER'],
      [3, 'ORGANIZATION_ADMIN'],
    ]);
    expect(await statementRow(made.id)).toMatchObject({
      technicalStepCount: 2,
      financialStepCount: 3,
    });
    expect(await snapshotRows(made.id)).toHaveLength(5);
  });

  describe('no complete chain, no submission (422, nothing written)', () => {
    it('no policy in force for either chain, or for one', async () => {
      const c = await signed();
      const made = await draft(c);
      const none = await submit(c.id, made.id, c.contractorToken).expect(422);
      expect(none.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(reasons(none.body)).toEqual([
        'statement:TECHNICAL_POLICY_REQUIRED',
        'statement:FINANCIAL_POLICY_REQUIRED',
      ]);
      await activatePolicy(w, c.employer, 'contract.statement.technical', [own(c.employer)]);
      const half = await submit(c.id, made.id, c.contractorToken).expect(422);
      expect(reasons(half.body)).toEqual(['statement:FINANCIAL_POLICY_REQUIRED']);
      await untouched(c, made.id);
      // A refusal of configuration is answered, not recorded as a party's want of authority.
      expect(await refusalsOf(c.employer)).toEqual([]);
    });

    it('a chain whose steps all lie outside the gross; the steps that apply are the chain (min inclusive, max exclusive)', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer, {
        technical: [
          own(c.employer),
          { ...own(c.employer, 'FLEET_MANAGER'), minAmountMinor: '1000' },
          { ...own(c.employer, 'UNION_ADMIN'), maxAmountMinor: '1000' },
        ],
        financial: [{ ...own(c.employer), minAmountMinor: '1000' }],
      });
      const small = await draft(c, { lines: lines('999') });
      const refused = await submit(c.id, small.id, c.contractorToken).expect(422);
      expect(reasons(refused.body)).toEqual(['statement:FINANCIAL_STEP_NOT_APPLICABLE']);
      await untouched(c, small.id);

      const exact = await draft(c, { lines: lines('1000') });
      const res = await submit(c.id, exact.id, c.contractorToken).expect(200);
      expect(
        res.body.approvalChains.technical.steps.map((s: { stepOrder: number }) => s.stepOrder),
      ).toEqual([1, 2]);
      expect(res.body.approvalChains.financial.steps).toHaveLength(1);
    });

    it('a step that applies and names the contractor itself: the contractor never approves its own claim', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer, {
        technical: [own(c.employer), own(c.contractor)],
      });
      const made = await draft(c);
      const res = await submit(c.id, made.id, c.contractorToken).expect(422);
      expect(reasons(res.body)).toEqual(['statement:APPROVAL_STEP_NAMES_CONTRACTOR']);
      await untouched(c, made.id);
    });

    it('a union-written policy whose union organization-service no longer places above the employer: 422; an answer it cannot give: 503/504', async () => {
      const c = await signed();
      const union = newOrganizationId();
      organizations.push(union);
      await activateStatementPolicies(w, c.employer, { author: union });
      const made = await draft(c);

      api.hierarchy.everyoneIsMine = false;
      const gone = await submit(c.id, made.id, c.contractorToken).expect(422);
      expect(reasons(gone.body)).toEqual(['statement:POLICY_AUTHOR_NOT_GOVERNING']);
      api.hierarchy.everyoneIsMine = true;
      api.hierarchy.unavailable = true;
      expect((await submit(c.id, made.id, c.contractorToken).expect(503)).body.code).toBe(
        'UPSTREAM_UNAVAILABLE',
      );
      api.hierarchy.unavailable = false;
      api.hierarchy.timedOut = true;
      await submit(c.id, made.id, c.contractorToken).expect(504);
      api.hierarchy.timedOut = false;
      await untouched(c, made.id);
      expect(api.hierarchy.asked).toContainEqual([union, c.employer]);

      // Once it governs again, the same statement goes.
      api.hierarchy.adopt(union, c.employer);
      api.hierarchy.everyoneIsMine = false;
      await submit(c.id, made.id, c.contractorToken).expect(200);
    });
  });

  it('a later policy never changes a submitted statement’s chains (ADR-068 § 5)', async () => {
    const c = await signed();
    const first = await activateStatementPolicies(w, c.employer);
    const made = await draft(c);
    const submitted = (await submit(c.id, made.id, c.contractorToken).expect(200)).body;
    const replacement = await activatePolicy(w, c.employer, 'contract.statement.technical', [
      own(c.employer, 'FLEET_MANAGER'),
    ]);

    const later = (await read(c.id, made.id, c.employerToken).expect(200)).body;
    expect(later.approvalChains).toEqual(submitted.approvalChains);
    expect(later.approvalChains.technical.policyId).toBe(first.technical);
    // The next statement takes the policy in force now.
    const next = await draft(c);
    const res = await submit(c.id, next.id, c.contractorToken).expect(200);
    expect(res.body.approvalChains.technical).toMatchObject({
      policyId: replacement,
      policyVersion: 2,
    });
  });

  describe('milestones (Q-100 (4))', () => {
    it('a line may be against a milestone of its contract — never another’s; submitting marks it referenced and the employer can no longer change it', async () => {
      const c = await signed();
      const other = await signed(c.contractor);
      await activateStatementPolicies(w, c.employer);
      const milestone = await plan(c);
      const elsewhere = await plan(other);

      for (const milestoneId of [elsewhere.id, `MLS_${ulid()}`]) {
        const refused = await http(api)
          .post(`/v1/contracts/${c.id}/statements`)
          .set('authorization', `Bearer ${c.contractorToken}`)
          .set('idempotency-key', idemKey('stm'))
          .send({ lines: [{ description: 'Piles', amountMinor: '10', milestoneId }] })
          .expect(422);
        expect(reasons(refused.body)).toEqual(['statement:MILESTONE_NOT_OF_CONTRACT']);
      }
      const made = await draft(c, {
        lines: [
          { description: 'Piles', amountMinor: '10', milestoneId: milestone.id },
          { description: 'Caps', amountMinor: '5', milestoneId: milestone.id },
          { description: 'Site', amountMinor: '1' },
        ],
      });
      // A draft freezes nothing: the employer may still change the milestone.
      const changed = await http(api)
        .patch(`/v1/contracts/${c.id}/milestones/${milestone.id}`)
        .set('authorization', `Bearer ${c.employerToken}`)
        .set('idempotency-key', idemKey('mls-change'))
        .send({ title: 'Foundations and caps', expectedVersion: milestone.version })
        .expect(200);

      const res = await submit(c.id, made.id, c.contractorToken).expect(200);
      expect(
        res.body.lines.map((line: { milestoneId: string | null }) => line.milestoneId),
      ).toEqual([milestone.id, milestone.id, null]);
      const row = await milestoneRow(milestone.id);
      expect(row!.firstReferencedAt?.toISOString()).toBe(res.body.submittedAt);
      expect(row!.version).toBe(changed.body.version + 1);
      expect(row!.title).toBe('Foundations and caps');
      const [event] = await submittedEvents(c.employer);
      expect(event!.payload.milestoneIds).toEqual([milestone.id]);

      const frozen = await http(api)
        .patch(`/v1/contracts/${c.id}/milestones/${milestone.id}`)
        .set('authorization', `Bearer ${c.employerToken}`)
        .set('idempotency-key', idemKey('mls-change'))
        .send({ title: 'Too late', expectedVersion: row!.version })
        .expect(422);
      expect(reasons(frozen.body)).toEqual(['milestone:MILESTONE_REFERENCED']);

      // A later statement against it keeps the first reference's instant.
      const again = await draft(c, {
        lines: [{ description: 'More piles', amountMinor: '3', milestoneId: milestone.id }],
      });
      await submit(c.id, again.id, c.contractorToken).expect(200);
      expect((await milestoneRow(milestone.id))!.firstReferencedAt).toEqual(row!.firstReferencedAt);
      expect((await milestoneRow(elsewhere.id))!.firstReferencedAt).toBeNull();
    });
  });

  describe('who submits (S-02, S-03, BOLA)', () => {
    it('the employer, the contractor’s people without CONTRACTOR, and the platform administrator acting for a party are refused and recorded, naming the statement', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer);
      const made = await draft(c);
      const asEmployer = await submit(c.id, made.id, c.employerToken).expect(403);
      expect(reasons(asEmployer.body)).toEqual(['statement:AUTHOR_NOT_CONTRACTOR']);
      const asOther = await submit(c.id, made.id, person(c.contractor, ['FLEET_MANAGER'])).expect(
        403,
      );
      expect(asOther.body.code).toBe('INSUFFICIENT_ROLE');
      await submit(c.id, made.id, systemAdminOf(c.contractor)).expect(403);
      expect(
        (await refusalsOf(c.employer)).map((p) => [p.action, p.side, p.reason, p.subjectId]),
      ).toEqual([
        ['SUBMIT_STATEMENT', 'EMPLOYER', 'NOT_CONTRACTOR', made.id],
        ['SUBMIT_STATEMENT', 'CONTRACTOR', 'ROLE_NOT_PERMITTED', made.id],
        ['SUBMIT_STATEMENT', 'CONTRACTOR', 'PLATFORM_ADMINISTRATOR', made.id],
      ]);
      await untouched(c, made.id);
    });

    it('another organization is 404 like a contract that does not exist, and is not recorded; a statement of another contract — even the same contractor’s — is 404 (tenant isolation)', async () => {
      const c = await signed();
      const sibling = await signed(c.contractor);
      await activateStatementPolicies(w, c.employer);
      await activateStatementPolicies(w, sibling.employer);
      const made = await draft(c);
      const theirs = await draft(sibling);
      const stranger = newOrganizationId();
      organizations.push(stranger);

      const strangers = await submit(c.id, made.id, person(stranger, ['CONTRACTOR'])).expect(404);
      const missing = await submit(
        `CTR_${ulid()}`,
        made.id,
        person(stranger, ['CONTRACTOR']),
      ).expect(404);
      expect(strangers.body.code).toBe(missing.body.code);
      await submit(c.id, made.id, person(stranger, ['ORGANIZATION_ADMIN'])).expect(404);
      await submit(c.id, made.id, systemAdminOf(stranger)).expect(403);
      // The contractor of both contracts names one contract and the other's statement.
      await submit(c.id, theirs.id, c.contractorToken).expect(404);
      await submit(c.id, `STM_${ulid()}`, c.contractorToken).expect(404);
      await untouched(c, made.id);
      await untouched(sibling, theirs.id);
      expect(await refusalsOf(c.employer)).toEqual([]);
    });

    it('the oversight role, a service token, a token without a user id or a comparable identity, and no token submit nothing', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer);
      const made = await draft(c);
      await submit(c.id, made.id, auditor(c.contractor)).expect(403);
      await http(api)
        .post(`/v1/contracts/${c.id}/statements/${made.id}/submit`)
        .set(
          'x-internal-token',
          await internalToken('economic-service', { organizationId: c.contractor }),
        )
        .set('idempotency-key', idemKey('svc'))
        .send({})
        .expect(403);
      await submit(
        c.id,
        made.id,
        person(c.contractor, ['CONTRACTOR'], { rastaUserId: undefined }),
      ).expect(403);
      // A token whose verified issuer is blank names no stable identity: no approval could be kept
      // from its holder, so nothing is submitted (fail closed, #188). (Another issuer is still an
      // identity: it is the decisions that cannot compare it, the next change.)
      const unknown = await submit(
        c.id,
        made.id,
        person(c.contractor, ['CONTRACTOR'], { iss: '' }),
      ).expect(422);
      expect(unknown.body.code).toBe('ACTOR_IDENTITY_UNKNOWN');
      expect(reasons(unknown.body)).toEqual(['statement:ACTOR_IDENTITY_UNKNOWN']);
      await submit(c.id, made.id, undefined).expect(401);
      await submit(c.id, made.id, c.contractorToken, {}, null).expect(400);
      await submit(c.id, made.id, c.contractorToken, {
        expectedVersion: 1,
        status: 'APPROVED',
      }).expect(400);
      await untouched(c, made.id);
    });
  });

  describe('idempotency and concurrency', () => {
    it('the same key answers the first response and submits once; another key finds it no longer a draft; a stale version is 409', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer);
      const made = await draft(c);
      await submit(c.id, made.id, c.contractorToken, { expectedVersion: 2 }).expect(409);
      const key = idemKey('submit-replay');
      const first = await submit(c.id, made.id, c.contractorToken, {}, key).expect(200);
      const again = await submit(c.id, made.id, c.contractorToken, {}, key).expect(200);
      expect(again.body).toEqual(first.body);
      await submit(c.id, made.id, c.contractorToken, { expectedVersion: 1 }, key).expect(409);
      const late = await submit(c.id, made.id, c.contractorToken).expect(422);
      expect(reasons(late.body)).toEqual(['statement:STATEMENT_NOT_DRAFT']);
      expect(await submittedEvents(c.employer)).toHaveLength(1);
      expect(await snapshotRows(made.id)).toHaveLength(2);
    });

    it('two submissions at once, under different keys: queued on the contract’s lock, one submits and the other is told it is no longer a draft', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer);
      const made = await draft(c);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      releases.push(release);
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
      const running = Promise.all(
        [1, 2].map(() => submit(c.id, made.id, c.contractorToken).then((res) => res)),
      );
      try {
        await untilSessionsWaitOnALock(w.prisma, 2);
      } finally {
        release();
        await Promise.allSettled([holder, running]);
      }
      const results = await running;
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(reasons(results.find((r) => r.status === 422)!.body)).toEqual([
        'statement:STATEMENT_NOT_DRAFT',
      ]);
      expect(await submittedEvents(c.employer)).toHaveLength(1);
      expect(await snapshotRows(made.id)).toHaveLength(2);
    });

    it('a policy put in force while a submission holds its chains’ slots waits for it: the submission keeps the policy it read', async () => {
      const c = await signed();
      const first = await activateStatementPolicies(w, c.employer);
      const replacement = await asSetter(c.employer, () =>
        w.policies.create({
          organizationId: c.employer,
          workflowKey: 'contract.statement.technical',
          label: 'The replacement',
          rationale: 'Approved while a submission is in flight',
          isSample: true,
          steps: [
            {
              authorityOrganizationId: c.employer,
              authorityRole: 'FLEET_MANAGER',
              authorityLabel: 'Engineer',
            },
          ],
        }),
      );
      await asSetter(c.employer, () => w.policies.submit(replacement.id, { expectedVersion: 1 }));
      const made = await draft(c);

      // Park the submission after it has locked both slots and read the policies, before it writes.
      const repository = api.app.get(StatementRepository);
      const original = repository.insertApprovalSteps.bind(repository);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      releases.push(release);
      let parked!: () => void;
      const reached = new Promise<void>((resolve) => (parked = resolve));
      jest
        .spyOn(repository, 'insertApprovalSteps')
        .mockImplementationOnce(async (...args: Parameters<typeof original>) => {
          parked();
          await gate;
          return original(...args);
        });
      const submitting = submit(c.id, made.id, c.contractorToken).then((res) => res);
      await reached;
      const approving = asPlatform(() =>
        w.policies.approve(replacement.id, { expectedVersion: 2 }),
      );
      try {
        // The approval is queued behind the submission's slot lock — proven, not timed.
        await untilSessionsWaitOnALock(w.prisma, 1);
      } finally {
        release();
      }
      const res = await submitting;
      await approving;
      expect(res.status).toBe(200);
      expect(res.body.approvalChains.technical).toMatchObject({
        policyId: first.technical,
        policyVersion: 1,
      });
      const policies = await runUnscoped('the suite reads the policies', () =>
        w.prisma.client.approvalPolicy.findMany({
          where: { organizationId: c.employer, workflowKey: 'contract.statement.technical' },
          orderBy: { policyVersion: 'asc' },
        }),
      );
      expect(policies.map((p) => p.status)).toEqual(['RETIRED', 'ACTIVE']);
      // Retired after the submission committed: never before it.
      expect(policies[0]!.retiredAt!.getTime()).toBeGreaterThanOrEqual(
        new Date(res.body.submittedAt as string).getTime(),
      );
    });

    it('a policy changed between the hierarchy question and the locks: 409, nothing written; the retry snapshots the new one', async () => {
      const c = await signed();
      const union = newOrganizationId();
      organizations.push(union);
      await activateStatementPolicies(w, c.employer, { author: union });
      const replacement = await asSetter(union, () =>
        w.policies.create({
          organizationId: c.employer,
          workflowKey: 'contract.statement.financial',
          label: 'The replacement',
          rationale: 'Approved while the union was being asked about',
          isSample: true,
          steps: [
            {
              authorityOrganizationId: c.employer,
              authorityRole: 'FLEET_MANAGER',
              authorityLabel: 'Treasurer',
            },
          ],
        }),
      );
      await asSetter(union, () => w.policies.submit(replacement.id, { expectedVersion: 1 }));
      const made = await draft(c);

      const asking = api.hierarchy.isWithin.bind(api.hierarchy);
      jest.spyOn(api.hierarchy, 'isWithin').mockImplementationOnce(async (...args) => {
        await asPlatform(() => w.policies.approve(replacement.id, { expectedVersion: 2 }));
        return asking(...args);
      });
      const raced = await submit(c.id, made.id, c.contractorToken).expect(409);
      expect(raced.body.code).toBe('CONFLICT');
      await untouched(c, made.id);

      const retried = await submit(c.id, made.id, c.contractorToken).expect(200);
      expect(retried.body.approvalChains.financial).toMatchObject({
        policyId: replacement.id,
        policyVersion: 2,
      });
    });
  });
});
