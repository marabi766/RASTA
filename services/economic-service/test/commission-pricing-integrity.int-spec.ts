import request from 'supertest';
import type { Server } from 'node:http';
import { ulid } from 'ulid';
import type { EventConsumer } from '@rasta/nest-common';
import { runUnscoped } from '@rasta/nest-common';
import type { EventEnvelope } from '@rasta/contracts';
import { PrismaClient } from '../src/generated/prisma';
import { SettlementAuthorityConsumer } from '../src/consumers/settlement-authority.consumer';
import { CONSUMED_EVENTS } from '../src/events/consumed';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id, ownerDatabaseUrl, wire } from './helpers';
import { FakeSourceFacts } from './source-facts.fake';

/**
 * What was in force at an instant stays what it was (docs/23 D-057; Codex
 * round 1 on #307, F1–F3), against a real PostgreSQL.
 *
 *  - **F1** Two active rules of one scope never overlap — tenant or platform,
 *    line, optional type — however the overlap is attempted: create, window
 *    extension, reinstatement, six writers at once, or an INSERT that goes
 *    around the API.
 *  - **F2** Rules are effective-dated: never backdated (by the database's
 *    clock), deactivated by ending them now, and an obligation is charged the
 *    pricing recorded with its source fact, whatever is written afterwards.
 *  - **F3** A maintenance approval given before the rollout and consumed after
 *    it is priced as it was before business lines.
 */
