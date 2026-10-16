import request from 'supertest';
import type { Server } from 'node:http';
import { BUSINESS_LINES, type BusinessLine } from '@rasta/contracts';
import { runUnscoped } from '@rasta/nest-common';
import { PrismaClient } from '../src/generated/prisma';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, databaseUrl, id } from './helpers';

/**
 * Commission by business line (ADR-045; COM-011; docs/23 D-057), over HTTP
 * against a real PostgreSQL.
 *
 * ADR-045 Compliance asks for journal balance, idempotency and reversal per
 * line. Each line below is settled through the public API under its own rule,
 * at its own rate, and then:
 *
 *  - the settlement journal balances, and carries exactly the line's charge;
 *  - the same settlement replayed under its key answers the same settlement
 *    and charges nothing twice;
 *  - the charge is corrected only by a reversal entry: the row is append-only
 *    at the database (ADR-045 § 3), and the generic reversal refuses the
 *    settlement journal, naming docs/24 Q-76, which owns what reversing a
 *    settlement means — so nothing is corrected silently either way.
 *
 * Beside that: `NO_ACTIVE_RULE` is recorded and reportable rather than read as
 * a rule that computed zero (ADR-045 § 2), a line is never inferred, a rule
 * from before business lines keeps exactly its old meaning, and one
 * organization can neither see nor filter its way into another's charges and
 * negotiated rates.
 */
