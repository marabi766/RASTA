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
 *  - **R1** (round 2) A change that waited for its row or its scope is decided
 *    by the clock once it holds them, not when its transaction began — in the
 *    service and in the trigger.
 *  - **R2** (round 2) An approval priced while a rule of its scope is being
 *    closed or created ends up with what the committed rules give at its own
 *    instant: the pricing waits for the change, under the scope's lock.
 */
describe('commission pricing integrity (docs/23 D-057)', () => {
  let harness: ApiHarness;
  let http: Server;
  let owner: PrismaClient;

  const payer = apiTenant('CPI-PAYER');
  const payee = apiTenant('CPI-PAYEE');
  const workshop = apiTenant('CPI-WORKSHOP');
  /** Scopes of their own for the lock-wait tests, so no earlier rule overlaps. */
  const clock = apiTenant('CPI-CLOCK');
  const closing = apiTenant('CPI-CLOSING');
  const opening = apiTenant('CPI-OPENING');
  const platformed = apiTenant('CPI-PLATFORMED');
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

  // A maintenance approval, consumed as `SettlementAuthorityConsumer` does in
  // production: the source fact is confirmed by the (fake) source service.
  const sources = new FakeSourceFacts();
  const noBroker = (): EventConsumer =>
    ({ start: async () => undefined, stop: async () => undefined }) as unknown as EventConsumer;

  const maintenanceConsumer = () =>
    new SettlementAuthorityConsumer(
      noBroker,
      harness.prisma,
      wire(harness.prisma).transactions,
      sources,
    );

  function approvalEnvelope(approvedAt: Date, workshopOrganizationId = workshop) {
    const payload = {
      requestId: `MNT_${ulid()}`,
      assetId: `AST_${ulid()}`,
      organizationId: payer,
      approvedBy: 'USR-CPI-ITEST',
      approvedAt: approvedAt.toISOString(),
      workshopOrganizationId,
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

  // ---------------------------------------------------------------------------
  // Holding a lock from a second session, and watching others wait for it
  // ---------------------------------------------------------------------------

  /**
   * Runs `sql` in an owner transaction left open until `release()`, so the
   * locks it took stay held. Resolves once they are.
   */
  async function hold(sql: string, ...params: unknown[]) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const held = new Promise<void>((resolve) => (taken = resolve));
    const done = owner.$transaction(
      async (blocker) => {
        await blocker.$executeRawUnsafe(sql, ...params);
        taken();
        await released;
      },
      { timeout: 60_000 },
    );
    await Promise.race([held, done]);
    return {
      release: async () => {
        release();
        await done;
      },
    };
  }

  /**
   * Sessions waiting for a lock of one kind (pg_locks: visible to any role). A
   * row's lock is waited for on the holder's transaction id, which names no
   * database.
   */
  async function waiting(kind: 'row' | 'advisory' | 'outbox'): Promise<number> {
    const here = `database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    const where = {
      row: `(locktype = 'transactionid' OR (locktype = 'tuple' AND ${here}))`,
      advisory: `locktype = 'advisory' AND ${here}`,
      outbox: `locktype = 'relation' AND relation = 'outbox_message'::regclass AND ${here}`,
    }[kind];
    const [row] = await owner.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND ${where}`,
    );
    return Number(row?.n ?? 0n);
  }

  async function until(what: string, condition: () => Promise<boolean>) {
    const deadline = Date.now() + 20_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** The database's clock — what effective dating is decided by. */
  async function databaseClock(): Promise<Date> {
    const [row] = await owner.$queryRawUnsafe<{ at: Date }[]>(
      `SELECT date_trunc('milliseconds', clock_timestamp()) AS at`,
    );
    return row!.at;
  }

  /** Waits until the database clock has passed `instant`. */
  const pastInstant = (instant: Date) =>
    until(`the database clock passes ${instant.toISOString()}`, async () => {
      return (await databaseClock()).getTime() > instant.getTime() + 20;
    });

  /** Settles a promise into a flag, so a wait can stop when it is already done. */
  function tracked<T>(promise: Promise<T>) {
    const state = { settled: false };
    const result = promise.finally(() => {
      state.settled = true;
    });
    // Asserted on later; an early rejection must not be reported as unhandled.
    result.catch(() => undefined);
    return { result, state };
  }

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
    for (const organizationId of [payee, clock, closing, opening, platformed]) {
      await request(http).get('/v1/wallets/me').set('authorization', as(organizationId));
    }
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [payer, payee, workshop, clock, closing, opening, platformed]);
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
    it('prices an approval given before the cutover and consumed after it by the type-only rule', async () => {
      const consumer = maintenanceConsumer();
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

  // ===========================================================================
  // R1 — decided by the clock after the wait (Codex round 2 on #307)
  // ===========================================================================

  describe('R1: a change that waited for its lock is decided at the instant it got it', () => {
    /** A rule of the clock tenant's, through the API. */
    async function clockRule(body: Record<string, unknown>) {
      const created = await createRule({ organizationId: clock, ...body }).expect(201);
      return created.body as { id: string; validFrom: string; validTo: string | null };
    }

    const lockRow = (ruleId: string) =>
      hold(`SELECT id FROM commission_rule WHERE id = $1 FOR UPDATE`, ruleId);

    it('ends — never withdraws — a rule whose start passed while the deactivation waited for its row', async () => {
      const rule = await clockRule({
        businessLine: 'PARTS',
        rateBasisPoints: 100,
        validFrom: new Date((await databaseClock()).getTime() + 1_500).toISOString(),
      });
      const blocker = await lockRow(rule.id);

      // Sent while the rule is still ahead: then it would be a withdrawal.
      const deactivation = tracked(patchRule(rule.id, { status: 'INACTIVE' }).then((r) => r));
      await until('the deactivation waits for the row', async () => (await waiting('row')) >= 1);
      await pastInstant(new Date(rule.validFrom));
      await blocker.release();

      const answer = await deactivation.result;
      // By the time it held the row the rule was in force: it is ended, and
      // what occurred from its start to now stays under it.
      expect(answer.status).toBe(200);
      expect(answer.body.status).toBe('ACTIVE');
      expect(new Date(answer.body.validTo).getTime()).toBeGreaterThan(
        new Date(rule.validFrom).getTime(),
      );
    });

    it('refuses to reopen a rule whose end passed while the change waited for its row', async () => {
      const rule = await clockRule({
        businessLine: 'INSURANCE',
        rateBasisPoints: 100,
        validTo: new Date((await databaseClock()).getTime() + 1_500).toISOString(),
      });
      const blocker = await lockRow(rule.id);

      const reopening = tracked(patchRule(rule.id, { validTo: null }).then((r) => r));
      await until('the reopening waits for the row', async () => (await waiting('row')) >= 1);
      await pastInstant(new Date(rule.validTo!));
      await blocker.release();

      const answer = await reopening.result;
      expect(answer.status).toBe(422);
      expect(answer.body.message).toMatch(/already ended/);
      expect(
        (
          await runUnscoped('the suite reads the rule it raced', () =>
            harness.prisma.client.commissionRule.findUniqueOrThrow({ where: { id: rule.id } }),
          )
        ).validTo?.toISOString(),
      ).toBe(rule.validTo);
    });

    it('is held by the database for a writer around the API whose UPDATE waited past the start', async () => {
      const rule = await clockRule({
        businessLine: 'LOGISTICS',
        rateBasisPoints: 100,
        validFrom: new Date((await databaseClock()).getTime() + 1_500).toISOString(),
      });
      const blocker = await lockRow(rule.id);

      // One statement: its transaction — and `now()` — begin before the wait.
      const flip = tracked(
        owner.$executeRawUnsafe(
          `UPDATE commission_rule SET status = 'INACTIVE' WHERE id = $1`,
          rule.id,
        ),
      );
      await until('the UPDATE waits for the row', async () => (await waiting('row')) >= 1);
      await pastInstant(new Date(rule.validFrom));
      await blocker.release();

      await expect(flip.result).rejects.toThrow(/keeps its status/);
    });

    it('refuses a create whose start passed while it waited for its scope', async () => {
      const validFrom = new Date((await databaseClock()).getTime() + 1_000);
      // Another change to the same scope, holding it.
      const blocker = await hold(
        `SELECT commission_rule_scope_change($1, 'CONSTRUCTION'::"BusinessLine", NULL)::TEXT`,
        clock,
      );

      const creating = tracked(
        createRule({
          organizationId: clock,
          businessLine: 'CONSTRUCTION',
          rateBasisPoints: 100,
          validFrom: validFrom.toISOString(),
        }).then((r) => r),
      );
      await until('the create waits for the scope', async () => (await waiting('advisory')) >= 1);
      await pastInstant(validFrom);
      await blocker.release();

      const answer = await creating.result;
      expect(answer.status).toBe(422);
      expect(answer.body.message).toMatch(/never in the past/);
    });
  });

  // ===========================================================================
  // R2 — pricing and rule changes take turns (Codex round 2 on #307)
  // ===========================================================================

  describe('R2: an obligation is priced by the rules committed for its instant, whatever ran beside it', () => {
    /**
     * What the committed rules give for the obligation's own instant, read
     * after everything has finished — the answer its recorded pricing must be.
     */
    async function committedPricing(row: {
      counterpartyOrganizationId: string | null;
      transactionType: string;
      businessLine: string | null;
      occurredAt: Date;
    }) {
      const { commissions } = wire(harness.prisma);
      return harness.prisma.transaction((tx) =>
        commissions.pricingOf(tx, {
          organizationId: row.counterpartyOrganizationId!,
          transactionType: row.transactionType as never,
          businessLine: row.businessLine as never,
          occurredAt: row.occurredAt,
          grossAmountMinor: GROSS,
          currency: 'IRR',
        }),
      );
    }

    const obligationFor = (requestId: string) =>
      runUnscoped('the suite reads the obligation', () =>
        harness.prisma.client.transaction.findFirstOrThrow({
          where: { sourceReference: requestId },
        }),
      );

    /**
     * Holds `change` (an API call) just short of its commit: an owner session
     * keeps the outbox from taking its change record, so the change has written
     * its rule, holds its locks, and waits. Then consumes an approval that
     * occurs *after* the change's instant, waits until that is either waiting
     * too or done, and lets everything finish.
     */
    async function approvalBesideChange(
      workshopOrganizationId: string,
      change: () => Promise<request.Response>,
    ) {
      const blocker = await hold(`LOCK TABLE outbox_message IN SHARE MODE`);
      const changing = tracked(change());
      await until('the change waits on the outbox', async () => (await waiting('outbox')) >= 1);

      const approval = approvalEnvelope(await databaseClock(), workshopOrganizationId);
      const consuming = tracked(maintenanceConsumer().handle(approval.envelope));
      await until(
        'the pricing waits, or is done',
        async () =>
          consuming.state.settled ||
          (await waiting('advisory')) >= 1 ||
          (await waiting('outbox')) >= 2,
      );
      await blocker.release();

      const changed = await changing.result;
      await consuming.result;
      return { changed, recorded: await obligationFor(approval.payload.requestId) };
    }

    it('does not bind an approval to a rule a concurrent change ended before it occurred', async () => {
      const rule = await createRule({
        organizationId: closing,
        businessLine: 'MAINTENANCE',
        rateBasisPoints: 500,
      }).expect(201);

      const { changed, recorded } = await approvalBesideChange(closing, () =>
        patchRule(rule.body.id, { status: 'INACTIVE' }).then((r) => r),
      );
      expect(changed.status).toBe(200);
      expect(new Date(changed.body.validTo).getTime()).toBeLessThanOrEqual(
        recorded.occurredAt.getTime(),
      );

      // The rule ended before the approval occurred: nothing applies to it.
      expect(recorded).toMatchObject({ pricingOutcome: 'NO_ACTIVE_RULE', pricingRuleId: null });
      expect(await committedPricing(recorded)).toEqual({
        pricingOutcome: recorded.pricingOutcome,
        pricingRuleId: recorded.pricingRuleId,
      });

      await settle('race-close', payer, recorded.id);
      expect(await commissionOf(recorded.id)).toMatchObject({
        outcome: 'NO_ACTIVE_RULE',
        amountMinor: 0n,
      });
    });

    it('does the same for a platform rule, which every tenant’s pricing reads', async () => {
      // Narrowed to the type, so it sits beside — not over — any platform line rule.
      const rule = await createRule({
        businessLine: 'MAINTENANCE',
        transactionType: 'MAINTENANCE_SERVICE',
        rateBasisPoints: 250,
      }).expect(201);
      platformRules.push(rule.body.id);

      const { changed, recorded } = await approvalBesideChange(platformed, () =>
        patchRule(rule.body.id, { status: 'INACTIVE' }).then((r) => r),
      );
      expect(changed.status).toBe(200);
      expect(new Date(changed.body.validTo).getTime()).toBeLessThanOrEqual(
        recorded.occurredAt.getTime(),
      );
      expect(recorded).toMatchObject({ pricingOutcome: 'NO_ACTIVE_RULE', pricingRuleId: null });
      expect(await committedPricing(recorded)).toEqual({
        pricingOutcome: recorded.pricingOutcome,
        pricingRuleId: recorded.pricingRuleId,
      });
    });

    it('does not pin NO_ACTIVE_RULE on an approval a concurrently created rule covers', async () => {
      const { changed, recorded } = await approvalBesideChange(opening, () =>
        createRule({
          organizationId: opening,
          businessLine: 'MAINTENANCE',
          rateBasisPoints: 400,
        }).then((r) => r),
      );
      expect(changed.status).toBe(201);
      expect(new Date(changed.body.validFrom).getTime()).toBeLessThanOrEqual(
        recorded.occurredAt.getTime(),
      );

      // The rule was in force when the approval occurred: it applies.
      expect(recorded).toMatchObject({
        pricingOutcome: 'RULE_APPLIED',
        pricingRuleId: changed.body.id,
      });
      expect(await committedPricing(recorded)).toEqual({
        pricingOutcome: recorded.pricingOutcome,
        pricingRuleId: recorded.pricingRuleId,
      });

      await settle('race-open', payer, recorded.id);
      expect(await commissionOf(recorded.id)).toMatchObject({
        ruleId: changed.body.id,
        rateBasisPoints: 400,
        amountMinor: 40_000n,
      });
    });
  });
});
