import type { Server } from 'node:http';
import { expectNotDisclosed, thisRun } from '@rasta/testing';
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
import {
  contractRow,
  http,
  idemKey,
  reasons,
  seedSigned,
  type SignedContract,
} from './amendment-helpers';
import {
  activateStatementPolicies,
  cleanup,
  eventsOf,
  newOrganizationId,
  untilSessionsWaitOnALock,
  wire,
  type SuiteStep,
  type Wiring,
} from './helpers';

/**
 * CON-003 PR 6 (ADR-068 § 5, Q-96 (2), (3), (5), (7)): the decisions on a submitted statement's two
 * approval chains. Each step of the snapshot is decided by the organization and role it names —
 * technical first, then financial; a person decides a statement at most once and never the one who
 * submitted it; the last financial approval makes it APPROVED, immutable, and moves the contract's
 * approved total within the cap; a rejection is final. From the real `AppModule` over real guards
 * and a real database.
 */
describe('deciding a statement (CON-003 PR 6)', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];
  /** Barriers a test parks a request on; released after every test, so none is stranded. */
  const releases: (() => void)[] = [];

  const signed = (overrides: { amountMinor?: string; winnerOrganizationId?: string } = {}) =>
    seedSigned(api, w, organizations, overrides);
  const org = (): string => {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  };
  const at = (organizationId: string, role = 'ORGANIZATION_ADMIN'): SuiteStep => ({
    authorityOrganizationId: organizationId,
    authorityRole: role,
  });

  /** A statement of `c` drafted and submitted by `submitter` (the contractor's person by default). */
  const submitted = async (
    c: SignedContract,
    amountMinor = '1500000001',
    submitter = c.contractorToken,
  ): Promise<{ id: string; version: number }> => {
    const made = await http(api)
      .post(`/v1/contracts/${c.id}/statements`)
      .set('authorization', `Bearer ${submitter}`)
      .set('idempotency-key', idemKey('stm'))
      .send({ lines: [{ description: 'Piles and caps', amountMinor }] })
      .expect(201);
    const res = await http(api)
      .post(`/v1/contracts/${c.id}/statements/${made.body.id}/submit`)
      .set('authorization', `Bearer ${submitter}`)
      .set('idempotency-key', idemKey('submit'))
      .send({})
      .expect(200);
    return res.body;
  };
  const decide = (
    c: { id: string },
    statementId: string,
    token: string | undefined,
    body: object,
    /** `null`: no Idempotency-Key at all. */
    key: string | null = idemKey('decide'),
  ) => {
    const r = http(api).post(`/v1/contracts/${c.id}/statements/${statementId}/decisions`);
    if (token) r.set('authorization', `Bearer ${token}`);
    if (key) r.set('idempotency-key', key);
    return r.send(body);
  };
  const step = (
    chain: 'TECHNICAL' | 'FINANCIAL',
    stepOrder: number,
    decision: 'APPROVE' | 'REJECT' = 'APPROVE',
  ) => ({ chain, stepOrder, decision });
  const read = (c: { id: string }, statementId: string, token: string) =>
    http(api)
      .get(`/v1/contracts/${c.id}/statements/${statementId}`)
      .set('authorization', `Bearer ${token}`);

  const statementRow = (id: string) =>
    runUnscoped('the suite reads a statement', () =>
      w.prisma.client.statement.findFirst({ where: { id }, include: { decisions: true } }),
    );
  const decisionsOf = (statementId: string) =>
    runUnscoped('the suite reads the decisions', () =>
      w.prisma.client.statementDecision.findMany({
        where: { statementId },
        orderBy: { decidedAt: 'asc' },
      }),
    );
  const statementEvents = async (employer: string) =>
    (await eventsOf(w.prisma, employer)).filter((e) =>
      [
        'STATEMENT_DECISION_RECORDED',
        'STATEMENT_TECHNICALLY_APPROVED',
        'STATEMENT_APPROVED',
        'STATEMENT_REJECTED',
      ].includes(e.eventName),
    );
  const refusalsOf = async (employer: string) =>
    (await eventsOf(w.prisma, employer, 'CONTRACT_AUTHORITY_REFUSED')).map((e) => e.payload);
  /** The refusals as (action, side, reason), for a statement. */
  const refused = async (employer: string, statementId: string) =>
    (await refusalsOf(employer))
      .filter((p) => p.subjectId === statementId)
      .map((p) => [p.action, p.side, p.reason]);
  const exec = (sql: string, ...values: unknown[]) =>
    w.prisma.client.$executeRawUnsafe(sql, ...values);

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
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  it('a consultant, then the employer’s engineer, then its administrator: SUBMITTED → TECHNICALLY_APPROVED → APPROVED, the approved total moved, an event per decision and per transition, no amount anywhere', async () => {
    const c = await signed();
    const consultant = org();
    await activateStatementPolicies(w, c.employer, {
      technical: [at(consultant, 'OPERATOR'), at(c.employer, 'FLEET_MANAGER')],
      financial: [at(c.employer)],
    });
    const s = await submitted(c);
    const supervisor = person(consultant, ['OPERATOR']);
    const engineer = person(c.employer, ['FLEET_MANAGER']);
    const treasurer = person(c.employer, ['ORGANIZATION_ADMIN']);

    // The consultant — no party to the contract — reads what it decides, and only that.
    const seen = await read(c, s.id, supervisor).expect(200);
    expect(seen.body).toMatchObject({ id: s.id, status: 'SUBMITTED', grossMinor: '1500000001' });
    await http(api)
      .get(`/v1/contracts/${c.id}`)
      .set('authorization', `Bearer ${person(consultant, ['ORGANIZATION_ADMIN'])}`)
      .expect(404);

    const first = await decide(c, s.id, supervisor, {
      ...step('TECHNICAL', 1),
      expectedVersion: 2,
    }).expect(200);
    expect(first.body).toMatchObject({ status: 'SUBMITTED', version: 3 });
    expect(first.body.approvalChains.technical.steps[0].decision).toEqual({
      outcome: 'APPROVED',
      decidedAt: expect.any(String),
    });
    expect(first.body.approvalChains.technical.steps[1].decision).toBeNull();

    // The financial chain waits for the technical one (Q-96 (2)).
    const early = await decide(c, s.id, treasurer, step('FINANCIAL', 1)).expect(422);
    expect(reasons(early.body)).toEqual(['decision:CHAIN_NOT_OPEN']);

    const second = await decide(c, s.id, engineer, step('TECHNICAL', 2)).expect(200);
    expect(second.body).toMatchObject({ status: 'TECHNICALLY_APPROVED', version: 4 });
    expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(0n);

    const last = await decide(c, s.id, treasurer, step('FINANCIAL', 1)).expect(200);
    expect(last.body).toMatchObject({ status: 'APPROVED', version: 5 });
    expect((await read(c, s.id, c.employerToken).expect(200)).body).toEqual(last.body);
    expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(1500000001n);

    const rows = await decisionsOf(s.id);
    expect(
      rows.map((r) => [r.chain, r.stepOrder, r.outcome, r.deciderOrganizationId, r.deciderRole]),
    ).toEqual([
      ['TECHNICAL', 1, 'APPROVED', consultant, 'OPERATOR'],
      ['TECHNICAL', 2, 'APPROVED', c.employer, 'FLEET_MANAGER'],
      ['FINANCIAL', 1, 'APPROVED', c.employer, 'ORGANIZATION_ADMIN'],
    ]);
    expect(rows.every((r) => r.decidedByIssuer && r.decidedBySubject)).toBe(true);

    // One per decision, and one per transition (in its decision's transaction).
    const events = await statementEvents(c.employer);
    expect(events.map((e) => e.eventName).sort()).toEqual([
      'STATEMENT_APPROVED',
      'STATEMENT_DECISION_RECORDED',
      'STATEMENT_DECISION_RECORDED',
      'STATEMENT_DECISION_RECORDED',
      'STATEMENT_TECHNICALLY_APPROVED',
    ]);
    const approvedEvent = events.find((e) => e.eventName === 'STATEMENT_APPROVED');
    expect(approvedEvent!.payload).toEqual({
      contractId: c.id,
      statementId: s.id,
      statementNumber: 1,
      organizationId: c.employer,
      contractorOrganizationId: c.contractor,
      approvedAt: last.body.approvalChains.financial.steps[0].decision.decidedAt,
    });
    expect(events.find((e) => e.eventName === 'STATEMENT_DECISION_RECORDED')!.payload).toEqual({
      contractId: c.id,
      statementId: s.id,
      statementNumber: 1,
      organizationId: c.employer,
      contractorOrganizationId: c.contractor,
      chain: 'TECHNICAL',
      stepOrder: 1,
      outcome: 'APPROVED',
      deciderOrganizationId: consultant,
      deciderRole: 'OPERATOR',
      decidedBy: rows[0]!.decidedBy,
      decidedAt: first.body.approvalChains.technical.steps[0].decision.decidedAt,
    });
    expectNotDisclosed(events, ['1500000001', 'Piles', rows[0]!.decidedBySubject], {
      known: [c.id, c.employer, c.contractor, s.id, consultant],
      instantsBetween: thisRun(),
    });

    // APPROVED is final: no decision, and the database keeps it so. A step it decided is told so
    // (409); any other, that the statement is decided (422).
    const decided = await decide(
      c,
      s.id,
      person(c.employer, ['FLEET_MANAGER']),
      step('TECHNICAL', 2),
    );
    expect(decided.status).toBe(409);
    expect(reasons(decided.body)).toEqual(['decision:STEP_DECIDED']);
    const after = await decide(
      c,
      s.id,
      person(c.employer, ['FLEET_MANAGER']),
      step('FINANCIAL', 2),
    );
    expect(after.status).toBe(422);
    expect(reasons(after.body)).toEqual(['decision:STATEMENT_DECIDED']);
    await expect(
      exec(`UPDATE statement SET status = 'REJECTED', version = version + 1 WHERE id = $1`, s.id),
    ).rejects.toThrow(/ck_statement_final/);
    await expect(
      exec(`UPDATE contract SET approved_total_minor = 0 WHERE id = $1`, c.id),
    ).rejects.toThrow(/ck_contract_approved_total_exact/);
  });

  it('two technical and two financial steps: an event per decision, and a transition’s event only at a transition — never again for a step that leaves the status where it was (#315 r3)', async () => {
    const c = await signed();
    await activateStatementPolicies(w, c.employer, {
      technical: [at(c.employer, 'FLEET_MANAGER'), at(c.employer, 'UNION_ADMIN')],
      financial: [at(c.employer), at(c.employer)],
    });
    const s = await submitted(c);
    const decided: string[] = [];
    for (const [chain, stepOrder, role, status] of [
      ['TECHNICAL', 1, 'FLEET_MANAGER', 'SUBMITTED'],
      ['TECHNICAL', 2, 'UNION_ADMIN', 'TECHNICALLY_APPROVED'],
      ['FINANCIAL', 1, 'ORGANIZATION_ADMIN', 'TECHNICALLY_APPROVED'],
      ['FINANCIAL', 2, 'ORGANIZATION_ADMIN', 'APPROVED'],
    ] as const) {
      const res = await decide(c, s.id, person(c.employer, [role]), step(chain, stepOrder)).expect(
        200,
      );
      expect(res.body.status).toBe(status);
      const key = chain === 'TECHNICAL' ? 'technical' : 'financial';
      decided.push(res.body.approvalChains[key].steps[stepOrder - 1].decision.decidedAt);
    }
    expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(1500000001n);

    // The contract's stream, in its own order (`stream_seq`: allocation order is commit order).
    const stream = await w.prisma.client.outboxMessage.findMany({
      where: { aggregateId: c.id, eventName: { startsWith: 'STATEMENT_' } },
      orderBy: { streamSeq: 'asc' },
    });
    const events = stream
      .map((row) => ({
        eventName: row.eventName,
        payload: (row.payload as { payload: Record<string, unknown> }).payload,
      }))
      .filter((e) => !['STATEMENT_DRAFTED', 'STATEMENT_SUBMITTED'].includes(e.eventName));
    expect(
      events.map(({ eventName, payload }) =>
        eventName === 'STATEMENT_DECISION_RECORDED'
          ? [eventName, payload.chain, payload.stepOrder, payload.decidedAt]
          : [eventName, payload.technicallyApprovedAt ?? payload.approvedAt ?? payload.rejectedAt],
      ),
    ).toEqual([
      ['STATEMENT_DECISION_RECORDED', 'TECHNICAL', 1, decided[0]],
      ['STATEMENT_DECISION_RECORDED', 'TECHNICAL', 2, decided[1]],
      ['STATEMENT_TECHNICALLY_APPROVED', decided[1]],
      ['STATEMENT_DECISION_RECORDED', 'FINANCIAL', 1, decided[2]],
      ['STATEMENT_DECISION_RECORDED', 'FINANCIAL', 2, decided[3]],
      ['STATEMENT_APPROVED', decided[3]],
    ]);
  });

  describe('a rejection is final for that number (Q-96 (7))', () => {
    it.each([
      ['the first technical step', [] as const, step('TECHNICAL', 1, 'REJECT')],
      ['the financial step', [step('TECHNICAL', 1)] as const, step('FINANCIAL', 1, 'REJECT')],
    ])(
      'at %s: REJECTED, STATEMENT_REJECTED, nothing decided after it, no total moved',
      async (_at, before, rejection) => {
        const c = await signed();
        await activateStatementPolicies(w, c.employer, {
          technical: [at(c.employer, 'FLEET_MANAGER')],
          financial: [at(c.employer)],
        });
        const s = await submitted(c);
        for (const approval of before) {
          await decide(c, s.id, person(c.employer, ['FLEET_MANAGER']), approval).expect(200);
        }
        const token = person(c.employer, [
          rejection.chain === 'TECHNICAL' ? 'FLEET_MANAGER' : 'ORGANIZATION_ADMIN',
        ]);
        const res = await decide(c, s.id, token, rejection).expect(200);
        expect(res.body.status).toBe('REJECTED');
        const [event] = (await statementEvents(c.employer)).filter(
          (e) => e.eventName === 'STATEMENT_REJECTED',
        );
        expect(event!.payload).toMatchObject({
          statementId: s.id,
          chain: rejection.chain,
          stepOrder: 1,
        });

        // A step decided already is told so (409), the rejecting one included; any other, that the
        // statement is decided (422).
        const decidedSteps = [...before, rejection];
        for (const next of [
          step('TECHNICAL', 1),
          step('FINANCIAL', 1),
          step('FINANCIAL', 1, 'REJECT'),
        ]) {
          const decided = decidedSteps.some(
            (d) => d.chain === next.chain && d.stepOrder === next.stepOrder,
          );
          const late = await decide(
            c,
            s.id,
            person(c.employer, ['FLEET_MANAGER', 'ORGANIZATION_ADMIN']),
            next,
          ).expect(decided ? 409 : 422);
          expect(reasons(late.body)).toEqual([
            decided ? 'decision:STEP_DECIDED' : 'decision:STATEMENT_DECIDED',
          ]);
        }
        expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(0n);
        expect((await statementRow(s.id))!.decisions).toHaveLength(before.length + 1);
      },
    );
  });

  describe('the order of the steps', () => {
    it('a later step before an earlier one, a step the chains do not have, a draft, a decided step', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer, {
        technical: [at(c.employer, 'FLEET_MANAGER'), at(c.employer, 'UNION_ADMIN')],
      });
      const s = await submitted(c);
      const manager = person(c.employer, ['FLEET_MANAGER', 'UNION_ADMIN']);
      const ahead = await decide(c, s.id, manager, step('TECHNICAL', 2)).expect(422);
      expect(reasons(ahead.body)).toEqual(['decision:STEP_NOT_NEXT']);
      const missing = await decide(c, s.id, manager, step('TECHNICAL', 3)).expect(422);
      expect(reasons(missing.body)).toEqual(['decision:STEP_NOT_IN_CHAIN']);
      await decide(c, s.id, manager, step('TECHNICAL', 1)).expect(200);
      const again = await decide(
        c,
        s.id,
        person(c.employer, ['FLEET_MANAGER']),
        step('TECHNICAL', 1),
      ).expect(409);
      expect(reasons(again.body)).toEqual(['decision:STEP_DECIDED']);

      const draft = await http(api)
        .post(`/v1/contracts/${c.id}/statements`)
        .set('authorization', `Bearer ${c.contractorToken}`)
        .set('idempotency-key', idemKey('stm'))
        .send({ lines: [{ description: 'Later', amountMinor: '10' }] })
        .expect(201);
      const notYet = await decide(c, draft.body.id, c.employerToken, step('TECHNICAL', 1)).expect(
        422,
      );
      expect(reasons(notYet.body)).toEqual(['decision:STATEMENT_NOT_SUBMITTED']);
      // None of these is the caller's want of authority: none is recorded.
      expect(await refusalsOf(c.employer)).toEqual([]);
    });
  });

  describe('separation of duties (Q-96 (3), #188)', () => {
    it('one person decides a statement once across both chains — even under another user id; another person completes it', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer, {
        technical: [at(c.employer)],
        financial: [at(c.employer)],
      });
      const s = await submitted(c);
      const sub = `sub-${ulid()}`;
      await decide(
        c,
        s.id,
        person(c.employer, ['ORGANIZATION_ADMIN'], { sub }),
        step('TECHNICAL', 1),
      ).expect(200);
      // The same person, with a new platform user id: still one person (same issuer and subject).
      const twice = await decide(
        c,
        s.id,
        person(c.employer, ['ORGANIZATION_ADMIN'], { sub }),
        step('FINANCIAL', 1),
      ).expect(422);
      expect(twice.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(reasons(twice.body)).toEqual(['decision:ALREADY_DECIDED_STATEMENT']);
      expect(await refused(c.employer, s.id)).toEqual([
        ['APPROVE_STATEMENT', 'EMPLOYER', 'ALREADY_DECIDED_STATEMENT'],
      ]);
      await decide(
        c,
        s.id,
        person(c.employer, ['ORGANIZATION_ADMIN']),
        step('FINANCIAL', 1),
      ).expect(200);
    });

    it('two steps of a chain naming the same organization and role are two people: whoever decides the first never decides the second (#312 r2)', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer, {
        technical: [at(c.employer), at(c.employer)],
        financial: [at(c.employer)],
      });
      const s = await submitted(c);
      const first = person(c.employer, ['ORGANIZATION_ADMIN'], { sub: `sub-${ulid()}` });
      await decide(c, s.id, first, step('TECHNICAL', 1)).expect(200);
      const again = await decide(c, s.id, first, step('TECHNICAL', 2)).expect(422);
      expect(reasons(again.body)).toEqual(['decision:ALREADY_DECIDED_STATEMENT']);
      expect((await statementRow(s.id))!.status).toBe('SUBMITTED');
      const second = person(c.employer, ['ORGANIZATION_ADMIN'], { sub: `sub-${ulid()}` });
      const res = await decide(c, s.id, second, step('TECHNICAL', 2)).expect(200);
      expect(res.body.status).toBe('TECHNICALLY_APPROVED');
      expect((await decisionsOf(s.id)).map((d) => [d.chain, d.stepOrder])).toEqual([
        ['TECHNICAL', 1],
        ['TECHNICAL', 2],
      ]);
    });

    it('the submitter never decides, whichever organization they act for; a decider who cannot be told apart from them is 422 ACTOR_IDENTITY_UNKNOWN; each is recorded', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer, {
        technical: [at(c.employer)],
        financial: [at(c.employer)],
      });
      const sub = `sub-${ulid()}`;
      const s = await submitted(c, '10', person(c.contractor, ['CONTRACTOR'], { sub }));

      // The submitter's identity acting for the employer (a member of it alone): refused.
      const self = await decide(
        c,
        s.id,
        person(c.employer, ['ORGANIZATION_ADMIN'], { sub }),
        step('TECHNICAL', 1, 'REJECT'),
      ).expect(422);
      expect(reasons(self.body)).toEqual(['decision:SUBMITTER_MAY_NOT_DECIDE']);
      // Another issuer: the two cannot be shown to be two people (fail closed).
      const unknown = await decide(
        c,
        s.id,
        person(c.employer, ['ORGANIZATION_ADMIN'], { iss: 'https://elsewhere.example/realms/x' }),
        step('TECHNICAL', 1),
      ).expect(422);
      expect(unknown.body.code).toBe('ACTOR_IDENTITY_UNKNOWN');
      // A token with no verified issuer names no identity at all.
      const blank = await decide(
        c,
        s.id,
        person(c.employer, ['ORGANIZATION_ADMIN'], { iss: '' }),
        step('TECHNICAL', 1),
      ).expect(422);
      expect(reasons(blank.body)).toEqual(['decision:ACTOR_IDENTITY_UNKNOWN']);
      expect(await refused(c.employer, s.id)).toEqual([
        ['REJECT_STATEMENT', 'EMPLOYER', 'SUBMITTER_MAY_NOT_DECIDE'],
        ['APPROVE_STATEMENT', 'EMPLOYER', 'ACTOR_IDENTITY_UNKNOWN'],
        ['APPROVE_STATEMENT', 'EMPLOYER', 'ACTOR_IDENTITY_UNKNOWN'],
      ]);
      expect(await statementRow(s.id)).toMatchObject({
        status: 'SUBMITTED',
        version: 2,
        decisions: [],
      });
    });

    it('a member of the contractor’s organization never decides, for whichever organization it acts', async () => {
      const c = await signed();
      const consultant = org();
      await activateStatementPolicies(w, c.employer, { technical: [at(consultant)] });
      const s = await submitted(c);
      for (const [token, side] of [
        [person(c.employer, ['ORGANIZATION_ADMIN'], { memberships: [c.contractor] }), 'EMPLOYER'],
        [person(consultant, ['ORGANIZATION_ADMIN'], { memberships: [c.contractor] }), 'APPROVER'],
      ] as const) {
        const res = await decide(c, s.id, token, step('TECHNICAL', 1)).expect(403);
        expect(reasons(res.body)).toEqual(['decision:MEMBER_OF_CONTRACTOR']);
        expect((await refused(c.employer, s.id)).pop()).toEqual([
          'APPROVE_STATEMENT',
          side,
          'MEMBER_OF_CONTRACTOR',
        ]);
      }
      await decide(
        c,
        s.id,
        person(consultant, ['ORGANIZATION_ADMIN']),
        step('TECHNICAL', 1),
      ).expect(200);
    });

    it('the database holds the same: one decision per person per statement, never the submitter’s, never out of order or by another authority', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer, {
        technical: [at(c.employer), at(c.employer, 'FLEET_MANAGER')],
        financial: [at(c.employer)],
      });
      const s = await submitted(c);
      await decide(
        c,
        s.id,
        person(c.employer, ['ORGANIZATION_ADMIN']),
        step('TECHNICAL', 1),
      ).expect(200);
      const [first] = await decisionsOf(s.id);
      const row = (await statementRow(s.id))!;
      /** A decision of TECHNICAL step `order`, in a transaction that also moves the statement. */
      const insert = (order: number, who: { by: string; iss: string; sub: string }, extra = '') =>
        w.prisma.transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO statement_decision
               (id, organization_id, contract_id, statement_id, chain, step_order, outcome,
                decider_organization_id, decider_role, decided_by, decided_by_issuer,
                decided_by_subject, decided_at, correlation_id)
             VALUES ($1, $2, $3, $4, 'TECHNICAL', $5, 'APPROVED', $6, 'FLEET_MANAGER', $7, $8,
                     $9, now(), 'COR_1')`,
            `SDC_${ulid()}`,
            c.employer,
            c.id,
            s.id,
            order,
            extra || c.employer,
            who.by,
            who.iss,
            who.sub,
          );
          await tx.$executeRawUnsafe(
            `UPDATE statement SET version = version + 1, updated_at = now() WHERE id = $1`,
            s.id,
          );
        });
      const fresh = () => ({
        by: `USR_${ulid()}`,
        iss: first!.decidedByIssuer,
        sub: `sub-${ulid()}`,
      });
      await expect(insert(2, { ...fresh(), sub: first!.decidedBySubject })).rejects.toThrow(
        /decided_by_issuer, decided_by_subject|ux_statement_decision_person/,
      );
      await expect(insert(2, { ...fresh(), by: first!.decidedBy })).rejects.toThrow(
        /decided_by\)|ux_statement_decision_user/,
      );
      await expect(
        insert(2, {
          by: `USR_${ulid()}`,
          iss: row.submittedByIssuer!,
          sub: row.submittedBySubject!,
        }),
      ).rejects.toThrow(/ck_statement_decision_not_submitter/);
      await expect(insert(2, { ...fresh(), by: first!.decidedBySubject })).rejects.toThrow(
        /ck_statement_decision_person_once/,
      );
      // A decided step is not the next one (and `ux_statement_decision_step` backs a race).
      await expect(insert(1, fresh())).rejects.toThrow(/ck_statement_decision_in_order/);
      await expect(insert(2, fresh(), c.contractor)).rejects.toThrow(
        /ck_statement_decision_authority/,
      );
      // A decision without its statement's move, or a move without a decision, fails at commit.
      await expect(
        exec(`UPDATE statement SET version = version + 1 WHERE id = $1`, s.id),
      ).rejects.toThrow(/ck_statement_decisions_consistent/);
      await expect(
        exec(`DELETE FROM statement_decision WHERE statement_id = $1`, s.id),
      ).rejects.toThrow(/ck_statement_decision_immutable/);
      // The financial chain is not open yet.
      await expect(
        w.prisma.transaction((tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO statement_decision
               (id, organization_id, contract_id, statement_id, chain, step_order, outcome,
                decider_organization_id, decider_role, decided_by, decided_by_issuer,
                decided_by_subject, decided_at, correlation_id)
             VALUES ($1, $2, $3, $4, 'FINANCIAL', 1, 'APPROVED', $2, 'ORGANIZATION_ADMIN', $5, 'i',
                     $6, now(), 'COR_1')`,
            `SDC_${ulid()}`,
            c.employer,
            c.id,
            s.id,
            `USR_${ulid()}`,
            `sub-${ulid()}`,
          ),
        ),
      ).rejects.toThrow(/ck_statement_decision_chain_open/);
      expect(await decisionsOf(s.id)).toHaveLength(1);
    });
  });

  describe('who decides (S-02, S-03, BOLA)', () => {
    it('another organization that is a party or named by another step is 403 NOT_STEP_AUTHORITY, a person without the step’s role 403 INSUFFICIENT_ROLE, the platform administrator 403 — each recorded with its side', async () => {
      const c = await signed();
      const consultant = org();
      await activateStatementPolicies(w, c.employer, {
        technical: [at(consultant, 'OPERATOR')],
        financial: [at(c.employer, 'FLEET_MANAGER')],
      });
      const s = await submitted(c);

      const byEmployer = await decide(
        c,
        s.id,
        person(c.employer, ['FLEET_MANAGER']),
        step('TECHNICAL', 1),
      ).expect(403);
      expect(reasons(byEmployer.body)).toEqual(['decision:NOT_STEP_AUTHORITY']);
      const byContractor = await decide(c, s.id, c.contractorToken, step('TECHNICAL', 1)).expect(
        403,
      );
      expect(reasons(byContractor.body)).toEqual(['decision:NOT_STEP_AUTHORITY']);
      const noRole = await decide(
        c,
        s.id,
        person(consultant, ['ORGANIZATION_ADMIN']),
        step('TECHNICAL', 1),
      ).expect(403);
      expect(noRole.body.code).toBe('INSUFFICIENT_ROLE');
      await decide(c, s.id, systemAdminOf(c.employer), step('TECHNICAL', 1)).expect(403);
      await decide(c, s.id, person(consultant, ['OPERATOR']), step('TECHNICAL', 1)).expect(200);
      // The consultant, named only on the technical chain, is no authority of the financial one.
      const byConsultant = await decide(
        c,
        s.id,
        person(consultant, ['OPERATOR', 'FLEET_MANAGER']),
        step('FINANCIAL', 1),
      ).expect(403);
      expect(reasons(byConsultant.body)).toEqual(['decision:NOT_STEP_AUTHORITY']);

      expect(await refused(c.employer, s.id)).toEqual([
        ['APPROVE_STATEMENT', 'EMPLOYER', 'NOT_STEP_AUTHORITY'],
        ['APPROVE_STATEMENT', 'CONTRACTOR', 'NOT_STEP_AUTHORITY'],
        ['APPROVE_STATEMENT', 'APPROVER', 'ROLE_NOT_PERMITTED'],
        ['APPROVE_STATEMENT', 'EMPLOYER', 'PLATFORM_ADMINISTRATOR'],
        ['APPROVE_STATEMENT', 'APPROVER', 'NOT_STEP_AUTHORITY'],
      ]);
      expect((await statementRow(s.id))!.decisions).toHaveLength(1);
    });

    it('an organization neither a party nor named by the statement is 404 like a missing contract, and is not recorded; an approver of one statement neither reads nor decides another (tenant isolation)', async () => {
      const c = await signed();
      const consultant = org();
      const stranger = org();
      await activateStatementPolicies(w, c.employer, { technical: [at(consultant)] });
      const named = await submitted(c);
      // The next statement is put to another chain: the consultant is not on it.
      await activateStatementPolicies(w, c.employer, { technical: [at(c.employer)] });
      const other = await submitted(c);
      const sibling = await signed({ winnerOrganizationId: c.contractor });
      await activateStatementPolicies(w, sibling.employer, { technical: [at(consultant)] });
      const elsewhere = await submitted(sibling);

      const strangers = await decide(
        c,
        named.id,
        person(stranger, ['ORGANIZATION_ADMIN']),
        step('TECHNICAL', 1),
      ).expect(404);
      const missing = await decide(
        { id: `CTR_${ulid()}` },
        named.id,
        person(stranger, ['ORGANIZATION_ADMIN']),
        step('TECHNICAL', 1),
      ).expect(404);
      expect(strangers.body.code).toBe(missing.body.code);
      await read(c, named.id, person(stranger, ['ORGANIZATION_ADMIN'])).expect(404);

      const approver = person(consultant, ['ORGANIZATION_ADMIN']);
      await decide(c, other.id, approver, step('TECHNICAL', 1)).expect(404);
      await read(c, other.id, approver).expect(404);
      // A statement of another contract, named under this contract's id: 404 for everyone.
      await decide(c, elsewhere.id, approver, step('TECHNICAL', 1)).expect(404);
      await read(c, elsewhere.id, approver).expect(404);
      await decide(c, elsewhere.id, c.employerToken, step('TECHNICAL', 1)).expect(404);
      // The approver reads its statement, not the list, not the contract.
      await read(c, named.id, approver).expect(200);
      await http(api)
        .get(`/v1/contracts/${c.id}/statements`)
        .set('authorization', `Bearer ${approver}`)
        .expect(404);

      expect(await refusalsOf(c.employer)).toEqual([]);
      for (const id of [named.id, other.id, elsewhere.id]) {
        expect((await statementRow(id))!.decisions).toEqual([]);
      }
    });

    it('the oversight role, a service token, a token without a user id, and no token decide nothing', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer);
      const s = await submitted(c);
      await decide(c, s.id, auditor(c.employer), step('TECHNICAL', 1)).expect(403);
      await http(api)
        .post(`/v1/contracts/${c.id}/statements/${s.id}/decisions`)
        .set(
          'x-internal-token',
          await internalToken('economic-service', { organizationId: c.employer }),
        )
        .set('idempotency-key', idemKey('svc'))
        .send(step('TECHNICAL', 1))
        .expect(403);
      await decide(
        c,
        s.id,
        person(c.employer, ['ORGANIZATION_ADMIN'], { rastaUserId: undefined }),
        step('TECHNICAL', 1),
      ).expect(403);
      await decide(c, s.id, undefined, step('TECHNICAL', 1)).expect(401);
      await decide(c, s.id, c.employerToken, step('TECHNICAL', 1), null).expect(400);
      await decide(c, s.id, c.employerToken, {
        ...step('TECHNICAL', 1),
        outcome: 'APPROVED',
      }).expect(400);
      await decide(c, s.id, c.employerToken, {
        chain: 'LEGAL',
        stepOrder: 1,
        decision: 'APPROVE',
      }).expect(400);
      expect((await statementRow(s.id))!.decisions).toEqual([]);
    });
  });

  describe('the cap (ADR-068 § 5, Q-96 (5))', () => {
    it('the approved gross may reach the price exactly; past it the final approval is 422 and nothing is written', async () => {
      const c = await signed({ amountMinor: '1000' });
      await activateStatementPolicies(w, c.employer, {
        technical: [at(c.employer, 'FLEET_MANAGER')],
        financial: [at(c.employer)],
      });
      const approve = async (statementId: string) => {
        await decide(
          c,
          statementId,
          person(c.employer, ['FLEET_MANAGER']),
          step('TECHNICAL', 1),
        ).expect(200);
        return decide(
          c,
          statementId,
          person(c.employer, ['ORGANIZATION_ADMIN']),
          step('FINANCIAL', 1),
        );
      };
      const first = await submitted(c, '600');
      const second = await submitted(c, '400');
      const third = await submitted(c, '1');
      expect((await approve(first.id)).status).toBe(200);
      expect((await approve(second.id)).status).toBe(200);
      expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(1000n);

      const over = await approve(third.id);
      expect(over.status).toBe(422);
      expect(over.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(reasons(over.body)).toEqual(['decision:APPROVED_TOTAL_EXCEEDS_CAP']);
      expect(await statementRow(third.id)).toMatchObject({
        status: 'TECHNICALLY_APPROVED',
        version: 3,
      });
      expect((await decisionsOf(third.id)).map((d) => d.chain)).toEqual(['TECHNICAL']);
      expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(1000n);
      expect(
        (await statementEvents(c.employer)).filter((e) => e.eventName === 'STATEMENT_APPROVED'),
      ).toHaveLength(2);
      // The database holds the same: an APPROVED statement whose gross the total does not count
      // fails at commit, and the total past the cap fails its CHECK.
      const approveBySql = (moveTotal: boolean) =>
        w.prisma.transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO statement_decision
               (id, organization_id, contract_id, statement_id, chain, step_order, outcome,
                decider_organization_id, decider_role, decided_by, decided_by_issuer,
                decided_by_subject, decided_at, correlation_id)
             VALUES ($1, $2, $3, $4, 'FINANCIAL', 1, 'APPROVED', $2, 'ORGANIZATION_ADMIN', $5,
                     'iss', $6, now(), 'COR_1')`,
            `SDC_${ulid()}`,
            c.employer,
            c.id,
            third.id,
            `USR_${ulid()}`,
            `sub-${ulid()}`,
          );
          await tx.$executeRawUnsafe(
            `UPDATE statement SET status = 'APPROVED', version = version + 1, updated_at = now()
              WHERE id = $1`,
            third.id,
          );
          if (moveTotal) {
            await tx.$executeRawUnsafe(
              `UPDATE contract SET approved_total_minor = approved_total_minor + 1 WHERE id = $1`,
              c.id,
            );
          }
        });
      await expect(approveBySql(false)).rejects.toThrow(/ck_statement_approved_total/);
      await expect(approveBySql(true)).rejects.toThrow(/ck_contract_approved_cap/);
      expect(await statementRow(third.id)).toMatchObject({ status: 'TECHNICALLY_APPROVED' });

      // It may still be rejected.
      await decide(
        c,
        third.id,
        person(c.employer, ['ORGANIZATION_ADMIN']),
        step('FINANCIAL', 1, 'REJECT'),
      ).expect(200);
    });

    it('at the largest bigint: a sum past 2^63 - 1 is 422 APPROVED_TOTAL_EXCEEDS_CAP with nothing written, never a 500; the cap of 2^63 - 1 is reached exactly, and one more is refused', async () => {
      const MAX = 9223372036854775807n; // 2^63 - 1
      const c = await signed({ amountMinor: MAX.toString() });
      await activateStatementPolicies(w, c.employer, {
        technical: [at(c.employer, 'FLEET_MANAGER')],
        financial: [at(c.employer)],
      });
      const approve = async (gross: bigint) => {
        const s = await submitted(c, gross.toString());
        await decide(c, s.id, person(c.employer, ['FLEET_MANAGER']), step('TECHNICAL', 1)).expect(
          200,
        );
        const res = await decide(
          c,
          s.id,
          person(c.employer, ['ORGANIZATION_ADMIN']),
          step('FINANCIAL', 1),
        );
        return { s, res };
      };
      const refusedPastCap = async (gross: bigint, total: bigint) => {
        const { s, res } = await approve(gross);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('BUSINESS_RULE_VIOLATION');
        expect(reasons(res.body)).toEqual(['decision:APPROVED_TOTAL_EXCEEDS_CAP']);
        expect(await statementRow(s.id)).toMatchObject({
          status: 'TECHNICALLY_APPROVED',
          version: 3,
        });
        expect((await decisionsOf(s.id)).map((d) => d.chain)).toEqual(['TECHNICAL']);
        expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(total);
      };

      const six = 6000000000000000000n;
      expect((await approve(six)).res.status).toBe(200);
      expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(six);
      // 6e18 + 4e18 is past 2^63 - 1: the database's bigint sum would be an arithmetic error.
      await refusedPastCap(4000000000000000000n, six);
      // One past the cap, where the sum is 2^63 exactly.
      await refusedPastCap(MAX - six + 1n, six);
      // The cap reached exactly.
      expect((await approve(MAX - six)).res.status).toBe(200);
      expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(MAX);
      // One more at a total of 2^63 - 1.
      await refusedPastCap(1n, MAX);
      expect(
        (await statementEvents(c.employer)).filter((e) => e.eventName === 'STATEMENT_APPROVED'),
      ).toHaveLength(2);
    });
  });

  describe('idempotency and concurrency', () => {
    it('the same key answers the first response and decides once; another body under it is 409; a stale version is 409', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer, {
        technical: [at(c.employer), at(c.employer, 'FLEET_MANAGER')],
      });
      const s = await submitted(c);
      const token = person(c.employer, ['ORGANIZATION_ADMIN']);
      await decide(c, s.id, token, { ...step('TECHNICAL', 1), expectedVersion: 1 }).expect(409);
      const key = idemKey('decide-replay');
      const first = await decide(c, s.id, token, step('TECHNICAL', 1), key).expect(200);
      const again = await decide(c, s.id, token, step('TECHNICAL', 1), key).expect(200);
      expect(again.body).toEqual(first.body);
      const reused = await decide(c, s.id, token, step('TECHNICAL', 1, 'REJECT'), key).expect(409);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await decisionsOf(s.id)).toHaveLength(1);
      expect(
        (await statementEvents(c.employer)).filter(
          (e) => e.eventName === 'STATEMENT_DECISION_RECORDED',
        ),
      ).toHaveLength(1);
    });

    /** Holds the contract's row lock until released, so the requests below queue behind it. */
    const holdContract = async (c: SignedContract) => {
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
      return { release, holder };
    };

    it('two approvers of one step at once: queued on the contract’s lock, one decides and the other is told it was decided — never moved on to the next step', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer, {
        technical: [at(c.employer), at(c.employer, 'FLEET_MANAGER')],
      });
      const s = await submitted(c);
      const { release, holder } = await holdContract(c);
      const running = Promise.all(
        [1, 2].map(() =>
          decide(c, s.id, person(c.employer, ['ORGANIZATION_ADMIN']), step('TECHNICAL', 1)).then(
            (r) => r,
          ),
        ),
      );
      try {
        await untilSessionsWaitOnALock(w.prisma, 2);
      } finally {
        release();
        await Promise.allSettled([holder, running]);
      }
      const results = await running;
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(reasons(results.find((r) => r.status === 409)!.body)).toEqual([
        'decision:STEP_DECIDED',
      ]);
      expect((await decisionsOf(s.id)).map((d) => d.stepOrder)).toEqual([1]);
      expect(await statementRow(s.id)).toMatchObject({ status: 'SUBMITTED', version: 3 });
    });

    it.each([
      ['APPROVE', 'APPROVED'],
      ['REJECT', 'REJECTED'],
    ] as const)(
      'two deciders of the final financial step at once, both %s: one ends the statement, the other is 409 STEP_DECIDED — not 422 STATEMENT_DECIDED',
      async (decision, status) => {
        const c = await signed();
        await activateStatementPolicies(w, c.employer, {
          technical: [at(c.employer, 'FLEET_MANAGER')],
          financial: [at(c.employer)],
        });
        const s = await submitted(c);
        await decide(c, s.id, person(c.employer, ['FLEET_MANAGER']), step('TECHNICAL', 1)).expect(
          200,
        );
        const { release, holder } = await holdContract(c);
        const running = Promise.all(
          [1, 2].map(() =>
            decide(
              c,
              s.id,
              person(c.employer, ['ORGANIZATION_ADMIN']),
              step('FINANCIAL', 1, decision),
            ).then((r) => r),
          ),
        );
        try {
          await untilSessionsWaitOnALock(w.prisma, 2);
        } finally {
          release();
          await Promise.allSettled([holder, running]);
        }
        const results = await running;
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(results.find((r) => r.status === 200)!.body.status).toBe(status);
        const loser = results.find((r) => r.status === 409)!;
        expect(loser.body.code).toBe('CONFLICT');
        expect(reasons(loser.body)).toEqual(['decision:STEP_DECIDED']);
        expect((await decisionsOf(s.id)).map((d) => d.chain)).toEqual(['TECHNICAL', 'FINANCIAL']);
        expect(await statementRow(s.id)).toMatchObject({ status, version: 4 });
        expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(
          decision === 'APPROVE' ? 1500000001n : 0n,
        );
        // And asked again later, the same answer.
        const later = await decide(
          c,
          s.id,
          person(c.employer, ['ORGANIZATION_ADMIN']),
          step('FINANCIAL', 1, decision),
        ).expect(409);
        expect(reasons(later.body)).toEqual(['decision:STEP_DECIDED']);
      },
    );

    it('two final approvals at once whose sum passes the cap: one is APPROVED, the other 422 with nothing written', async () => {
      const c = await signed({ amountMinor: '1000' });
      await activateStatementPolicies(w, c.employer, {
        technical: [at(c.employer, 'FLEET_MANAGER')],
        financial: [at(c.employer)],
      });
      const both = [await submitted(c, '600'), await submitted(c, '600')];
      for (const s of both) {
        await decide(c, s.id, person(c.employer, ['FLEET_MANAGER']), step('TECHNICAL', 1)).expect(
          200,
        );
      }
      const { release, holder } = await holdContract(c);
      const running = Promise.all(
        both.map((s) =>
          decide(c, s.id, person(c.employer, ['ORGANIZATION_ADMIN']), step('FINANCIAL', 1)).then(
            (r) => r,
          ),
        ),
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
        'decision:APPROVED_TOTAL_EXCEEDS_CAP',
      ]);
      expect((await contractRow(w, c.id)).approvedTotalMinor).toBe(600n);
      const statuses = await Promise.all(both.map(async (s) => (await statementRow(s.id))!.status));
      expect(statuses.sort()).toEqual(['APPROVED', 'TECHNICALLY_APPROVED']);
    });

    it('a decision’s transaction that fails after the decision is written leaves nothing: no decision, no move, no event', async () => {
      const c = await signed();
      await activateStatementPolicies(w, c.employer);
      const s = await submitted(c);
      const repository = api.app.get(StatementRepository);
      jest.spyOn(repository, 'recordDecision').mockRejectedValueOnce(new Error('the disk is full'));
      await decide(
        c,
        s.id,
        person(c.employer, ['ORGANIZATION_ADMIN']),
        step('TECHNICAL', 1),
      ).expect(500);
      expect(await statementRow(s.id)).toMatchObject({
        status: 'SUBMITTED',
        version: 2,
        decisions: [],
      });
      expect(await statementEvents(c.employer)).toEqual([]);
    });
  });
});
