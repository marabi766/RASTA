import { ulid } from 'ulid';
import { runUnscoped } from '@rasta/nest-common';
import { asActor, cleanup, newPrisma, readBalances, tenants, wire, type Wiring } from './helpers';
import { PaymentService } from '../src/payment/payment.service';
import { walletBalanceLimit } from '../src/wallet/wallet.repository';
import { MockPaymentProvider } from '../src/payment/mock.provider';
import { ECONOMIC_EVENTS } from '../src/events/events';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * A payment's state and the event announcing it commit together (ADR-021;
 * economic batch 2, item c).
 *
 * `PAYMENT_AUTHORIZED` used to be written in a second transaction after the
 * intent was marked AUTHORIZED. A failure between the two left an intent in a
 * state no consumer ever heard about. The failure is injected at the outbox
 * write, which is the second half of the unit; everything else is real.
 */
describe('payment authorisation atomicity (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  let payments: PaymentService;
  let provider: MockPaymentProvider;
  const org = tenants();

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
    provider = new MockPaymentProvider();
    payments = new PaymentService(
      prisma,
      wiring.ledger,
      wiring.wallets,
      wiring.walletRepository,
      provider,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(prisma, [org.a, org.b, org.c]);
    await prisma.onModuleDestroy();
  });

  const intentsOf = (organizationId: string) =>
    runUnscoped('the suite reads the intents it created', () =>
      prisma.client.paymentIntent.findMany({ where: { organizationId } }),
    );

  const eventsOf = (organizationId: string, eventName: string) =>
    runUnscoped('the suite reads the outbox rows it caused', () =>
      prisma.client.outboxMessage.findMany({ where: { organizationId, eventName } }),
    );

  async function topUp(organizationId: string) {
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    return asActor({ organizationId }, () =>
      payments.topUp(wallet.id, {
        amountMinor: '500000',
        idempotencyKey: `ATOMIC-${ulid()}`,
      }),
    );
  }

  it('leaves the intent CREATED when its PAYMENT_AUTHORIZED row cannot be written', async () => {
    const organizationId = `${org.a}-AUTHROLLBACK`;
    const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
    jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (tx, input) => {
      if (input.eventName === ECONOMIC_EVENTS.PAYMENT_AUTHORIZED) {
        throw new Error('outbox write failed');
      }
      return enqueue(tx, input);
    });

    await expect(topUp(organizationId)).rejects.toThrow('outbox write failed');

    // Neither half: the intent was never marked, and no event claims it was.
    const [intent] = await intentsOf(organizationId);
    expect(intent).toMatchObject({
      status: 'CREATED',
      authorizedAt: null,
      providerReference: null,
    });
    expect(await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_AUTHORIZED)).toHaveLength(0);

    await cleanup(prisma, [organizationId]);
  });

  it('writes both halves when nothing fails', async () => {
    const organizationId = `${org.b}-AUTHOK`;
    const result = await topUp(organizationId);
    expect(result.status).toBe('CAPTURED');

    const [authorized] = await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_AUTHORIZED);
    expect(authorized?.aggregateId).toBe(result.paymentIntentId);
    const [intent] = await intentsOf(organizationId);
    expect(intent?.authorizedAt).not.toBeNull();

    await cleanup(prisma, [organizationId]);
  });

  // Codex review of PR #121, finding 1: a balance is a sum, and each capped
  // amount fitting a BIGINT does not make the sum fit.

  const MAX = 9_223_372_036_854_775_807n;

  async function topUpBy(organizationId: string, amountMinor: bigint) {
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    return asActor({ organizationId }, () =>
      payments.topUp(wallet.id, {
        amountMinor: amountMinor.toString(),
        idempotencyKey: `LIMIT-${ulid()}`,
      }),
    );
  }

  it('refuses a top-up past the largest balance before the provider is asked', async () => {
    const organizationId = `${org.b}-LIMIT`;
    expect((await topUpBy(organizationId, MAX)).status).toBe('CAPTURED');

    const authorize = jest.spyOn(provider, 'authorize');
    await expect(topUpBy(organizationId, 1n)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      status: 422,
    });
    // Never reached the provider: nothing was captured that could not be
    // credited, and no intent was written for the refused request.
    expect(authorize).not.toHaveBeenCalled();
    const intents = await intentsOf(organizationId);
    expect(intents.map((intent) => intent.status)).toEqual(['CAPTURED']);

    await cleanup(prisma, [organizationId]);
  });

  it('reserves the headroom, so two concurrent top-ups cannot both pass it', async () => {
    const organizationId = `${org.c}-LIMIT-RACE`;
    const half = MAX / 2n + 1n;
    const outcomes = await Promise.all([
      topUpBy(organizationId, half).then(
        (result) => result.status,
        (error: { code?: string }) => error.code,
      ),
      topUpBy(organizationId, half).then(
        (result) => result.status,
        (error: { code?: string }) => error.code,
      ),
    ]);
    expect([...outcomes].sort()).toEqual(['BUSINESS_RULE_VIOLATION', 'CAPTURED']);
    // No intent left AUTHORIZED over a capture the ledger could not take.
    const intents = await intentsOf(organizationId);
    expect(intents.map((intent) => intent.status)).toEqual(['CAPTURED']);

    await cleanup(prisma, [organizationId]);
  });

  it('refunds a capture the ledger could not credit, and records the intent FAILED', async () => {
    // Another credit racing in between the reservation and the capture is
    // stood in for by the credit refusing with the balance limit.
    const organizationId = `${org.a}-UNCREDITED`;
    jest.spyOn(wiring.wallets, 'credit').mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
    const refund = jest.spyOn(provider, 'refund');

    const result = await topUpBy(organizationId, 700n);
    expect(result).toMatchObject({ status: 'FAILED', failureReason: 'WALLET_BALANCE_LIMIT' });
    expect(refund).toHaveBeenCalledTimes(1);

    const [intent] = await intentsOf(organizationId);
    expect(intent).toMatchObject({ status: 'FAILED', failureReason: 'WALLET_BALANCE_LIMIT' });
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    expect((await readBalances(prisma, wallet.id)).ledger).toBe(0n);

    await cleanup(prisma, [organizationId]);
  });

  it('treats a provider refund that throws like one that refuses', async () => {
    // A provider down at the worst moment: the refund call itself fails.
    const organizationId = `${org.c}-STUCK-THROW`;
    jest.spyOn(wiring.wallets, 'credit').mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
    jest.spyOn(provider, 'refund').mockRejectedValueOnce(new Error('provider unreachable'));

    await expect(topUpBy(organizationId, 900n)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
    });
    const [intent] = await intentsOf(organizationId);
    expect(intent).toMatchObject({ status: 'AUTHORIZED', failureReason: 'CAPTURED_NOT_CREDITED' });
    // Announced in the transaction that marked it (Codex round 2, F2).
    const [alert] = await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_CAPTURE_UNRECONCILED);
    expect(alert?.aggregateId).toBe(intent?.id);
    expect((alert?.payload as { payload?: { reason?: string } })?.payload?.reason).toBe(
      'WALLET_BALANCE_LIMIT',
    );

    await cleanup(prisma, [organizationId]);
  });

  it('marks, and does not hide, a capture it could neither credit nor refund', async () => {
    const organizationId = `${org.b}-STUCK`;
    jest.spyOn(wiring.wallets, 'credit').mockRejectedValueOnce(new Error('connection reset'));
    jest.spyOn(provider, 'refund').mockResolvedValueOnce({
      outcome: 'FAILED',
      providerReference: 'x',
      failureCode: 'PROVIDER_UNAVAILABLE',
      simulated: true,
    });

    await expect(topUpBy(organizationId, 800n)).rejects.toThrow('connection reset');
    const [intent] = await intentsOf(organizationId);
    // AUTHORIZED, because money is held at the provider; marked for a person.
    expect(intent).toMatchObject({ status: 'AUTHORIZED', failureReason: 'CAPTURED_NOT_CREDITED' });

    await cleanup(prisma, [organizationId]);
  });

  // Codex review of PR #121, round 2.

  async function topUpWith(organizationId: string, amountMinor: bigint, idempotencyKey: string) {
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    return asActor({ organizationId }, () =>
      payments.topUp(wallet.id, { amountMinor: amountMinor.toString(), idempotencyKey }),
    );
  }

  it('does not refund a capture whose write committed and then reported a failure', async () => {
    // F1: the commit succeeds and its acknowledgement is lost. The third
    // transaction of a top-up is the capture write (after the reservation and
    // the authorisation).
    const organizationId = `${org.a}-AMBIGUOUS`;
    await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    const original = prisma.transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
    let calls = 0;
    jest.spyOn(prisma, 'transaction').mockImplementation((async (...args: unknown[]) => {
      calls += 1;
      const result = await original(...args);
      if (calls === 3) throw new Error('connection lost after commit');
      return result;
    }) as PrismaService['transaction']);
    const refund = jest.spyOn(provider, 'refund');

    const result = await topUpWith(organizationId, 600n, `AMBIG-${ulid()}`);

    expect(calls).toBe(3);
    expect(result).toMatchObject({ status: 'CAPTURED', amountMinor: 600n });
    expect(result.journalId).toMatch(/^JRN_/);
    expect(refund).not.toHaveBeenCalled();
    const [intent] = await intentsOf(organizationId);
    expect(intent).toMatchObject({ status: 'CAPTURED', transactionId: result.transactionId });
    expect(await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_FAILED)).toHaveLength(0);
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    expect((await readBalances(prisma, wallet.id)).ledger).toBe(600n);

    await cleanup(prisma, [organizationId]);
  });

  it('compensates nothing when the outcome of a failed write cannot be read back', async () => {
    const organizationId = `${org.b}-UNKNOWN`;
    jest.spyOn(wiring.wallets, 'credit').mockRejectedValueOnce(new Error('connection reset'));
    jest
      .spyOn(
        payments as unknown as { committedCapture: () => Promise<unknown> },
        'committedCapture',
      )
      .mockRejectedValueOnce(new Error('database unreachable'));
    const refund = jest.spyOn(provider, 'refund');

    await expect(topUpWith(organizationId, 650n, `UNKNOWN-${ulid()}`)).rejects.toThrow(
      'connection reset',
    );
    expect(refund).not.toHaveBeenCalled();
    const [intent] = await intentsOf(organizationId);
    expect(intent).toMatchObject({ status: 'AUTHORIZED', failureReason: null });

    await cleanup(prisma, [organizationId]);
  });

  it('credits a stranded capture on a same-key retry, once, without asking the provider again', async () => {
    // F2: the first attempt can neither credit nor refund.
    const organizationId = `${org.c}-RESUME`;
    const key = `RESUME-${ulid()}`;
    jest.spyOn(wiring.wallets, 'credit').mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
    jest.spyOn(provider, 'refund').mockRejectedValueOnce(new Error('provider unreachable'));
    await expect(topUpWith(organizationId, 750n, key)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
    });

    // Still uncreditable on the first retry: the same refusal, still marked.
    jest.spyOn(wiring.wallets, 'credit').mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
    await expect(topUpWith(organizationId, 750n, key)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
    });
    expect((await intentsOf(organizationId))[0]).toMatchObject({
      status: 'AUTHORIZED',
      failureReason: 'CAPTURED_NOT_CREDITED',
    });

    const authorize = jest.spyOn(provider, 'authorize');
    const capture = jest.spyOn(provider, 'capture');
    const result = await topUpWith(organizationId, 750n, key);
    expect(result).toMatchObject({ status: 'CAPTURED', amountMinor: 750n });
    expect(authorize).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();

    const intents = await intentsOf(organizationId);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ id: result.paymentIntentId, status: 'CAPTURED' });
    const wallet = await asActor({ organizationId }, () => wiring.wallets.getOrOpen('IRR'));
    expect((await readBalances(prisma, wallet.id)).ledger).toBe(750n);
    expect(await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_COMPLETED)).toHaveLength(1);
    expect(
      await eventsOf(organizationId, ECONOMIC_EVENTS.PAYMENT_CAPTURE_UNRECONCILED),
    ).toHaveLength(1);

    // And a further retry replays it rather than crediting twice.
    const replay = await topUpWith(organizationId, 750n, key);
    expect(replay).toMatchObject({
      status: 'CAPTURED',
      paymentIntentId: result.paymentIntentId,
      journalId: result.journalId,
    });
    expect((await readBalances(prisma, wallet.id)).ledger).toBe(750n);

    await cleanup(prisma, [organizationId]);
  });

  it('answers a same-key retry as the intent finished, and refuses a changed request', async () => {
    const organizationId = `${org.a}-REPLAY`;

    const failedKey = `REPLAY-F-${ulid()}`;
    jest.spyOn(wiring.wallets, 'credit').mockRejectedValueOnce(walletBalanceLimit('WLT_STAND_IN'));
    expect((await topUpWith(organizationId, 300n, failedKey)).status).toBe('FAILED');
    const refund = jest.spyOn(provider, 'refund');
    expect(await topUpWith(organizationId, 300n, failedKey)).toMatchObject({
      status: 'FAILED',
      failureReason: 'WALLET_BALANCE_LIMIT',
    });
    expect(refund).not.toHaveBeenCalled();

    const capturedKey = `REPLAY-C-${ulid()}`;
    const first = await topUpWith(organizationId, 400n, capturedKey);
    expect(await topUpWith(organizationId, 400n, capturedKey)).toMatchObject({
      status: 'CAPTURED',
      paymentIntentId: first.paymentIntentId,
      transactionId: first.transactionId,
    });
    await expect(topUpWith(organizationId, 401n, capturedKey)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await intentsOf(organizationId)).toHaveLength(2);

    await cleanup(prisma, [organizationId]);
  });

  it('refuses a same-key retry of an intent whose outcome is not known yet', async () => {
    const organizationId = `${org.b}-INFLIGHT`;
    const key = `INFLIGHT-${ulid()}`;
    const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
    jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (tx, input) => {
      if (input.eventName === ECONOMIC_EVENTS.PAYMENT_AUTHORIZED) throw new Error('outbox down');
      return enqueue(tx, input);
    });
    await expect(topUpWith(organizationId, 200n, key)).rejects.toThrow('outbox down');

    const authorize = jest.spyOn(provider, 'authorize');
    await expect(topUpWith(organizationId, 200n, key)).rejects.toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
    });
    expect(authorize).not.toHaveBeenCalled();
    expect((await intentsOf(organizationId))[0]).toMatchObject({ status: 'CREATED' });

    await cleanup(prisma, [organizationId]);
  });
});
