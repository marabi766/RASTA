import { runUnscoped, runWithContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { StatementService } from '../src/statement/statement.service';
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
  cleanup,
  context,
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
 * deductions the employer has configured — and submits it; the service computes the gross, each
 * deduction and the net once, in bigint; both parties read; anyone else is told `404`. Every state
 * change has its event, with identifiers only.
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
  const submit = (
    contractId: string,
    statementId: string,
    token: string | undefined,
    payload: object = {},
    key = idemKey('stm-submit'),
  ) => {
    const r = http(api)
      .post(`/v1/contracts/${contractId}/statements/${statementId}/submit`)
      .set('idempotency-key', key);
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
      expect((await statementRows(c.id))[0]!.deductions).toHaveLength(2);
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
      it('the employer is 403 AUTHOR_NOT_CONTRACTOR; the contractor’s people without CONTRACTOR are 403 INSUFFICIENT_ROLE', async () => {
        const c = await signed();
        const asEmployer = await draft(c.id, c.employerToken).expect(403);
        expect(reasons(asEmployer.body)).toEqual(['statement:AUTHOR_NOT_CONTRACTOR']);
        const asOther = await draft(c.id, person(c.contractor, ['FLEET_MANAGER'])).expect(403);
        expect(asOther.body.code).toBe('INSUFFICIENT_ROLE');
        expect(await statementRows(c.id)).toEqual([]);
      });

      it('another organization — even a contractor of its own — is 404, the same as a contract that does not exist (tenant isolation)', async () => {
        const c = await signed();
        const stranger = newOrganizationId();
        organizations.push(stranger);
        const strangers = await draft(c.id, person(stranger, ['CONTRACTOR'])).expect(404);
        const missing = await draft(`CTR_${ulid()}`, person(stranger, ['CONTRACTOR'])).expect(404);
        expect(strangers.body.code).toBe(missing.body.code);
        await draft(c.id, person(stranger, ['ORGANIZATION_ADMIN'])).expect(404);
        expect(await statementRows(c.id)).toEqual([]);
        expect(await statementEvents(c.employer)).toEqual([]);
      });

      it('the platform administrator, the oversight role, a service token and a token without a user id draft nothing', async () => {
        const c = await signed();
        await draft(c.id, systemAdminOf(c.contractor)).expect(403);
        await draft(c.id, systemAdminOf(c.employer)).expect(403);
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

  describe('POST /v1/contracts/{id}/statements/{statementId}/submit', () => {
    const drafted = async (c: SignedContract) =>
      (await draft(c.id, c.contractorToken).expect(201)).body as { id: string; version: number };

    it('the contractor submits a draft: SUBMITTED, with the submitter’s stable identity recorded, and an event with no amount', async () => {
      const c = await signed();
      const made = await drafted(c);
      const submitter = person(c.contractor, ['CONTRACTOR'], { sub: 'sub-submitter-stm' });
      const res = await submit(c.id, made.id, submitter, { expectedVersion: 1 }).expect(200);
      expect(res.body).toMatchObject({ id: made.id, status: 'SUBMITTED', version: 2 });
      expect(res.body.submittedAt).toEqual(expect.any(String));

      const [row] = await statementRows(c.id);
      expect(row).toMatchObject({ status: 'SUBMITTED', submittedBySubject: 'sub-submitter-stm' });
      expect(row!.submittedBy).toMatch(/^USR-APITEST-/);
      expect(row!.submittedByIssuer).toEqual(expect.any(String));
      expect(row!.submittedByIssuer!.length).toBeGreaterThan(0);

      const events = await statementEvents(c.employer);
      expect(events.map((e) => e.eventName)).toEqual(['STATEMENT_DRAFTED', 'STATEMENT_SUBMITTED']);
      expect(events[1]!.payload).toEqual({
        contractId: c.id,
        statementId: made.id,
        statementNumber: 1,
        organizationId: c.employer,
        contractorOrganizationId: c.contractor,
        submittedBy: row!.submittedBy,
        submittedAt: res.body.submittedAt,
      });
      expect(JSON.stringify(events[1])).not.toContain('1500000001');
      // What it says did not move with it.
      expect(row).toMatchObject({ grossMinor: 1_500_000_001n, netMinor: 1_500_000_001n });
    });

    it('a statement that is no longer a draft is 422 STATEMENT_NOT_DRAFT; a stale version is 409; neither writes', async () => {
      const c = await signed();
      const made = await drafted(c);
      await submit(c.id, made.id, c.contractorToken, { expectedVersion: 4 }).expect(409);
      await submit(c.id, made.id, c.contractorToken).expect(200);
      const again = await submit(c.id, made.id, c.contractorToken).expect(422);
      expect(reasons(again.body)).toEqual(['statement:STATEMENT_NOT_DRAFT']);
      expect((await statementRows(c.id))[0]!.version).toBe(2);
      expect((await statementEvents(c.employer)).map((e) => e.eventName)).toEqual([
        'STATEMENT_DRAFTED',
        'STATEMENT_SUBMITTED',
      ]);
    });

    it('the employer is 403 AUTHOR_NOT_CONTRACTOR; another organization and another contract’s statement are 404', async () => {
      const c = await signed();
      const other = await signed();
      const made = await drafted(c);
      const theirs = await drafted(other);
      const asEmployer = await submit(c.id, made.id, c.employerToken).expect(403);
      expect(reasons(asEmployer.body)).toEqual(['statement:AUTHOR_NOT_CONTRACTOR']);
      await submit(c.id, made.id, other.contractorToken).expect(404);
      const crossed = await submit(c.id, theirs.id, c.contractorToken).expect(404);
      expect(crossed.body.code).toBe('NOT_FOUND');
      expect((await statementRows(c.id))[0]!.status).toBe('DRAFT');
      expect((await statementRows(other.id))[0]!.status).toBe('DRAFT');
    });

    it('a submitter without a stable identity is 422 ACTOR_IDENTITY_UNKNOWN: fail closed, nothing submitted (#188)', async () => {
      const c = await signed();
      const made = await drafted(c);
      const service = api.app.get(StatementService);
      const withoutIdentity = context({
        organizationId: c.contractor,
        organizationIds: [c.contractor],
        userId: `USR-ITEST-${ulid().slice(-10)}`,
        roles: ['CONTRACTOR'],
        issuer: undefined,
        subject: undefined,
      });
      await expect(
        runWithContext(withoutIdentity, () => service.submit(c.id, made.id, {})),
      ).rejects.toMatchObject({ code: 'ACTOR_IDENTITY_UNKNOWN' });
      expect((await statementRows(c.id))[0]!.status).toBe('DRAFT');

      // The database refuses a submission that names no identity, to a write path that forgot.
      await expect(
        w.prisma.client.$executeRawUnsafe(
          `UPDATE statement SET status = 'SUBMITTED', submitted_at = now(), submitted_by = 'USR_x',
                  updated_at = now() WHERE id = '${made.id}'`,
        ),
      ).rejects.toThrow(/ck_statement_submission/);
    });
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
