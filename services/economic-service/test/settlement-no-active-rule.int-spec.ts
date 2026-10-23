import request from 'supertest';
import type { Server } from 'node:http';
import type { BusinessLine } from '@rasta/contracts';
import { runUnscoped } from '@rasta/nest-common';
import { settlementFailuresTotal } from '../src/observability/metrics';
import { NO_ACTIVE_RULE_MESSAGE } from '../src/settlement/settlement.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import {
  asActor,
  cleanup,
  fundWallet,
  id,
  newPrisma,
  readBalances,
  testEnv,
  wire,
  type Wiring,
} from './helpers';

/**
 * Settlement without an active commission rule fails closed (docs/24 Q-29),
 * and the pilot's explicit 0% rule is a rule (Q-08) — against a real
 * PostgreSQL, over HTTP where the contract is the point and through the
 * services where the interleaving is.
 *
 * With `ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE` on — production's
 * default — settling a line no rule prices is `422 NO_ACTIVE_RULE`: no
 * journal, no commission, no settlement, the transaction and the hold as they
 * were, the refusal counted and recorded (`SETTLEMENT_REFUSED`). Settled again
 * once a rule for the line is in force, it succeeds at that rule. A 0% rule is
 * accepted, matches, and settles with `commissionRuleMatched: true` and
 * nothing charged — "decided zero", never "not configured". Off — development
 * and test, unless turned on — nothing changes: the same settlement goes
 * through at zero, `NO_ACTIVE_RULE`, as it always has.
 *
 * And a rule ended while a settlement is being made never lets it through at
 * a zero nobody chose: ended before the settlement's pricing lock, the
 * settlement is refused; ended after, the change waits for the settlement to
 * commit at the rule's terms.
 */

const GROSS = 2_000_000n;

/** Lines no other suite prices platform-wide; asserted before anything relies on it. */
const UNPRICED_LINE: BusinessLine = 'LOGISTICS';
const ZERO_LINE: BusinessLine = 'PARTS';
const RACE_LINE: BusinessLine = 'MAINTENANCE';

const TYPE_OF: Partial<Record<BusinessLine, string>> = {
  LOGISTICS: 'LOGISTICS',
  PARTS: 'MARKETPLACE_ORDER',
  MAINTENANCE: 'MAINTENANCE_SERVICE',
};

async function noActiveRuleRefusals(): Promise<number> {
  const metric = await settlementFailuresTotal.get();
  return metric.values
    .filter((value) => value.labels.reason === 'no_active_rule')
    .reduce((sum, value) => sum + value.value, 0);
}

function readAll(prisma: PrismaService, transactionId: string) {
  return runUnscoped('the suite reads everything a settlement could have written', async () => ({
    transaction: await prisma.client.transaction.findUniqueOrThrow({
      where: { id: transactionId },
    }),
    holds: await prisma.client.walletHold.findMany({ where: { reference: transactionId } }),
    journals: await prisma.client.journal.findMany({
      where: { transactionId, journalType: 'SETTLEMENT' },
    }),
    commission: await prisma.client.commission.findUnique({ where: { transactionId } }),
    settlement: await prisma.client.settlement.findUnique({ where: { transactionId } }),
  }));
}

function outbox(prisma: PrismaService, eventName: string, aggregateId: string) {
  return runUnscoped('the suite reads the outbox it asserts on', async () =>
    (await prisma.client.outboxMessage.findMany({ where: { eventName, aggregateId } })).map(
      (row) => ({
        organizationId: row.organizationId,
        payload: (row.payload as unknown as { payload: Record<string, unknown> }).payload,
      }),
    ),
  );
}

/** Platform-wide rules in force for a line now, or that will be: none may exist here. */
function platformRulesOf(prisma: PrismaService, line: BusinessLine) {
  return runUnscoped('the suite checks its precondition on platform-wide rules', () =>
    prisma.client.commissionRule.findMany({
      where: {
        organizationId: null,
        businessLine: line,
        status: 'ACTIVE',
        OR: [{ validTo: null }, { validTo: { gt: new Date() } }],
      },
    }),
  );
}

