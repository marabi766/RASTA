import { runUnscoped } from '@rasta/nest-common';
import { asActor, cleanup, fundWallet, newPrisma, tenants, wire, type Wiring } from './helpers';
import { ECONOMIC_EVENTS } from '../src/events/events';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Every lifecycle step of a transaction records who and when, and announces
 * itself in the same database transaction (AGENTS.md S-06, ADR-021; economic
 * batch 2, item b).
 *
 * Before this, creating an obligation without a hold, confirming receipt and
 * cancelling each changed the row and told nobody, and the last two did not
 * even record who had done it.
 */
describe('transaction lifecycle audit (real database)', () => {
  let prisma: PrismaService;
  let wiring: Wiring;
  const org = tenants();
  const payer = `${org.a}-AUDIT`;
  const payee = `${org.b}-AUDIT`;
  const outsider = `${org.c}-AUDIT`;
  const actor = 'USR-ITEST-TXN-AUDIT';

  beforeAll(() => {
    prisma = newPrisma();
    wiring = wire(prisma);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanup(prisma, [payer, payee, outsider]);
    await prisma.onModuleDestroy();
  });

  const asPayer = <T>(fn: () => Promise<T>) =>
    asActor({ organizationId: payer, userId: actor }, fn);

  const create = (holdFunds = false) =>
    asPayer(() =>
      wiring.transactions.create({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor: '250000',
        currency: 'IRR',
        holdFunds,
      }),
    );

  const changesOf = async (transactionId: string) => {
    const rows = await runUnscoped('the suite reads the outbox rows a transaction caused', () =>
      prisma.client.outboxMessage.findMany({
        where: {
          aggregateId: transactionId,
          eventName: ECONOMIC_EVENTS.TRANSACTION_STATUS_CHANGED,
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    // The outbox row holds the whole envelope; the event's payload is inside.
    return rows.map((row) => (row.payload as { payload: Record<string, unknown> }).payload);
  };

  const rowOf = (transactionId: string) =>
    runUnscoped('the suite reads the transaction row itself', () =>
      prisma.client.transaction.findUniqueOrThrow({ where: { id: transactionId } }),
    );

  it('announces an obligation created without a hold, and who created it', async () => {
    const created = await create();

    expect(await changesOf(created.id)).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        fromStatus: null,
        toStatus: 'CREATED',
        changedBy: actor,
        organizationId: payer,
        counterpartyOrganizationId: payee,
        grossAmountMinor: '250000',
      }),
    ]);
  });

  it('announces a creation that held funds with the status it ends in', async () => {
    await fundWallet(wiring, payer, 1_000_000n);
    const created = await create(true);

    const [creation] = await changesOf(created.id);
    expect(creation).toMatchObject({ action: 'CREATE', fromStatus: null, toStatus: 'HELD' });
  });

  it('records who confirmed receipt and when, on the row and in the record', async () => {
    const created = await create();
    await asPayer(() => wiring.transactions.authoriseSettlement(created.id));

    const row = await rowOf(created.id);
    expect(row.status).toBe('PENDING_SETTLEMENT');
    expect(row.settlementAuthorisedBy).toBe(actor);
    expect(row.settlementAuthorisedAt).not.toBeNull();

    const [, authorised] = await changesOf(created.id);
    expect(authorised).toMatchObject({
      action: 'AUTHORISE_SETTLEMENT',
      fromStatus: 'CREATED',
      toStatus: 'PENDING_SETTLEMENT',
      changedBy: actor,
      changedAt: row.settlementAuthorisedAt!.toISOString(),
    });
  });

  it('records who cancelled and when', async () => {
    const created = await create();
    await asPayer(() => wiring.transactions.cancel(created.id, 'ordered by mistake'));

    const row = await rowOf(created.id);
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelledBy).toBe(actor);
    expect(row.cancelledAt).not.toBeNull();

    const [, cancelled] = await changesOf(created.id);
    expect(cancelled).toMatchObject({
      action: 'CANCEL',
      fromStatus: 'CREATED',
      toStatus: 'CANCELLED',
      changedBy: actor,
    });
    // The free-text reason stays on the row, never on the wire (S-09).
    expect(JSON.stringify(cancelled)).not.toContain('ordered by mistake');
  });

  it('records disputes, their resolution and a refund as steps too', async () => {
    await fundWallet(wiring, payer, 1_000_000n);
    const created = await create(true);
    await asPayer(() => wiring.transactions.dispute(created.id, { reason: 'not delivered' }));
    await asPayer(() =>
      wiring.transactions.resolveDispute(created.id, { resolution: 'delivered after all' }),
    );
    // The payer may not refund its own transaction; the order saga may.
    const saga = {
      organizationId: payer,
      userId: 'marketplace-service',
      authType: 'SERVICE' as const,
    };
    await asActor(saga, () => wiring.transactions.refund(created.id, 'refund agreed'));

    const actions = (await changesOf(created.id)).map((change) => [
      change.action,
      change.fromStatus,
      change.toStatus,
    ]);
    expect(actions).toEqual([
      ['CREATE', null, 'HELD'],
      ['DISPUTE', 'HELD', 'DISPUTED'],
      ['RESOLVE_DISPUTE', 'DISPUTED', 'PENDING_SETTLEMENT'],
      ['REFUND', 'PENDING_SETTLEMENT', 'REFUNDED'],
    ]);
    const row = await rowOf(created.id);
    expect(row.refundedBy).toBe('marketplace-service');
    expect(row.refundedAt).not.toBeNull();
  });

  it('rolls the step back when its record cannot be written', async () => {
    const created = await create();
    const enqueue = wiring.ledger.enqueue.bind(wiring.ledger);
    jest.spyOn(wiring.ledger, 'enqueue').mockImplementation(async (tx, input) => {
      if (input.eventName === ECONOMIC_EVENTS.TRANSACTION_STATUS_CHANGED) {
        throw new Error('outbox write failed');
      }
      return enqueue(tx, input);
    });

    await expect(
      asPayer(() => wiring.transactions.authoriseSettlement(created.id)),
    ).rejects.toThrow('outbox write failed');

    const row = await rowOf(created.id);
    expect(row.status).toBe('CREATED');
    expect(row.settlementAuthorisedBy).toBeNull();
    expect(await changesOf(created.id)).toHaveLength(1);
  });

  it('lets no other tenant move a transaction, and records nothing when it tries', async () => {
    const created = await create();

    await expect(
      asActor({ organizationId: outsider, userId: 'USR-ITEST-OUTSIDER' }, () =>
        wiring.transactions.authoriseSettlement(created.id),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const row = await rowOf(created.id);
    expect(row.status).toBe('CREATED');
    expect(row.settlementAuthorisedBy).toBeNull();
    expect(await changesOf(created.id)).toHaveLength(1);
  });
});