describe('commission by business line (ADR-045)', () => {
  let harness: ApiHarness;
  let http: Server;

  const payer = apiTenant('CBL-PAYER');
  /** Has one rule per line, each at its own rate. */
  const payee = apiTenant('CBL-PAYEE');
  /** Has no line rule at all. */
  const unpriced = apiTenant('CBL-UNPRICED');
  /** A third tenant that must see none of the above. */
  const stranger = apiTenant('CBL-STRANGER');

  const as = (organizationId: string) => `Bearer ${admin(organizationId)}`;
  const asSystem = () => `Bearer ${admin(payer, ['SYSTEM_ADMIN'])}`;
  const asPlatform = () => `Bearer ${admin(payer, ['UNION_ADMIN'])}`;

  /** A distinct rate per line, so a charge at a neighbour's rate cannot pass. */
  const RATE: Record<BusinessLine, number> = Object.fromEntries(
    BUSINESS_LINES.map((line, index) => [line, 100 + 25 * index]),
  ) as Record<BusinessLine, number>;

  /** How the money moves for each line — the type, which is not the line. */
  const TYPE: Record<BusinessLine, string> = {
    PARTS: 'MARKETPLACE_ORDER',
    INSURANCE: 'MARKETPLACE_ORDER',
    MAINTENANCE: 'MAINTENANCE_SERVICE',
    LOGISTICS: 'LOGISTICS',
    PROCUREMENT: 'PROCUREMENT_ORDER',
    CONSTRUCTION: 'CONSTRUCTION_STATEMENT',
    MARKETPLACE_SERVICE: 'MARKETPLACE_ORDER',
  };

  const GROSS = 2_000_000n;
  const ruleOf: Partial<Record<BusinessLine, string>> = {};

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    const wallet = await request(http).get('/v1/wallets/me').set('authorization', as(payer));
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', as(payer))
      .set('idempotency-key', id('cbl-fund'))
      .send({ amountMinor: String(GROSS * 20n) })
      .expect(201);
    for (const organizationId of [payee, unpriced, stranger]) {
      await request(http).get('/v1/wallets/me').set('authorization', as(organizationId));
    }

    for (const line of BUSINESS_LINES) {
      const created = await request(http)
        .post('/v1/commissions/rules')
        .set('authorization', asSystem())
        .send({
          organizationId: payee,
          businessLine: line,
          rateBasisPoints: RATE[line],
          label: 'نمونه — نیازمند تصویب',
        })
        .expect(201);
      ruleOf[line] = created.body.id as string;
    }
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee, unpriced, stranger]);
    await harness.close();
  });

  /** Creates, authorises and settles one held transaction; returns both bodies. */
  async function settle(
    label: string,
    body: { transactionType: string; businessLine?: string; counterpartyOrganizationId: string },
  ) {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', as(payer))
      .set('idempotency-key', id(`cbl-${label}`))
      .send({ ...body, grossAmountMinor: String(GROSS), currency: 'IRR', holdFunds: true })
      .expect(201);
    await request(http)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('authorization', as(payer))
      .set('idempotency-key', id(`cbl-${label}-auth`))
      .expect(200);
    const key = id(`cbl-${label}-settle`);
    const settled = await request(http)
      .post('/v1/settlements')
      .set('authorization', as(payer))
      .set('idempotency-key', key)
      .send({ transactionId: created.body.id })
      .expect(201);
    return { transactionId: created.body.id as string, settled: settled.body, key };
  }

  function commissionRowsOf(transactionId: string) {
    return runUnscoped('the suite reads the commission it asserts on', () =>
      harness.prisma.client.commission.findMany({ where: { transactionId } }),
    );
  }

  function outboxPayloads(eventName: string, aggregateId: string) {
    return runUnscoped('the suite reads the outbox it asserts on', async () =>
      (
        await harness.prisma.client.outboxMessage.findMany({ where: { eventName, aggregateId } })
      ).map((row) => (row.payload as unknown as { payload: Record<string, unknown> }).payload),
    );
  }

  describe.each(BUSINESS_LINES)('a %s transaction', (line) => {
    let transactionId: string;
    let settled: Record<string, string | boolean | null>;
    let key: string;

    beforeAll(async () => {
      ({ transactionId, settled, key } = await settle(line.toLowerCase(), {
        transactionType: TYPE[line],
        businessLine: line,
        counterpartyOrganizationId: payee,
      }));
    });

    it('is charged at its own line’s rate, in basis points, and says so', async () => {
      const expected = (GROSS * BigInt(RATE[line])) / 10_000n;
      expect(settled).toMatchObject({
        commissionRuleMatched: true,
        commissionOutcome: 'RULE_APPLIED',
        businessLine: line,
        commissionAmountMinor: String(expected),
        netAmountMinor: String(GROSS - expected),
      });

      const [row] = await commissionRowsOf(transactionId);
      expect(row).toMatchObject({
        organizationId: payee,
        ruleId: ruleOf[line],
        businessLine: line,
        outcome: 'RULE_APPLIED',
        rateBasisPoints: RATE[line],
        amountMinor: expected,
      });

      const [event] = await outboxPayloads('COMMISSION_APPLIED', row!.id);
      expect(event).toMatchObject({
        ruleId: ruleOf[line],
        businessLine: line,
        outcome: 'RULE_APPLIED',
        amountMinor: String(expected),
      });
    });

    it('posts one balanced settlement journal that carries exactly that charge', async () => {
      const journal = await request(http)
        .get(`/v1/ledger/journals/${settled.journalId}`)
        .set('authorization', as(payer))
        .expect(200);
      const entries = journal.body.entries as { direction: string; amountMinor: string }[];
      const sum = (direction: string) =>
        entries
          .filter((entry) => entry.direction === direction)
          .reduce((total, entry) => total + BigInt(entry.amountMinor), 0n);
      expect(sum('DEBIT')).toBe(sum('CREDIT'));
      expect(entries.map((entry) => entry.amountMinor)).toContain(settled.commissionAmountMinor);
    });

    it('answers a replay under the same key with the same settlement, charging once', async () => {
      const replay = await request(http)
        .post('/v1/settlements')
        .set('authorization', as(payer))
        .set('idempotency-key', key)
        .send({ transactionId })
        .expect(201);
      expect(replay.body.settlementId).toBe(settled.settlementId);
      expect(replay.body.commissionAmountMinor).toBe(settled.commissionAmountMinor);
      expect(await commissionRowsOf(transactionId)).toHaveLength(1);
    });

    it('is corrected only by a reversal entry: never edited, and not silently reversed', async () => {
      // The row itself, as the service's own runtime role: refused by the
      // append-only trigger, so no code path can edit a posted charge.
      const runtime = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });
      try {
        await expect(
          runtime.$executeRawUnsafe(
            'UPDATE commission SET amount_minor = 0 WHERE transaction_id = $1',
            transactionId,
          ),
        ).rejects.toThrow(/append-only/);
        await expect(
          runtime.$executeRawUnsafe(
            'DELETE FROM commission WHERE transaction_id = $1',
            transactionId,
          ),
        ).rejects.toThrow(/append-only/);
      } finally {
        await runtime.$disconnect();
      }

      // The ledger: the generic reversal refuses the settlement journal and
      // names the open question that owns settlement correction.
      const refused = await request(http)
        .post(`/v1/ledger/journals/${settled.journalId}/reverse`)
        .set('authorization', asPlatform())
        .send({ reason: `commission correction attempted on a ${line} settlement` })
        .expect(422);
      expect(refused.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(JSON.stringify(refused.body)).toContain('Q-76');

      const [row] = await commissionRowsOf(transactionId);
      expect(row?.amountMinor).toBe(BigInt(settled.commissionAmountMinor as string));
    });
  });

  describe('when no rule is active', () => {
    it('records NO_ACTIVE_RULE — reportable, and never a rule that computed zero', async () => {
      const { transactionId, settled } = await settle('unpriced', {
        transactionType: 'MARKETPLACE_ORDER',
        businessLine: 'INSURANCE',
        counterpartyOrganizationId: unpriced,
      });
      expect(settled).toMatchObject({
        commissionRuleMatched: false,
        commissionOutcome: 'NO_ACTIVE_RULE',
        businessLine: 'INSURANCE',
        commissionAmountMinor: '0',
        netAmountMinor: String(GROSS),
      });

      const unpricedOnes = await request(http)
        .get('/v1/commissions?outcome=NO_ACTIVE_RULE&businessLine=INSURANCE')
        .set('authorization', as(unpriced))
        .expect(200);
      expect(unpricedOnes.body.items).toEqual([
        expect.objectContaining({
          transactionId,
          ruleId: null,
          outcome: 'NO_ACTIVE_RULE',
          businessLine: 'INSURANCE',
          amountMinor: '0',
        }),
      ]);
      const applied = await request(http)
        .get('/v1/commissions?outcome=RULE_APPLIED')
        .set('authorization', as(unpriced))
        .expect(200);
      expect(applied.body.items).toEqual([]);

      const detail = await request(http)
        .get(`/v1/transactions/${transactionId}`)
        .set('authorization', as(payer))
        .expect(200);
      expect(detail.body.businessLine).toBe('INSURANCE');
      expect(detail.body.commission).toMatchObject({ ruleId: null, outcome: 'NO_ACTIVE_RULE' });
    });

    it('never infers a line: a transaction sent without one is not priced by a line rule', async () => {
      // `payee` has a PARTS rule; the type alone does not make an order PARTS.
      const { settled } = await settle('no-line', {
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
      });
      expect(settled).toMatchObject({
        commissionOutcome: 'NO_ACTIVE_RULE',
        businessLine: null,
        commissionAmountMinor: '0',
      });
    });
  });

  it('keeps a type-only rule from before business lines to the transactions without a line', async () => {
    // As the migration leaves every existing rule: a type, no line (D-057).
    const legacy = await runUnscoped('the suite seeds a rule from before ADR-045', () =>
      harness.prisma.client.commissionRule.create({
        data: {
          id: id('CMR'),
          organizationId: unpriced,
          businessLine: null,
          transactionType: 'LOGISTICS',
          rateBasisPoints: 300,
          validFrom: new Date(Date.now() - 60_000),
          status: 'ACTIVE',
          createdBy: 'itest',
          updatedBy: 'itest',
        },
      }),
    );

    const lineless = await settle('legacy-lineless', {
      transactionType: 'LOGISTICS',
      counterpartyOrganizationId: unpriced,
    });
    expect(lineless.settled).toMatchObject({
      commissionOutcome: 'RULE_APPLIED',
      commissionAmountMinor: String((GROSS * 300n) / 10_000n),
    });
    expect((await commissionRowsOf(lineless.transactionId))[0]?.ruleId).toBe(legacy.id);

    // …and it gains no new meaning: a LOGISTICS-line transaction is not its.
    const lined = await settle('legacy-lined', {
      transactionType: 'LOGISTICS',
      businessLine: 'LOGISTICS',
      counterpartyOrganizationId: unpriced,
    });
    expect(lined.settled.commissionOutcome).toBe('NO_ACTIVE_RULE');

    // Still closable — deactivating a rule in force ends it now (docs/23
    // D-057) — and the close is recorded with the line it lacks.
    await request(http)
      .patch(`/v1/commissions/rules/${legacy.id}`)
      .set('authorization', asSystem())
      .send({ status: 'INACTIVE' })
      .expect(200);
    const [change] = await outboxPayloads('COMMISSION_RULE_CHANGED', legacy.id);
    expect(change).toMatchObject({
      change: 'UPDATED',
      before: { businessLine: null, transactionType: 'LOGISTICS', status: 'ACTIVE', validTo: null },
      after: { businessLine: null, transactionType: 'LOGISTICS', status: 'ACTIVE' },
    });
    expect((change?.after as { validTo: string | null }).validTo).not.toBeNull();
  });

  describe('configuring a rule', () => {
    it('requires a business line from the contract, and writes nothing without one', async () => {
      const before = await runUnscoped('the suite counts the rules it asserts on', () =>
        harness.prisma.client.commissionRule.count({ where: { organizationId: payee } }),
      );
      for (const body of [
        { organizationId: payee, transactionType: 'LOGISTICS', rateBasisPoints: 100 },
        { organizationId: payee, businessLine: 'FUEL', rateBasisPoints: 100 },
        { organizationId: payee, businessLine: 'PARTS', rateBasisPoints: 2.5 },
      ]) {
        const refused = await request(http)
          .post('/v1/commissions/rules')
          .set('authorization', asSystem())
          .send(body)
          .expect(400);
        expect(refused.body.code).toBe('VALIDATION_FAILED');
      }
      const after = await runUnscoped('the suite counts the rules it asserts on', () =>
        harness.prisma.client.commissionRule.count({ where: { organizationId: payee } }),
      );
      expect(after).toBe(before);
    });

    it('records the line on every rule change, in the same transaction', async () => {
      const [creation] = await outboxPayloads('COMMISSION_RULE_CHANGED', ruleOf.INSURANCE!);
      expect(creation).toMatchObject({
        change: 'CREATED',
        before: null,
        after: {
          businessLine: 'INSURANCE',
          transactionType: null,
          rateBasisPoints: RATE.INSURANCE,
        },
      });
    });

    it('lets no organization administrator write or close a rule, its own included', async () => {
      await request(http)
        .post('/v1/commissions/rules')
        .set('authorization', as(payee))
        .send({ organizationId: payee, businessLine: 'PARTS', rateBasisPoints: 1 })
        .expect(403);
      await request(http)
        .patch(`/v1/commissions/rules/${ruleOf.PARTS}`)
        .set('authorization', as(payee))
        .send({ status: 'INACTIVE' })
        .expect(403);
      await request(http)
        .patch(`/v1/commissions/rules/${ruleOf.PARTS}`)
        .set('authorization', as(stranger))
        .send({ status: 'INACTIVE' })
        .expect(403);
    });
  });

  describe('tenant isolation', () => {
    it('never shows another organization’s charges, whatever the filter', async () => {
      for (const query of [
        '',
        '?businessLine=PARTS',
        '?businessLine=INSURANCE',
        '?outcome=RULE_APPLIED',
        '?outcome=NO_ACTIVE_RULE',
        '?businessLine=LOGISTICS&outcome=NO_ACTIVE_RULE',
      ]) {
        const seen = await request(http)
          .get(`/v1/commissions${query}`)
          .set('authorization', as(stranger))
          .expect(200);
        expect([query, seen.body.items]).toEqual([query, []]);
      }
    });

    it('filters a tenant’s own charges by line, and only its own', async () => {
      const parts = await request(http)
        .get('/v1/commissions?businessLine=PARTS')
        .set('authorization', as(payee))
        .expect(200);
      expect(parts.body.items.length).toBeGreaterThan(0);
      for (const item of parts.body.items) {
        expect(item).toMatchObject({ organizationId: payee, businessLine: 'PARTS' });
      }
    });

    it('never shows another organization’s negotiated rate through the line filter', async () => {
      for (const line of BUSINESS_LINES) {
        const seen = await request(http)
          .get(`/v1/commissions/rules?businessLine=${line}`)
          .set('authorization', as(stranger))
          .expect(200);
        const leaked = (seen.body.items as { organizationId: string | null }[]).filter(
          (rule) => rule.organizationId !== null && rule.organizationId !== stranger,
        );
        expect([line, leaked]).toEqual([line, []]);
      }
      const own = await request(http)
        .get('/v1/commissions/rules?businessLine=CONSTRUCTION')
        .set('authorization', as(payee))
        .expect(200);
      expect(own.body.items.map((rule: { id: string }) => rule.id)).toContain(ruleOf.CONSTRUCTION);
    });

    it('answers 404 for another organization’s transaction, line and charge included', async () => {
      const [row] = await runUnscoped('the suite picks a charged transaction', () =>
        harness.prisma.client.commission.findMany({
          where: { organizationId: payee, businessLine: 'PARTS' },
          take: 1,
        }),
      );
      await request(http)
        .get(`/v1/transactions/${row!.transactionId}`)
        .set('authorization', as(stranger))
        .expect(404);
    });

    it('refuses a filter outside the contract as a 400, not an empty page', async () => {
      for (const query of ['?businessLine=FUEL', '?outcome=ZERO', '?businessLine=parts']) {
        const refused = await request(http)
          .get(`/v1/commissions${query}`)
          .set('authorization', as(payee))
          .expect(400);
        expect(refused.body.code).toBe('VALIDATION_FAILED');
      }
    });
  });
});