describe('settlement without an active commission rule (docs/24 Q-29, Q-08)', () => {
  /** Fails closed, as production does by default. */
  let strict: ApiHarness;
  /** Development and test's default, unchanged. */
  let lenient: ApiHarness;
  let http: Server;

  const payer = apiTenant('NAR-PAYER');
  const unpricedPayee = apiTenant('NAR-UNPRICED');
  const retryPayee = apiTenant('NAR-RETRY');
  const zeroPayee = apiTenant('NAR-ZERO');
  const linelessPayee = apiTenant('NAR-LINELESS');
  const lenientPayee = apiTenant('NAR-LENIENT');

  const as = (organizationId: string) => `Bearer ${admin(organizationId)}`;
  const asSystem = () => `Bearer ${admin(payer, ['SYSTEM_ADMIN'])}`;

  beforeAll(async () => {
    strict = await startApi({
      environment: { ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE: 'true' },
    });
    lenient = await startApi();
    http = strict.app.getHttpServer() as Server;

    for (const line of [UNPRICED_LINE, ZERO_LINE]) {
      expect(await platformRulesOf(strict.prisma, line)).toEqual([]);
    }

    const wallet = await request(http).get('/v1/wallets/me').set('authorization', as(payer));
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', as(payer))
      .set('idempotency-key', id('nar-fund'))
      .send({ amountMinor: String(GROSS * 20n) })
      .expect(201);
    for (const payee of [unpricedPayee, retryPayee, zeroPayee, linelessPayee, lenientPayee]) {
      await request(http).get('/v1/wallets/me').set('authorization', as(payee)).expect(200);
    }
  });

  afterAll(async () => {
    await cleanup(strict.prisma, [
      payer,
      unpricedPayee,
      retryPayee,
      zeroPayee,
      linelessPayee,
      lenientPayee,
    ]);
    await lenient.close();
    await strict.close();
  });

  /** Records, holds and authorises one transaction on `server`; returns its id. */
  async function authorised(
    server: Server,
    label: string,
    body: { counterpartyOrganizationId: string; businessLine?: BusinessLine },
  ): Promise<string> {
    const line = body.businessLine;
    const created = await request(server)
      .post('/v1/transactions')
      .set('authorization', as(payer))
      .set('idempotency-key', id(`nar-${label}`))
      .send({
        ...body,
        transactionType: line ? TYPE_OF[line] : 'MARKETPLACE_ORDER',
        grossAmountMinor: String(GROSS),
        currency: 'IRR',
        holdFunds: true,
      })
      .expect(201);
    await request(server)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('authorization', as(payer))
      .set('idempotency-key', id(`nar-${label}-auth`))
      .expect(200);
    return created.body.id as string;
  }

  function settle(server: Server, transactionId: string, key: string) {
    return request(server)
      .post('/v1/settlements')
      .set('authorization', as(payer))
      .set('idempotency-key', key)
      .send({ transactionId });
  }

  async function createRule(organizationId: string, line: BusinessLine, rateBasisPoints: number) {
    const created = await request(http)
      .post('/v1/commissions/rules')
      .set('authorization', asSystem())
      .send({
        organizationId,
        businessLine: line,
        rateBasisPoints,
        label: 'نمونه — نیازمند تصویب',
      })
      .expect(201);
    return created.body as { id: string; rateBasisPoints: number; status: string };
  }

  async function payerBalances() {
    const wallet = await request(http).get('/v1/wallets/me').set('authorization', as(payer));
    return readBalances(strict.prisma, wallet.body.id as string);
  }

  it('refuses a line no rule prices with 422 NO_ACTIVE_RULE, moving and writing nothing but the refusal', async () => {
    const transactionId = await authorised(http, 'refused', {
      counterpartyOrganizationId: unpricedPayee,
      businessLine: UNPRICED_LINE,
    });
    const before = await readAll(strict.prisma, transactionId);
    expect(before.transaction.pricingOutcome).toBe('NO_ACTIVE_RULE');
    const balancesBefore = await payerBalances();
    const refusalsBefore = await noActiveRuleRefusals();

    const refused = await settle(http, transactionId, id('nar-refused-settle')).expect(422);

    expect(refused.body).toMatchObject({ code: 'NO_ACTIVE_RULE', message: NO_ACTIVE_RULE_MESSAGE });
    expect(refused.body.details).toBeUndefined();

    // Nothing moved, nothing was written: the row, the hold, no journal, no
    // commission, no settlement, the payer's balances to the rial.
    const after = await readAll(strict.prisma, transactionId);
    expect(after.transaction).toEqual(before.transaction);
    expect(after.transaction.status).toBe('PENDING_SETTLEMENT');
    expect(after.holds).toEqual(before.holds);
    expect(after.holds.map((hold) => hold.status)).toEqual(['ACTIVE']);
    expect(after.journals).toEqual([]);
    expect(after.commission).toBeNull();
    expect(after.settlement).toBeNull();
    expect(await payerBalances()).toEqual(balancesBefore);
    expect(await outbox(strict.prisma, 'SETTLEMENT_COMPLETED', transactionId)).toEqual([]);

    // Counted, and recorded: who tried, on whose transaction, which line, why.
    expect(await noActiveRuleRefusals()).toBe(refusalsBefore + 1);
    const [record, ...more] = await outbox(strict.prisma, 'SETTLEMENT_REFUSED', transactionId);
    expect(more).toEqual([]);
    expect(record?.organizationId).toBe(payer);
    expect(record?.payload).toEqual({
      transactionId,
      organizationId: payer,
      payerOrganizationId: payer,
      payeeOrganizationId: unpricedPayee,
      transactionType: 'LOGISTICS',
      businessLine: UNPRICED_LINE,
      reason: 'NO_ACTIVE_RULE',
      refusedBy: expect.stringMatching(/^USR-APITEST-/),
      refusedAt: expect.any(String),
    });
  });

  it('settles the same transaction, under the same key, once a rule for the line is in force', async () => {
    const transactionId = await authorised(http, 'retry', {
      counterpartyOrganizationId: retryPayee,
      businessLine: UNPRICED_LINE,
    });
    const key = id('nar-retry-settle');
    await settle(http, transactionId, key).expect(422);

    const rule = await createRule(retryPayee, UNPRICED_LINE, 150);
    const settled = await settle(http, transactionId, key).expect(201);

    // 1.5% of 2 000 000.
    expect(settled.body).toMatchObject({
      transactionId,
      grossAmountMinor: '2000000',
      commissionAmountMinor: '30000',
      netAmountMinor: '1970000',
      commissionRuleMatched: true,
      commissionOutcome: 'RULE_APPLIED',
      businessLine: UNPRICED_LINE,
    });
    const after = await readAll(strict.prisma, transactionId);
    expect(after.commission).toMatchObject({
      ruleId: rule.id,
      outcome: 'RULE_APPLIED',
      rateBasisPoints: 150,
      amountMinor: 30_000n,
    });
    expect(after.transaction.status).toBe('SETTLED');
    // What was recorded with the fact is not rewritten (trg_transaction_pricing_fixed):
    // the charge names the rule that priced it at the settlement.
    expect(after.transaction.pricingOutcome).toBe('NO_ACTIVE_RULE');
    expect(after.holds.map((hold) => hold.status)).toEqual(['RELEASED']);
    expect(after.journals).toHaveLength(1);

    // The stored answer replays; the refusal before it was not stored.
    const replay = await settle(http, transactionId, key).expect(201);
    expect(replay.body.settlementId).toBe(settled.body.settlementId);
    expect(await outbox(strict.prisma, 'SETTLEMENT_REFUSED', transactionId)).toHaveLength(1);
  });

  it('accepts a 0% rule, matches it, and settles with commissionRuleMatched true and nothing charged (Q-08)', async () => {
    const rule = await createRule(zeroPayee, ZERO_LINE, 0);
    expect(rule).toMatchObject({ rateBasisPoints: 0, status: 'ACTIVE' });

    const transactionId = await authorised(http, 'zero', {
      counterpartyOrganizationId: zeroPayee,
      businessLine: ZERO_LINE,
    });
    const settled = await settle(http, transactionId, id('nar-zero-settle')).expect(201);

    expect(settled.body).toMatchObject({
      commissionAmountMinor: '0',
      netAmountMinor: '2000000',
      commissionRuleMatched: true,
      commissionOutcome: 'RULE_APPLIED',
      businessLine: ZERO_LINE,
    });
    const after = await readAll(strict.prisma, transactionId);
    expect(after.transaction).toMatchObject({
      pricingOutcome: 'RULE_APPLIED',
      pricingRuleId: rule.id,
    });
    expect(after.commission).toMatchObject({
      ruleId: rule.id,
      outcome: 'RULE_APPLIED',
      rateBasisPoints: 0,
      amountMinor: 0n,
    });
    const [applied] = await outbox(strict.prisma, 'COMMISSION_APPLIED', after.commission!.id);
    expect(applied?.payload).toMatchObject({
      ruleId: rule.id,
      outcome: 'RULE_APPLIED',
      rateBasisPoints: 0,
      amountMinor: '0',
    });
    // Reported as decided zero, not as unconfigured.
    const listed = await request(http)
      .get('/v1/commissions?outcome=RULE_APPLIED')
      .set('authorization', as(zeroPayee))
      .expect(200);
    expect(listed.body.items).toEqual([
      expect.objectContaining({ transactionId, ruleId: rule.id, amountMinor: '0' }),
    ]);
    const unconfigured = await request(http)
      .get('/v1/commissions?outcome=NO_ACTIVE_RULE')
      .set('authorization', as(zeroPayee))
      .expect(200);
    expect(unconfigured.body.items).toEqual([]);
    expect(await outbox(strict.prisma, 'SETTLEMENT_REFUSED', transactionId)).toEqual([]);
  });

  it('does not refuse a transaction recorded without a line: no rule can price one (Q-130)', async () => {
    const transactionId = await authorised(http, 'lineless', {
      counterpartyOrganizationId: linelessPayee,
    });
    const settled = await settle(http, transactionId, id('nar-lineless-settle')).expect(201);

    expect(settled.body).toMatchObject({
      commissionAmountMinor: '0',
      commissionRuleMatched: false,
      commissionOutcome: 'NO_ACTIVE_RULE',
      businessLine: null,
    });
    expect(await outbox(strict.prisma, 'SETTLEMENT_REFUSED', transactionId)).toEqual([]);
  });

  it('keeps development and test as they were: the same unpriced line settles at zero, NO_ACTIVE_RULE', async () => {
    const lenientHttp = lenient.app.getHttpServer() as Server;
    const transactionId = await authorised(lenientHttp, 'lenient', {
      counterpartyOrganizationId: lenientPayee,
      businessLine: UNPRICED_LINE,
    });
    const refusalsBefore = await noActiveRuleRefusals();

    const settled = await settle(lenientHttp, transactionId, id('nar-lenient-settle')).expect(201);

    expect(settled.body).toMatchObject({
      commissionAmountMinor: '0',
      netAmountMinor: '2000000',
      commissionRuleMatched: false,
      commissionOutcome: 'NO_ACTIVE_RULE',
      businessLine: UNPRICED_LINE,
    });
    const after = await readAll(lenient.prisma, transactionId);
    expect(after.commission).toMatchObject({ ruleId: null, outcome: 'NO_ACTIVE_RULE' });
    expect(await noActiveRuleRefusals()).toBe(refusalsBefore);
    expect(await outbox(lenient.prisma, 'SETTLEMENT_REFUSED', transactionId)).toEqual([]);
  });
});