describe('commission pricing integrity (docs/23 D-057)', () => {
  let harness: ApiHarness;
  let http: Server;
  let owner: PrismaClient;

  const payer = apiTenant('CPI-PAYER');
  const payee = apiTenant('CPI-PAYEE');
  const workshop = apiTenant('CPI-WORKSHOP');
  /** Platform-wide rules this suite wrote; the per-organization cleanup cannot reach them. */
  const platformRules: string[] = [];

  const as = (organizationId: string) => `Bearer ${admin(organizationId)}`;
  const asSystem = () => `Bearer ${admin(payer, ['SYSTEM_ADMIN'])}`;
  const HOUR = 3_600_000;
  const GROSS = 1_000_000n;

  /** A window far ahead and unique to this run, so a platform rule prices nothing anywhere. */
  const farFuture = () => Date.now() + (3650 + Math.floor(Math.random() * 300_000)) * 24 * HOUR;

  function createRule(body: Record<string, unknown>) {
    return request(http).post('/v1/commissions/rules').set('authorization', asSystem()).send(body);
  }

  function patchRule(ruleId: string, body: Record<string, unknown>) {
    return request(http)
      .patch(`/v1/commissions/rules/${ruleId}`)
      .set('authorization', asSystem())
      .send(body);
  }

  async function createHeld(label: string, body: Record<string, unknown>) {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', as(payer))
      .set('idempotency-key', id(`cpi-${label}`))
      .send({
        counterpartyOrganizationId: payee,
        grossAmountMinor: String(GROSS),
        currency: 'IRR',
        holdFunds: true,
        ...body,
      })
      .expect(201);
    await request(http)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('authorization', as(payer))
      .set('idempotency-key', id(`cpi-${label}-auth`))
      .expect(200);
    return created.body.id as string;
  }

  async function settle(label: string, payerOrg: string, transactionId: string) {
    const settled = await request(http)
      .post('/v1/settlements')
      .set('authorization', as(payerOrg))
      .set('idempotency-key', id(`cpi-${label}-settle`))
      .send({ transactionId })
      .expect(201);
    return settled.body as Record<string, unknown>;
  }

  const transactionRow = (transactionId: string) =>
    runUnscoped('the suite reads the obligation it asserts on', () =>
      harness.prisma.client.transaction.findUniqueOrThrow({ where: { id: transactionId } }),
    );

  const commissionOf = (transactionId: string) =>
    runUnscoped('the suite reads the charge it asserts on', () =>
      harness.prisma.client.commission.findFirstOrThrow({ where: { transactionId } }),
    );

  const activeRules = (where: Record<string, unknown>) =>
    runUnscoped('the suite counts the rules it raced', () =>
      harness.prisma.client.commissionRule.count({ where: { ...where, status: 'ACTIVE' } }),
    );

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;
    owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });

    for (const organizationId of [payer, workshop]) {
      const wallet = await request(http)
        .get('/v1/wallets/me')
        .set('authorization', as(organizationId));
      await request(http)
        .post(`/v1/wallets/${wallet.body.id}/top-up`)
        .set('authorization', as(organizationId))
        .set('idempotency-key', id('cpi-fund'))
        .send({ amountMinor: String(GROSS * 20n) })
        .expect(201);
    }
    await request(http).get('/v1/wallets/me').set('authorization', as(payee));
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee, workshop]);
    if (platformRules.length > 0) {
      await runUnscoped('the suite removes the platform-wide rules it wrote', () =>
        harness.prisma.client.commissionRule.deleteMany({ where: { id: { in: platformRules } } }),
      );
    }
    await owner.$disconnect();
    await harness.close();
  });

  // ===========================================================================
  // F1 — no overlapping versions
  // ===========================================================================

  describe('F1: two active rules of one scope never overlap', () => {
    it('lets one of six concurrent creates for one tenant scope through; the rest are 409', async () => {
      const answers = await Promise.all(
        [100, 200, 300, 400, 500, 600].map((rateBasisPoints) =>
          createRule({ organizationId: payee, businessLine: 'PARTS', rateBasisPoints }),
        ),
      );
      const statuses = answers.map((answer) => answer.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
      for (const refused of answers.filter((answer) => answer.status === 409)) {
        expect(refused.body.code).toBe('CONFLICT');
      }
      expect(
        await activeRules({ organizationId: payee, businessLine: 'PARTS', transactionType: null }),
      ).toBe(1);
    });

    it('does the same for the platform scope, and for a line narrowed to one type', async () => {
      const start = farFuture();
      const window = {
        validFrom: new Date(start).toISOString(),
        validTo: new Date(start + HOUR).toISOString(),
      };
      const answers = await Promise.all(
        [10, 20, 30, 40, 50, 60].map((rateBasisPoints) =>
          createRule({
            businessLine: 'CONSTRUCTION',
            transactionType: 'CONSTRUCTION_STATEMENT',
            rateBasisPoints,
            ...window,
          }),
        ),
      );
      for (const answer of answers) if (answer.status === 201) platformRules.push(answer.body.id);
      expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    });

    it('lets a successor start where its predecessor ends, and a narrower rule overlap a wider one', async () => {
      const end = new Date(Date.now() + 2 * HOUR).toISOString();
      const first = await createRule({
        organizationId: payee,
        businessLine: 'INSURANCE',
        rateBasisPoints: 100,
        validTo: end,
      }).expect(201);
      await createRule({
        organizationId: payee,
        businessLine: 'INSURANCE',
        rateBasisPoints: 150,
        validFrom: end,
      }).expect(201);
      // Different specificities overlap by design: the narrower one wins (selectRule).
      await createRule({
        organizationId: payee,
        businessLine: 'INSURANCE',
        transactionType: 'MARKETPLACE_ORDER',
        rateBasisPoints: 175,
      }).expect(201);

      // Extending the first over its successor is the overlap a create could not make.
      const extended = await patchRule(first.body.id, { validTo: null }).expect(409);
      expect(extended.body.code).toBe('CONFLICT');

      // And the database refuses the same extension written around the API.
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE commission_rule SET valid_to = NULL WHERE id = $1`,
          first.body.id,
        ),
      ).rejects.toThrow(/ex_commission_rule_line_no_overlap/);
    });

    it('refuses to reinstate a withdrawn rule over the one that took its place', async () => {
      const start = new Date(Date.now() + 24 * HOUR).toISOString();
      const withdrawn = await createRule({
        organizationId: payee,
        businessLine: 'MARKETPLACE_SERVICE',
        rateBasisPoints: 100,
        validFrom: start,
      }).expect(201);
      // Not started yet: withdrawing it changes nothing that already happened.
      const off = await patchRule(withdrawn.body.id, { status: 'INACTIVE' }).expect(200);
      expect(off.body.status).toBe('INACTIVE');

      await createRule({
        organizationId: payee,
        businessLine: 'MARKETPLACE_SERVICE',
        rateBasisPoints: 200,
        validFrom: start,
      }).expect(201);

      const reinstated = await patchRule(withdrawn.body.id, { status: 'ACTIVE' }).expect(409);
      expect(reinstated.body.code).toBe('CONFLICT');
    });

    it('is refused by the database for an INSERT that goes around the API', async () => {
      // The PARTS rule the race above let through is in force from then on.
      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO commission_rule
             (id, organization_id, business_line, rate_basis_points, valid_from, status,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, 'PARTS', 900, now() AT TIME ZONE 'UTC', 'ACTIVE',
                   'itest-owner', 'itest-owner', now())`,
          `CMR_${ulid()}`,
          payee,
        ),
      ).rejects.toThrow(/ex_commission_rule_line_no_overlap/);
    });
  });

  // ===========================================================================
  // F2 — no historical repricing
  // ===========================================================================

  describe('F2: what occurred under a rule is charged by it', () => {
    it('refuses a backdated rule by the database clock, and accepts one from now on', async () => {
      const backdated = await createRule({
        organizationId: payee,
        businessLine: 'PROCUREMENT',
        rateBasisPoints: 100,
        validFrom: new Date(Date.now() - 5_000).toISOString(),
      }).expect(422);
      expect(backdated.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(backdated.body.message).toMatch(/never in the past/);

      const ahead = await createRule({
        organizationId: payee,
        businessLine: 'PROCUREMENT',
        rateBasisPoints: 100,
        validFrom: new Date(Date.now() + HOUR).toISOString(),
      }).expect(201);
      expect(new Date(ahead.body.validFrom).getTime()).toBeGreaterThan(Date.now());
    });

    it('ends a rule in force when it is deactivated, and still charges its rate for what occurred under it', async () => {
      const first = await createRule({
        organizationId: payee,
        businessLine: 'LOGISTICS',
        rateBasisPoints: 100,
      }).expect(201);
      const underFirst = await createHeld('logistics-1', {
        transactionType: 'LOGISTICS',
        businessLine: 'LOGISTICS',
      });
      expect(await transactionRow(underFirst)).toMatchObject({
        pricingOutcome: 'RULE_APPLIED',
        pricingRuleId: first.body.id,
      });

      // The old path flipped the status, and this obligation fell through to
      // the next rule or to none (Codex r1 F2). Now: ended, status kept.
      const ended = await patchRule(first.body.id, { status: 'INACTIVE' }).expect(200);
      expect(ended.body.status).toBe('ACTIVE');
      expect(ended.body.validTo).not.toBeNull();

      const second = await createRule({
        organizationId: payee,
        businessLine: 'LOGISTICS',
        rateBasisPoints: 700,
      }).expect(201);
      const underSecond = await createHeld('logistics-2', {
        transactionType: 'LOGISTICS',
        businessLine: 'LOGISTICS',
      });

      await settle('logistics-1', payer, underFirst);
      await settle('logistics-2', payer, underSecond);
      expect(await commissionOf(underFirst)).toMatchObject({
        ruleId: first.body.id,
        rateBasisPoints: 100,
        amountMinor: 10_000n,
      });
      expect(await commissionOf(underSecond)).toMatchObject({
        ruleId: second.body.id,
        rateBasisPoints: 700,
        amountMinor: 70_000n,
      });
    });

    it('does not reprice a recorded obligation with a rule inserted into its past around the API', async () => {
      const rule = await createRule({
        organizationId: payee,
        businessLine: 'CONSTRUCTION',
        rateBasisPoints: 200,
      }).expect(201);
      const recorded = await createHeld('construction', {
        transactionType: 'CONSTRUCTION_STATEMENT',
        businessLine: 'CONSTRUCTION',
      });

      // Narrower, so it would win a selection made now — and backdated a day.
      await owner.$executeRawUnsafe(
        `INSERT INTO commission_rule
           (id, organization_id, business_line, transaction_type, rate_basis_points, valid_from,
            status, created_by, updated_by, updated_at)
         VALUES ($1, $2, 'CONSTRUCTION', 'CONSTRUCTION_STATEMENT', 5000,
                 (now() AT TIME ZONE 'UTC') - interval '1 day', 'ACTIVE',
                 'itest-owner', 'itest-owner', now())`,
        `CMR_${ulid()}`,
        payee,
      );

      await settle('construction', payer, recorded);
      expect(await commissionOf(recorded)).toMatchObject({
        ruleId: rule.body.id,
        rateBasisPoints: 200,
        amountMinor: 20_000n,
      });
    });

    it('keeps NO_ACTIVE_RULE for an obligation no rule priced, when a rule appears later', async () => {
      // Occurs an hour ahead: a rule created afterwards would cover it, so only
      // the pricing recorded with the fact keeps it unpriced.
      const recorded = await createHeld('no-rule', {
        transactionType: 'MARKETPLACE_ORDER',
        businessLine: 'MAINTENANCE',
        occurredAt: new Date(Date.now() + HOUR).toISOString(),
      });
      expect(await transactionRow(recorded)).toMatchObject({
        pricingOutcome: 'NO_ACTIVE_RULE',
        pricingRuleId: null,
      });

      await createRule({
        organizationId: payee,
        businessLine: 'MAINTENANCE',
        transactionType: 'MARKETPLACE_ORDER',
        rateBasisPoints: 900,
      }).expect(201);

      const settled = await settle('no-rule', payer, recorded);
      expect(settled.commissionOutcome).toBe('NO_ACTIVE_RULE');
      expect(await commissionOf(recorded)).toMatchObject({
        outcome: 'NO_ACTIVE_RULE',
        ruleId: null,
        amountMinor: 0n,
      });
    });

    it('is held by the database: no repricing, no status flip in force, no end in the past', async () => {
      const rule = await createRule({
        organizationId: payee,
        businessLine: 'PROCUREMENT',
        transactionType: 'PROCUREMENT_ORDER',
        rateBasisPoints: 300,
      }).expect(201);

      await expect(
        owner.$executeRawUnsafe(
          `UPDATE commission_rule SET rate_basis_points = 301 WHERE id = $1`,
          rule.body.id,
        ),
      ).rejects.toThrow(/terms never change/);
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE commission_rule SET status = 'INACTIVE' WHERE id = $1`,
          rule.body.id,
        ),
      ).rejects.toThrow(/keeps its status/);
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE commission_rule SET valid_to = (now() AT TIME ZONE 'UTC') - interval '1 minute'
            WHERE id = $1`,
          rule.body.id,
        ),
      ).rejects.toThrow(/never in the past/);

      const recorded = await createHeld('procurement', {
        transactionType: 'PROCUREMENT_ORDER',
        businessLine: 'PROCUREMENT',
      });
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE "transaction" SET pricing_outcome = 'NO_ACTIVE_RULE', pricing_rule_id = NULL
            WHERE id = $1`,
          recorded,
        ),
      ).rejects.toThrow(/keeps the pricing recorded with its source fact/);
    });
  });

  // ===========================================================================
  // F3 — the pricing cutover
  // ===========================================================================

  describe('F3: an approval from before the rollout is priced as before', () => {
    const sources = new FakeSourceFacts();
    const noBroker = (): EventConsumer =>
      ({ start: async () => undefined, stop: async () => undefined }) as unknown as EventConsumer;

    function approvalEnvelope(approvedAt: Date) {
      const payload = {
        requestId: `MNT_${ulid()}`,
        assetId: `AST_${ulid()}`,
        organizationId: payer,
        approvedBy: 'USR-CPI-ITEST',
        approvedAt: approvedAt.toISOString(),
        workshopOrganizationId: workshop,
        totalCostMinor: String(GROSS),
        currency: 'IRR',
      };
      sources.approved(payload);
      return {
        payload,
        envelope: {
          eventId: ulid(),
          eventName: CONSUMED_EVENTS.MAINTENANCE_APPROVED,
          eventVersion: 1,
          occurredAt: new Date().toISOString(),
          producer: 'maintenance-service',
          producerVersion: '0.1.0',
          aggregateType: 'MaintenanceRequest',
          aggregateId: payload.requestId,
          tenantId: payer,
          correlationId: `cpi-itest-${ulid()}`,
          payload,
        } as EventEnvelope,
      };
    }

    it('prices an approval given before the cutover and consumed after it by the type-only rule', async () => {
      const consumer = new SettlementAuthorityConsumer(
        noBroker,
        harness.prisma,
        wire(harness.prisma).transactions,
        sources,
      );
      const [cutover] = await owner.$queryRawUnsafe<{ at: Date }[]>(
        `SELECT line_pricing_from AS at FROM commission_pricing_cutover`,
      );
      expect(cutover?.at).toBeInstanceOf(Date);

      // In force before the deployment: the workshop's type-only rule.
      const legacyId = `CMR_${ulid()}`;
      await owner.$executeRawUnsafe(
        `INSERT INTO commission_rule
           (id, organization_id, business_line, transaction_type, rate_basis_points, valid_from,
            status, created_by, updated_by, updated_at)
         VALUES ($1, $2, NULL, 'MAINTENANCE_SERVICE', 300,
                 (SELECT line_pricing_from FROM commission_pricing_cutover) - interval '30 days',
                 'ACTIVE', 'itest-owner', 'itest-owner', now())`,
        legacyId,
        workshop,
      );
      // Written since: the workshop's line rule.
      const line = await createRule({
        organizationId: workshop,
        businessLine: 'MAINTENANCE',
        rateBasisPoints: 120,
      }).expect(201);

      // Approved an hour before the rollout, consumed now — with a line.
      const before = approvalEnvelope(new Date(cutover!.at.getTime() - HOUR));
      await consumer.handle(before.envelope);
      const after = approvalEnvelope(new Date());
      await consumer.handle(after.envelope);

      const recordedBefore = await runUnscoped('the suite reads the obligation', () =>
        harness.prisma.client.transaction.findFirstOrThrow({
          where: { sourceReference: before.payload.requestId },
        }),
      );
      const recordedAfter = await runUnscoped('the suite reads the obligation', () =>
        harness.prisma.client.transaction.findFirstOrThrow({
          where: { sourceReference: after.payload.requestId },
        }),
      );
      expect(recordedBefore).toMatchObject({
        businessLine: 'MAINTENANCE',
        pricingRuleId: legacyId,
      });
      expect(recordedAfter).toMatchObject({
        businessLine: 'MAINTENANCE',
        pricingRuleId: line.body.id,
      });

      await settle('maintenance-before', payer, recordedBefore.id);
      await settle('maintenance-after', payer, recordedAfter.id);
      expect(await commissionOf(recordedBefore.id)).toMatchObject({
        ruleId: legacyId,
        businessLine: 'MAINTENANCE',
        amountMinor: 30_000n,
      });
      expect(await commissionOf(recordedAfter.id)).toMatchObject({
        ruleId: line.body.id,
        businessLine: 'MAINTENANCE',
        amountMinor: 12_000n,
      });
    });

    it('keeps the cutover fixed', async () => {
      await expect(
        owner.$executeRawUnsafe(
          `UPDATE commission_pricing_cutover SET line_pricing_from = line_pricing_from - interval '1 day'
            WHERE id = 1`,
        ),
      ).rejects.toThrow(/fixed by its migration/);
      await expect(
        owner.$executeRawUnsafe(`DELETE FROM commission_pricing_cutover WHERE id = 1`),
      ).rejects.toThrow(/fixed by its migration/);
    });
  });
});
