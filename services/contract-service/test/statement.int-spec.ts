import { runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { EventPublisher } from '../src/events/publisher';
import {
  auditor,
  internalToken,
  person,
  startApi,
  systemAdminOf,
  type ApiHarness,
} from './api-helpers';
import { http, idemKey, reasons, seedSigned } from './amendment-helpers';
import {
  cleanup,
  eventsOf,
  newOrganizationId,
  seedDraft,
  untilSessionsWaitOnALock,
  wire,
  type Wiring,
} from './helpers';

/**
 * CON-003 PR 4 (ADR-068 § 5, Q-96, Q-97): the statements of a SIGNED contract, from the real
 * `AppModule` over real guards and a real database. The contractor drafts one — its lines and the
 * deductions the employer has configured; the service computes the gross, each deduction and the
 * net once, in bigint; both parties read; anyone else is told `404`. A draft has its event, with
 * identifiers only; a party refused is recorded (`CONTRACT_AUTHORITY_REFUSED`, `DRAFT_STATEMENT`).
 * No route submits a statement yet: submission comes with the approval chains (review #302 r1).
 */
describe('statements of a signed contract', () => {
  let api: ApiHarness;
  let w: Wiring;
  const organizations: string[] = [];

  const signed = () => seedSigned(api, w, organizations);
  const body = (overrides: Record<string, unknown> = {}) => ({
    lines: [
      { description: 'Excavation, zone A', amountMinor: '1200000000' },
      { description: 'Formwork', amountMinor: '300000001' },
    ],
    ...overrides,
  });
  const draft = (
    contractId: string,
    token: string | undefined,
    payload: object = body(),
    key = idemKey('stm'),
  ) => {
    const r = http(api).post(`/v1/contracts/${contractId}/statements`).set('idempotency-key', key);
    if (token) r.set('authorization', `Bearer ${token}`);
    return r.send(payload);
  };
  const read = (contractId: string, statementId: string, token: string) =>
    http(api)
      .get(`/v1/contracts/${contractId}/statements/${statementId}`)
      .set('authorization', `Bearer ${token}`);
  const list = (contractId: string, token: string, query = '') =>
    http(api)
      .get(`/v1/contracts/${contractId}/statements${query}`)
      .set('authorization', `Bearer ${token}`);

  const statementRows = (contractId: string) =>
    runUnscoped('the suite reads the statements', () =>
      w.prisma.client.statement.findMany({
        where: { contractId },
        orderBy: { statementNumber: 'asc' },
        include: { lines: true, deductions: true },
      }),
    );
  /** What no route does yet (Q-125): an employer's deduction rule, written as configuration. */
  const configure = (organizationId: string, name: string, rateBp: number) =>
    runUnscoped('the suite configures a deduction rule: no route writes one yet (Q-125)', () =>
      w.prisma.client.deductionRule.create({
        data: {
          id: `DDR_${ulid()}`,
          organizationId,
          name,
          rateBp,
          base: 'GROSS',
          createdAt: new Date(),
          createdBy: 'USR-ITEST-CONFIG',
        },
      }),
    );
  const statementEvents = async (employer: string) =>
    (await eventsOf(w.prisma, employer)).filter((e) => e.eventName.startsWith('STATEMENT_'));
  const refusedEvents = (employer: string) =>
    eventsOf(w.prisma, employer, 'CONTRACT_AUTHORITY_REFUSED');
  const refusalsOf = async (employer: string) =>
    (await refusedEvents(employer)).map((e) => [
      e.payload.action,
      e.payload.side,
      e.payload.reason,
    ]);

  beforeAll(async () => {
    api = await startApi();
    w = wire();
  });

  afterAll(async () => {
    await cleanup(organizations);
    await w.close();
    await api.close();
  });

  describe('POST /v1/contracts/{id}/statements', () => {
    it('the contractor drafts one: numbered, its gross the sum of its lines, net = gross with no deduction, an event with no amount', async () => {
      const c = await signed();
      const res = await draft(c.id, c.contractorToken).expect(201);
      expect(res.body).toMatchObject({
        contractId: c.id,
        organizationId: c.employer,
        contractorOrganizationId: c.contractor,
        statementNumber: 1,
        status: 'DRAFT',
        grossMinor: '1500000001',
        deductionsMinor: '0',
        netMinor: '1500000001',
        lines: [
          { lineNumber: 1, description: 'Excavation, zone A', amountMinor: '1200000000' },
          { lineNumber: 2, description: 'Formwork', amountMinor: '300000001' },
        ],
        deductions: [],
        submittedAt: null,
        version: 1,
      });
      expect(res.body.id).toMatch(/^STM_/);

      const [row] = await statementRows(c.id);
      expect(row).toMatchObject({
        organizationId: c.employer,
        grossMinor: 1_500_000_001n,
        deductionsMinor: 0n,
        netMinor: 1_500_000_001n,
        lineCount: 2,
        deductionCount: 0,
        submittedBy: null,
      });
      expect(row!.lines.map((line) => line.amountMinor)).toEqual([1_200_000_000n, 300_000_001n]);

      const events = await statementEvents(c.employer);
      expect(events.map((e) => e.eventName)).toEqual(['STATEMENT_DRAFTED']);
      expect(events[0]!.payload).toEqual({
        contractId: c.id,
        statementId: res.body.id,
        statementNumber: 1,
        organizationId: c.employer,
        contractorOrganizationId: c.contractor,
        draftedBy: expect.any(String),
        draftedAt: res.body.createdAt,
      });
      const text = JSON.stringify(events);
      for (const secret of ['1500000001', '1200000000', '300000001', 'Excavation', 'Formwork']) {
        expect(text).not.toContain(secret);
      }
    });

    it('keeps amounts exact past 2^53 and Persian text intact', async () => {
      const c = await signed();
      const description = 'خاک‌برداری بخش الف';
      const res = await draft(
        c.id,
        c.contractorToken,
        body({
          lines: [
            { description, amountMinor: '9007199254740993' },
            { description: 'x', amountMinor: '9007199254740993' },
          ],
        }),
      ).expect(201);
      expect(res.body.grossMinor).toBe('18014398509481986');
      expect(res.body.lines[0].description).toBe(description);
      expect((await statementRows(c.id))[0]!.grossMinor).toBe(18_014_398_509_481_986n);
    });

    it('applies only configured deductions: each its rate of the gross, half up, snapshotted; net = gross − Σ', async () => {
      const c = await signed();
      const retention = await configure(c.employer, 'Retention', 500);
      const tax = await configure(c.employer, 'Withholding', 3);
      const res = await draft(
        c.id,
        c.contractorToken,
        body({
          lines: [{ description: 'Piles', amountMinor: '10010' }],
          deductions: [{ deductionRuleId: retention.id }, { deductionRuleId: tax.id }],
        }),
      ).expect(201);
      // 10010 × 5% = 500.5 → 501 (half up, never 500); 10010 × 0.03% = 3.003 → 3.
      expect(res.body).toMatchObject({
        grossMinor: '10010',
        deductionsMinor: '504',
        netMinor: '9506',
      });
      expect(res.body.deductions).toEqual(
        expect.arrayContaining([
          {
            deductionRuleId: retention.id,
            name: 'Retention',
            rateBp: 500,
            base: 'GROSS',
            amountMinor: '501',
          },
          {
            deductionRuleId: tax.id,
            name: 'Withholding',
            rateBp: 3,
            base: 'GROSS',
            amountMinor: '3',
          },
        ]),
      );
      const [row] = await statementRows(c.id);
      expect(row!.deductions).toHaveLength(2);
      expect([row!.lineCount, row!.deductionCount]).toEqual([1, 2]);
    });

    it('refuses a deduction outside the configured rows: unknown, another organization’s, or retired — 422 DEDUCTION_NOT_CONFIGURED, nothing written (Q-96 (6))', async () => {
      const c = await signed();
      const elsewhere = newOrganizationId();
      organizations.push(elsewhere);
      const foreign = await configure(elsewhere, 'Retention', 500);
      const contractorsOwn = await configure(c.contractor, 'Retention', 500);
      const retired = await configure(c.employer, 'Old retention', 500);
      await runUnscoped('the suite retires a rule', () =>
        w.prisma.client.deductionRule.update({
          where: { id: retired.id },
          data: { retiredAt: new Date(Date.now() + 1000) },
        }),
      );
      for (const deductionRuleId of [`DDR_${ulid()}`, foreign.id, contractorsOwn.id, retired.id]) {
        const res = await draft(
          c.id,
          c.contractorToken,
          body({ deductions: [{ deductionRuleId }] }),
        ).expect(422);
        expect(reasons(res.body)).toEqual(['statement:DEDUCTION_NOT_CONFIGURED']);
      }
      expect(await statementRows(c.id)).toEqual([]);
      expect(await statementEvents(c.employer)).toEqual([]);
    });

    it('refuses deductions past the gross (422 STATEMENT_NET_NEGATIVE); a whole-gross deduction leaves a zero net', async () => {
      const c = await signed();
      const a = await configure(c.employer, 'A', 6000);
      const b = await configure(c.employer, 'B', 5000);
      const all = await configure(c.employer, 'All', 10_000);
      const res = await draft(
        c.id,
        c.contractorToken,
        body({ deductions: [{ deductionRuleId: a.id }, { deductionRuleId: b.id }] }),
      ).expect(422);
      expect(reasons(res.body)).toEqual(['statement:STATEMENT_NET_NEGATIVE']);
      const zero = await draft(
        c.id,
        c.contractorToken,
        body({ deductions: [{ deductionRuleId: all.id }] }),
      ).expect(201);
      expect(zero.body).toMatchObject({ grossMinor: '1500000001', netMinor: '0' });
      // Review #301 r1: at this gross the database's old numeric division expected one more than
      // the service computes, and refused the draft. Both now compute in exact integers.
      const boundary = await draft(
        c.id,
        c.contractorToken,
        body({
          lines: [{ description: 'Boundary', amountMinor: '20000000000000000' }],
          deductions: [{ deductionRuleId: all.id }],
        }),
      ).expect(201);
      expect(boundary.body).toMatchObject({
        grossMinor: '20000000000000000',
        deductionsMinor: '20000000000000000',
        netMinor: '0',
      });
      expect(boundary.body.deductions[0].amountMinor).toBe('20000000000000000');
    });

    it('refuses lines past the largest bigint (422 STATEMENT_EXCEEDS_LIMIT)', async () => {
      const c = await signed();
      const res = await draft(
        c.id,
        c.contractorToken,
        body({
          lines: [
            { description: 'a', amountMinor: '9223372036854775807' },
            { description: 'b', amountMinor: '1' },
          ],
        }),
      ).expect(422);
      expect(reasons(res.body)).toEqual(['statement:STATEMENT_EXCEEDS_LIMIT']);
    });

    it('validates the body (400): no line, a zero or malformed amount, a blank or bidi-unsafe text, a rule twice, any unpublished field', async () => {
      const c = await signed();
      const rule = await configure(c.employer, 'R', 100);
      for (const payload of [
        { lines: [] },
        body({ lines: [{ description: 'a', amountMinor: '0' }] }),
        body({ lines: [{ description: 'a', amountMinor: '-5' }] }),
        body({ lines: [{ description: 'a', amountMinor: 12 }] }),
        body({ lines: [{ description: 'a', amountMinor: '1.5' }] }),
        body({ lines: [{ description: '  ', amountMinor: '5' }] }),
        body({ lines: [{ description: 'a‮b', amountMinor: '5' }] }),
        body({ deductions: [{ deductionRuleId: rule.id }, { deductionRuleId: rule.id }] }),
        body({ deductions: [{ deductionRuleId: rule.id, amountMinor: '1' }] }),
        body({ grossMinor: '1' }),
        body({ netMinor: '1' }),
        body({ statementNumber: 7 }),
      ]) {
        await draft(c.id, c.contractorToken, payload).expect(400);
      }
      expect(await statementRows(c.id)).toEqual([]);
    });

    it('only on a SIGNED contract: a draft contract is 422 CONTRACT_NOT_SIGNED', async () => {
      const d = await seedDraft(w, organizations);
      const res = await draft(d.id, person(d.contractor, ['CONTRACTOR'])).expect(422);
      expect(reasons(res.body)).toEqual(['statement:CONTRACT_NOT_SIGNED']);
    });

    describe('who drafts', () => {
      it('the employer is 403 AUTHOR_NOT_CONTRACTOR, recorded NOT_CONTRACTOR; the contractor’s people without CONTRACTOR are 403 INSUFFICIENT_ROLE, recorded ROLE_NOT_PERMITTED (review #302 r1)', async () => {
        const c = await signed();
        const asEmployer = await draft(c.id, c.employerToken).expect(403);
        expect(reasons(asEmployer.body)).toEqual(['statement:AUTHOR_NOT_CONTRACTOR']);
        const asOther = await draft(c.id, person(c.contractor, ['FLEET_MANAGER'])).expect(403);
        expect(asOther.body.code).toBe('INSUFFICIENT_ROLE');
        expect(await statementRows(c.id)).toEqual([]);
        expect(await statementEvents(c.employer)).toEqual([]);

        const refused = await refusedEvents(c.employer);
        expect(refused.map((e) => [e.payload.action, e.payload.side, e.payload.reason])).toEqual([
          ['DRAFT_STATEMENT', 'EMPLOYER', 'NOT_CONTRACTOR'],
          ['DRAFT_STATEMENT', 'CONTRACTOR', 'ROLE_NOT_PERMITTED'],
        ]);
        // The contract's own record: its tenant, no statement named (none was made), no policy.
        expect(refused[0]!.payload).toMatchObject({
          contractId: c.id,
          organizationId: c.employer,
          subjectId: null,
          policyId: null,
          refusedBy: expect.stringMatching(/^USR-APITEST-/),
        });
      });

      it('a refused draft repeated under the same key and user is refused again and recorded once; another body is its own request and its own record', async () => {
        const c = await signed();
        const key = idemKey('refused-stm');
        const first = await draft(c.id, c.employerToken, body(), key).expect(403);
        const again = await draft(c.id, c.employerToken, body(), key).expect(403);
        expect(reasons(again.body)).toEqual(reasons(first.body));
        expect(await refusedEvents(c.employer)).toHaveLength(1);
        await draft(
          c.id,
          c.employerToken,
          body({ lines: [{ description: 'Other', amountMinor: '1' }] }),
          key,
        ).expect(403);
        expect(await refusedEvents(c.employer)).toHaveLength(2);
        expect(await statementRows(c.id)).toEqual([]);
      });

      it('a refusal that cannot be recorded is a retryable 503: nothing is drafted, the key is released, and the repeated request leaves its trace', async () => {
        const c = await signed();
        const key = idemKey('stm-refusal-down');
        const publisher = api.app.get(EventPublisher);
        const original = publisher.enqueue.bind(publisher);
        const failing = jest
          .spyOn(publisher, 'enqueue')
          .mockImplementation(async (...args: Parameters<typeof original>) => {
            if (args[1].eventName === 'CONTRACT_AUTHORITY_REFUSED') throw new Error('outbox down');
            return original(...args);
          });
        try {
          const down = await draft(c.id, c.employerToken, body(), key).expect(503);
          expect(down.body.code).toBe('UPSTREAM_UNAVAILABLE');
          expect(down.headers['retry-after']).toBe('1');
          expect(JSON.stringify(down.body)).not.toContain('outbox');
        } finally {
          failing.mockRestore();
        }
        expect(await refusedEvents(c.employer)).toEqual([]);
        expect(await statementRows(c.id)).toEqual([]);

        const answered = await draft(c.id, c.employerToken, body(), key).expect(403);
        expect(reasons(answered.body)).toEqual(['statement:AUTHOR_NOT_CONTRACTOR']);
        expect(await refusalsOf(c.employer)).toEqual([
          ['DRAFT_STATEMENT', 'EMPLOYER', 'NOT_CONTRACTOR'],
        ]);
      });

      it('another organization — even a contractor of its own — is 404, the same as a contract that does not exist (tenant isolation)', async () => {
        const c = await signed();
        const stranger = newOrganizationId();
        organizations.push(stranger);
        const strangers = await draft(c.id, person(stranger, ['CONTRACTOR'])).expect(404);
        const missing = await draft(`CTR_${ulid()}`, person(stranger, ['CONTRACTOR'])).expect(404);
        expect(strangers.body.code).toBe(missing.body.code);
        await draft(c.id, person(stranger, ['ORGANIZATION_ADMIN'])).expect(404);
        // The platform administrator acting for a stranger is answered 403, and nothing is recorded.
        await draft(c.id, systemAdminOf(stranger)).expect(403);
        expect(await statementRows(c.id)).toEqual([]);
        expect(await statementEvents(c.employer)).toEqual([]);
        // Not a party: told the contract does not exist, and no refusal is recorded (S-03).
        expect(await refusedEvents(c.employer)).toEqual([]);
      });

      it('the platform administrator, the oversight role, a service token and a token without a user id draft nothing; only the platform administrator acting for a party is recorded', async () => {
        const c = await signed();
        await draft(c.id, systemAdminOf(c.contractor)).expect(403);
        await draft(c.id, systemAdminOf(c.employer)).expect(403);
        expect(await refusalsOf(c.employer)).toEqual([
          ['DRAFT_STATEMENT', 'CONTRACTOR', 'PLATFORM_ADMINISTRATOR'],
          ['DRAFT_STATEMENT', 'EMPLOYER', 'PLATFORM_ADMINISTRATOR'],
        ]);
        await draft(c.id, auditor(c.contractor)).expect(403);
        await http(api)
          .post(`/v1/contracts/${c.id}/statements`)
          .set(
            'x-internal-token',
            await internalToken('economic-service', { organizationId: c.contractor }),
          )
          .set('idempotency-key', idemKey('svc'))
          .send(body())
          .expect(403);
        await draft(c.id, person(c.contractor, ['CONTRACTOR'], { rastaUserId: undefined })).expect(
          403,
        );
        await draft(c.id, undefined).expect(401);
        expect(await statementRows(c.id)).toEqual([]);
        expect(await refusedEvents(c.employer)).toHaveLength(2);
      });
    });

    it('a repeated request under the same key answers the first response and drafts once', async () => {
      const c = await signed();
      const key = idemKey('stm-replay');
      const first = await draft(c.id, c.contractorToken, body(), key).expect(201);
      const again = await draft(c.id, c.contractorToken, body(), key).expect(201);
      expect(again.body).toEqual(first.body);
      await draft(
        c.id,
        c.contractorToken,
        body({ lines: [{ description: 'Other', amountMinor: '1' }] }),
        key,
      ).expect(409);
      expect(await statementRows(c.id)).toHaveLength(1);
      expect(await statementEvents(c.employer)).toHaveLength(1);
    });

    it('numbers are taken under the contract’s row lock: drafts queued behind it get 1..n, each once (concurrency)', async () => {
      const c = await signed();
      const n = 6;
      // Hold the contract's row lock, start every draft, and prove each is queued on it before any
      // can take a number — so the numbers below are decided by the lock, not by timing.
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
        Array.from({ length: n }, (_, index) =>
          draft(
            c.id,
            c.contractorToken,
            body({ lines: [{ description: `Line ${index}`, amountMinor: String(index + 1) }] }),
          ).then((res) => res),
        ),
      );
      try {
        await untilSessionsWaitOnALock(w.prisma, n);
      } finally {
        release();
        await Promise.allSettled([holder, running]);
      }
      const results = await running;
      expect(results.map((r) => r.status)).toEqual(Array(n).fill(201));
      const numbers = results.map((r) => r.body.statementNumber as number).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: n }, (_, index) => index + 1));
      const rows = await statementRows(c.id);
      expect(rows.map((row) => row.statementNumber)).toEqual(numbers);
      // A later number is never dated before an earlier one: each took its instant under the lock.
      const instants = rows.map((row) => row.createdAt.getTime());
      expect([...instants].sort((a, b) => a - b)).toEqual(instants);
      expect(await statementEvents(c.employer)).toHaveLength(n);
    });
  });

  it('no route submits a statement yet: submission comes with the approval chains and their snapshot (review #302 r1)', async () => {
    const c = await signed();
    const made = (await draft(c.id, c.contractorToken).expect(201)).body as { id: string };
    await http(api)
      .post(`/v1/contracts/${c.id}/statements/${made.id}/submit`)
      .set('authorization', `Bearer ${c.contractorToken}`)
      .set('idempotency-key', idemKey('stm-submit'))
      .send({})
      .expect(404);
    expect((await statementRows(c.id))[0]).toMatchObject({ status: 'DRAFT', submittedAt: null });
    expect((await statementEvents(c.employer)).map((e) => e.eventName)).toEqual([
      'STATEMENT_DRAFTED',
    ]);
  });

  describe('reading', () => {
    it('both parties and the platform administrator acting for the employer read; a stranger, the oversight role and another contract’s id do not', async () => {
      const c = await signed();
      const other = await signed();
      const made = (await draft(c.id, c.contractorToken).expect(201)).body;
      const theirs = (await draft(other.id, other.contractorToken).expect(201)).body;

      for (const token of [c.employerToken, c.contractorToken, systemAdminOf(c.employer)]) {
        expect((await read(c.id, made.id, token).expect(200)).body).toEqual(made);
        const page = (await list(c.id, token).expect(200)).body;
        expect(page).toEqual({ items: [made], nextCursor: null, hasMore: false });
      }
      const stranger = newOrganizationId();
      organizations.push(stranger);
      for (const token of [
        person(stranger, ['ORGANIZATION_ADMIN']),
        person(stranger, ['CONTRACTOR']),
      ]) {
        await read(c.id, made.id, token).expect(404);
        await list(c.id, token).expect(404);
      }
      await read(c.id, theirs.id, c.contractorToken).expect(404);
      await read(c.id, made.id, auditor(c.employer)).expect(403);
    });

    it('lists oldest first, a page at a time', async () => {
      const c = await signed();
      for (let n = 0; n < 3; n += 1) await draft(c.id, c.contractorToken).expect(201);
      const first = (await list(c.id, c.employerToken, '?limit=2').expect(200)).body;
      expect(first.items.map((s: { statementNumber: number }) => s.statementNumber)).toEqual([
        1, 2,
      ]);
      expect(first).toMatchObject({ hasMore: true, nextCursor: '2' });
      const second = (
        await list(c.id, c.employerToken, `?limit=2&cursor=${first.nextCursor}`).expect(200)
      ).body;
      expect(second.items.map((s: { statementNumber: number }) => s.statementNumber)).toEqual([3]);
      expect(second).toMatchObject({ hasMore: false, nextCursor: null });
      await list(c.id, c.employerToken, '?cursor=0').expect(400);
    });
  });
});