describe('a rule ended while a settlement is made, failing closed (docs/24 Q-29)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const payer = apiTenant('NAR-RACE-PAYER');
  const actor = 'USR-ITEST-NAR-RACE';

  beforeAll(async () => {
    prisma = newPrisma();
    wiring = wire(prisma, { ...testEnv(), ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE: true });
    expect(await platformRulesOf(prisma, RACE_LINE)).toEqual([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(prisma, [payer]);
    await prisma.onModuleDestroy();
  });

  const asPayer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: payer, userId: actor }, fn);
  const asSystem = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: payer, userId: 'USR-ITEST-NAR-SYSTEM', roles: ['SYSTEM_ADMIN'] }, fn);

  /** A held, authorised transaction owed to `payee`, recorded before any rule for it. */
  async function authorised(payee: string): Promise<string> {
    await fundWallet(wiring, payer, GROSS);
    await fundWallet(wiring, payee, 0n);
    const created = await asPayer(() =>
      wiring.transactions.create({
        transactionType: 'MAINTENANCE_SERVICE',
        businessLine: RACE_LINE,
        counterpartyOrganizationId: payee,
        grossAmountMinor: String(GROSS),
        currency: 'IRR',
        holdFunds: true,
      }),
    );
    await asPayer(() => wiring.transactions.authoriseSettlement(created.id));
    return created.id;
  }

  const createRule = (payee: string, rateBasisPoints: number) =>
    asSystem(() =>
      wiring.commissions.createRule({
        organizationId: payee,
        businessLine: RACE_LINE,
        rateBasisPoints,
        status: 'ACTIVE',
      }),
    );
  const endRule = (ruleId: string) =>
    asSystem(() => wiring.commissions.updateRule(ruleId, { status: 'INACTIVE' }));

  /** A promise and the function that settles it, for holding one side of a race. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, opened };
  }

  /** Whether `promise` settles within `ms`. */
  async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([promise.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  it('refuses, rather than settles at zero, when the rule ended after the row was locked and before it was priced', async () => {
    const payee = `${payer}-ENDED`;
    const transactionId = await authorised(payee);
    const rule = await createRule(payee, 300);

    // Held after the transaction row is locked — the settlement has matched
    // nothing yet — while the rule is ended and that change commits.
    const held = gate();
    const reached = gate();
    const lock = wiring.transactionRepository.lockForUpdate.bind(wiring.transactionRepository);
    jest
      .spyOn(wiring.transactionRepository, 'lockForUpdate')
      .mockImplementationOnce(async (...args) => {
        const row = await lock(...args);
        reached.open();
        await held.opened;
        return row;
      });

    const settling = asPayer(() => wiring.settlements.settle(transactionId, actor));
    settling.catch(() => undefined);
    try {
      await reached.opened;
      const ended = await endRule(rule.id);
      expect(ended.validTo).not.toBeNull();
    } finally {
      held.open();
    }

    await expect(settling).rejects.toMatchObject({ code: 'NO_ACTIVE_RULE' });
    const after = await readAll(prisma, transactionId);
    expect(after.transaction.status).toBe('PENDING_SETTLEMENT');
    expect(after.commission).toBeNull();
    expect(after.settlement).toBeNull();
    expect(after.journals).toEqual([]);
    expect(after.holds.map((hold) => hold.status)).toEqual(['ACTIVE']);
  });

  it('makes the end of a rule wait for a settlement that matched it, which commits at the rule’s terms', async () => {
    const payee = `${payer}-WAITS`;
    const transactionId = await authorised(payee);
    const rule = await createRule(payee, 300);

    // Held after the settlement has matched the rule, inside its transaction.
    const held = gate();
    const reached = gate();
    const record = wiring.commissions.record.bind(wiring.commissions);
    jest.spyOn(wiring.commissions, 'record').mockImplementationOnce(async (...args) => {
      reached.open();
      await held.opened;
      return record(...args);
    });

    const settling = asPayer(() => wiring.settlements.settle(transactionId, actor));
    settling.catch(() => undefined);
    let ending: Promise<{ validTo: Date | null }> | undefined;
    try {
      await reached.opened;
      ending = endRule(rule.id);
      ending.catch(() => undefined);
      // The pricing lock is the settlement's until it commits: the change waits.
      expect(await settlesWithin(ending, 750)).toBe(false);
    } finally {
      held.open();
    }

    const settled = await settling;
    expect(settled).toMatchObject({
      commissionMatched: true,
      commissionOutcome: 'RULE_APPLIED',
      commissionAmountMinor: 60_000n,
    });
    const ended = await ending!;
    expect(ended.validTo!.getTime()).toBeGreaterThanOrEqual(settled.settledAt.getTime() - 1);
    expect((await readAll(prisma, transactionId)).commission).toMatchObject({
      ruleId: rule.id,
      amountMinor: 60_000n,
    });
  });

  it('still answers the refusal when its record cannot be written', async () => {
    const payee = `${payer}-UNRECORDED`;
    const transactionId = await authorised(payee);
    const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
    jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (tx, input) => {
      if (input.eventName === 'SETTLEMENT_REFUSED') throw new Error('injected outbox failure');
      return enqueue(tx, input);
    });

    await expect(
      asPayer(() => wiring.settlements.settle(transactionId, actor)),
    ).rejects.toMatchObject({ code: 'NO_ACTIVE_RULE' });

    expect(await outbox(prisma, 'SETTLEMENT_REFUSED', transactionId)).toEqual([]);
    expect((await readAll(prisma, transactionId)).transaction.status).toBe('PENDING_SETTLEMENT');
  });

  it('charges the rule recorded with the fact even after it ended, and refuses nothing (docs/23 D-057)', async () => {
    const payee = `${payer}-RECORDED`;
    await fundWallet(wiring, payee, 0n);
    const rule = await createRule(payee, 300);
    const transactionId = await authorised(payee);
    expect((await readAll(prisma, transactionId)).transaction.pricingRuleId).toBe(rule.id);
    await endRule(rule.id);

    const settled = await asPayer(() => wiring.settlements.settle(transactionId, actor));

    expect(settled).toMatchObject({
      commissionMatched: true,
      commissionOutcome: 'RULE_APPLIED',
      commissionAmountMinor: 60_000n,
    });
  });
});
