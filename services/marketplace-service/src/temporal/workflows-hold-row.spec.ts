import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import type { WorkflowHandle } from '@temporalio/client';
import { RastaError } from '@rasta/nest-common';
import { createTemporalTestEnvironment } from '../../test/temporal-environment';
import { eventually as askUntil, signalling, stopQuietly } from '../../test/legacy-handoff';
import { currentDeadline, runBounded, SETTLE_MS } from '../../test/worker-deadline';
import {
  createActivities,
  ECONOMIC_HOLD_RULE_UNCONFIRMED,
  type OrderActivities,
} from './activities';
import {
  HOLD_DEADLINE_PASSED,
  HOLD_FENCE,
  HOLD_SENDS_CLOSED,
  holdDeadlineFrom,
  REFUSED_ON_FIRST_ATTEMPT,
} from './economic-refusal';
import {
  orderSaga,
  retryDisputeRelease,
  type OrderSagaInput,
  type SagaResume,
  type SagaStatus,
} from './workflows';
import type { OrderService } from '../order/order.service';
import type { EconomicClient } from '../economic/economic.client';

/**
 * Review of #812 round 2, F1 and F2 (PM decision D-144). A run cannot know what an earlier
 * run sent, so what a later run needs is on the order row. Here the workflow and the real
 * `createObligation` and `noHoldCanLand` run over that row in memory: a run that finds the
 * row as an earlier run left it is what a Temporal reset leaves. The row's own SQL has its
 * spec against PostgreSQL (`order-hold-fence.int-spec.ts`).
 */

/**
 * What the worker runs of one test may take, all of them together (FU-214):
 * no less than jest's whole test took before, and inside jest's timeout, with
 * room to stop what the test started.
 */
const TEST_BUDGET_MS = 120_000;
jest.setTimeout(TEST_BUDGET_MS + 60_000);
/** How long, at least, a saga is given to come quiet before it is terminated. */
const QUIET_FLOOR_MS = SETTLE_MS / 4;

const INPUT: OrderSagaInput = {
  orderId: 'ORD_ROW',
  fulfillmentWindowDays: 7,
  receiptWindowDays: 3,
  reminderIntervalDays: 3,
  recheckIntervalHours: 24 * 365,
};
const STATUS = { phase: 'WAS', deferredSteps: [], remindersRecorded: 0, settlementAttempts: 0 };
const BROKE = 'INSUFFICIENT_BALANCE';
const refuse = (code: string) => new RastaError(code as never, 'refused');

interface Row {
  status: string;
  economicTransactionId: string | null;
  cancellationReason: string | null;
  holdNotAfter: string | null;
  claims: number;
  closed: boolean;
}
type Sent = { holdNotAfter?: string };

/** The hold's call record (#836, FU-145), as `openSagaCall`/`confirmSagaCall` keep it. */
interface CallRecord {
  open: boolean;
  generation: number;
  /** The row's count of sends at each opening. */
  openedAtClaims: number[];
}
const freshRecord = (): CallRecord => ({ open: false, generation: 0, openedAtClaims: [] });

/** What the three repository methods do in SQL, over one row, by `now`. */
function ordersOver(
  row: Row,
  now: () => Promise<number> | number,
  record: CallRecord = freshRecord(),
) {
  return {
    openSagaCall: async () => {
      const started = !record.open;
      record.open = true;
      record.generation += 1;
      record.openedAtClaims.push(row.claims);
      return { generation: record.generation, started };
    },
    confirmSagaCall: async (
      _o: unknown,
      _operation: unknown,
      _subject: unknown,
      opening: { generation: number },
    ) => {
      if (opening.generation === record.generation) record.open = false;
    },
    describe: async () => ({
      id: INPUT.orderId,
      status: row.status,
      buyerOrganizationId: 'ORG_B',
      supplierOrganizationId: 'ORG_S',
      totalAmountMinor: '1000',
      currency: 'IRR',
      economicTransactionId: row.economicTransactionId,
      correlationId: 'COR',
    }),
    onceForSaga: (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => call(),
    sagaView: async () => ({
      status: row.status,
      economicTransactionId: row.economicTransactionId,
      cancellationReason: row.cancellationReason,
      dispute: null,
      holdNotAfter: row.holdNotAfter,
      holdSendsClosed: row.closed,
      holdMayHaveSent: row.claims > 0,
    }),
    claimHoldSend: async (_o: unknown, proposed?: string) => {
      if (row.closed || row.status === 'FAILED' || row.status === 'CANCELLED') {
        return { closed: row.closed };
      }
      if (row.claims === 0 && proposed !== undefined) row.holdNotAfter ??= proposed;
      row.claims += 1;
      return { holdNotAfter: row.holdNotAfter, claims: row.claims };
    },
    closeHoldSendsOnRefusal: async () => {
      if (row.claims !== 1 || row.closed) return false;
      row.closed = true;
      return true;
    },
    closeHoldSendsIfNoneCanLand: async (_o: unknown, marginMs: number) => {
      const passed =
        row.holdNotAfter !== null && (await now()) >= Date.parse(row.holdNotAfter) + marginMs;
      if (!row.closed && row.claims !== 0 && !passed) return false;
      row.closed = true;
      return true;
    },
  };
}

const freshRow = (over: Partial<Row> = {}): Row => ({
  status: 'PENDING',
  economicTransactionId: null,
  cancellationReason: null,
  holdNotAfter: null,
  claims: 0,
  closed: false,
  ...over,
});

describe('createObligation: what the row says of earlier sends (D-144)', () => {
  const PROPOSED = '2026-11-08T00:00:00.000Z';
  const EARLIER = '2026-11-07T00:00:00.000Z';

  function activity(
    row: Row,
    send: (input: Sent) => unknown = () => {
      throw refuse(BROKE);
    },
    attempt = 1,
    record: CallRecord = freshRecord(),
    advertises: () => Promise<boolean> = async () => true,
  ) {
    const sent: Sent[] = [];
    const activities = createActivities({
      orders: ordersOver(row, () => 0, record) as unknown as OrderService,
      economic: {
        createObligation: async (input: Sent) => {
          sent.push(input);
          return send(input);
        },
        readObligation: async () => ({ status: 'HELD', heldProven: true }),
        requiresOrderHoldDeadline: advertises,
      } as unknown as EconomicClient,
      currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
      currentAttempt: () => attempt,
    });
    return { activities, sent };
  }
  const failure = (attempt: Promise<unknown>): Promise<ApplicationFailure> =>
    attempt.then(
      () => {
        throw new Error('expected a failure');
      },
      (error: ApplicationFailure) => error,
    );

  it('the first send there has ever been: the deadline is on the row before it leaves, and its refusal is proof', async () => {
    const row = freshRow();
    const seen: Row[] = [];
    const { activities, sent } = activity(row, () => {
      seen.push({ ...row });
      throw refuse(BROKE);
    });
    const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(seen[0]).toMatchObject({ holdNotAfter: PROPOSED, claims: 1, closed: false });
    expect(sent).toEqual([expect.objectContaining({ holdNotAfter: PROPOSED })]);
    expect(caught).toMatchObject({ type: BROKE, details: [REFUSED_ON_FIRST_ATTEMPT] });
    expect(row.closed).toBe(true);
  });

  it('a replacement run: attempt 1 again, the earlier deadline on the wire, its refusal no proof', async () => {
    const row = freshRow({ holdNotAfter: EARLIER, claims: 1 });
    const { activities, sent } = activity(row);
    const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(sent).toEqual([expect.objectContaining({ holdNotAfter: EARLIER })]);
    expect(row.holdNotAfter).toBe(EARLIER);
    expect(caught.details ?? []).toEqual([]);
    expect(row.closed).toBe(false);
  });

  it('an older run that claims after this send began: this refusal is no proof', async () => {
    const row = freshRow();
    const { activities } = activity(row, () => {
      row.claims += 1;
      throw refuse(BROKE);
    });
    const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(caught.details ?? []).toEqual([]);
    expect(row.closed).toBe(false);
  });

  it('an older run that arrives after the proof sends nothing', async () => {
    const row = freshRow();
    const first = activity(row);
    await failure(first.activities.createObligation(INPUT.orderId, PROPOSED));
    const older = activity(row);
    const caught = await failure(older.activities.createObligation(INPUT.orderId, EARLIER));
    expect(older.sent).toEqual([]);
    expect(caught).toMatchObject({ type: HOLD_SENDS_CLOSED, details: [HOLD_SENDS_CLOSED] });
    expect(row.claims).toBe(1);
  });

  it('a later attempt of the first send: counted, no proof, sends left open', async () => {
    const row = freshRow();
    const { activities } = activity(row, undefined, 2);
    const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(caught.details ?? []).toEqual([]);
    expect(row).toMatchObject({ claims: 1, closed: false });
  });

  it('a row that may have sent before the fence: never a deadline, never proof', async () => {
    const row = freshRow({ claims: 1 });
    const { activities, sent } = activity(row);
    const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(sent[0]).not.toHaveProperty('holdNotAfter');
    expect(row.holdNotAfter).toBeNull();
    expect(caught.details ?? []).toEqual([]);
  });

  it('a round of a wait from before the fence, proposing nothing: no proof even as the first claim', async () => {
    const row = freshRow();
    const { activities, sent } = activity(row);
    const caught = await failure(activities.createObligation(INPUT.orderId));
    expect(sent[0]).not.toHaveProperty('holdNotAfter');
    expect(caught.details ?? []).toEqual([]);
    expect(row.closed).toBe(false);
  });

  /**
   * #836 with #812: the call record opens once the row has counted the send, and closes on
   * a refusal only where both rules hold: the row's proof (first attempt, first send ever,
   * the sends now shut) and the record's (it began here; economic-service's own refusal
   * that held nothing, under its own status).
   */
  describe('the call record (#836, FU-145)', () => {
    /** economic-service's own refusal before any effect, as the client reports it. */
    const ownRefusal = () =>
      new RastaError(BROKE as never, 'refused', {
        internalContext: { operation: 'x', status: 422 },
      });

    it('the first send there has ever been, refused before any effect: opened after the claim, then confirmed', async () => {
      const row = freshRow();
      const record = freshRecord();
      const { activities } = activity(
        row,
        () => {
          expect(record.open).toBe(true);
          throw ownRefusal();
        },
        1,
        record,
      );
      const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
      expect(caught).toMatchObject({ type: BROKE, details: [REFUSED_ON_FIRST_ATTEMPT] });
      expect(row.closed).toBe(true);
      expect(record).toMatchObject({ open: false, openedAtClaims: [1] });
    });

    it('a refusal the row proves but that is not economic-service’s own: the record stays open', async () => {
      const row = freshRow();
      const record = freshRecord();
      const { activities } = activity(row, undefined, 1, record);
      await failure(activities.createObligation(INPUT.orderId, PROPOSED));
      expect(row.closed).toBe(true);
      expect(record.open).toBe(true);
    });

    it.each([
      [
        'a replacement run (an earlier send counted)',
        { holdNotAfter: EARLIER, claims: 1 },
        PROPOSED,
        1,
      ],
      ['a later attempt', {}, PROPOSED, 2],
      ['a round from before the fence', {}, undefined, 1],
    ] as const)(
      '%s: economic-service’s own refusal leaves the record open',
      async (_name, over, proposed, attempt) => {
        const row = freshRow(over);
        const record = freshRecord();
        const { activities } = activity(
          row,
          () => {
            throw ownRefusal();
          },
          attempt,
          record,
        );
        const caught = await failure(activities.createObligation(INPUT.orderId, proposed));
        expect(caught.details ?? []).toEqual([]);
        expect(record.open).toBe(true);
      },
    );

    it('an earlier record still open: this refusal began nothing, and confirms nothing', async () => {
      const row = freshRow();
      const record: CallRecord = { open: true, generation: 3, openedAtClaims: [0] };
      const { activities } = activity(
        row,
        () => {
          throw ownRefusal();
        },
        1,
        record,
      );
      await failure(activities.createObligation(INPUT.orderId, PROPOSED));
      expect(record).toMatchObject({ open: true, generation: 4 });
    });

    it('a deadline refusal leaves the record open: a send claimed before it may still land', async () => {
      const row = freshRow();
      const record = freshRecord();
      const { activities } = activity(
        row,
        () => {
          throw new RastaError(HOLD_DEADLINE_PASSED as never, 'past it', {
            internalContext: { operation: 'x', status: 422 },
          });
        },
        1,
        record,
      );
      const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
      expect(caught.type).toBe(HOLD_DEADLINE_PASSED);
      expect(record.open).toBe(true);
    });

    it.each([
      ['its sends closed', { claims: 1, closed: true }],
      ['the order closed', { status: 'FAILED' }],
    ] as const)('a row with %s sends nothing and opens no record', async (_name, over) => {
      const row = freshRow(over);
      const record = freshRecord();
      const { activities, sent } = activity(row, undefined, 1, record);
      await failure(activities.createObligation(INPUT.orderId, PROPOSED));
      expect(sent).toEqual([]);
      expect(record).toEqual(freshRecord());
    });

    it('a proven refusal, then an older run: the confirmed record is not reopened', async () => {
      const row = freshRow();
      const record = freshRecord();
      const refusing = () => {
        throw ownRefusal();
      };
      await failure(
        activity(row, refusing, 1, record).activities.createObligation(INPUT.orderId, PROPOSED),
      );
      expect(record.open).toBe(false);
      const older = activity(row, refusing, 1, record);
      const caught = await failure(older.activities.createObligation(INPUT.orderId, EARLIER));
      expect(caught.type).toBe(HOLD_SENDS_CLOSED);
      expect(record).toMatchObject({ open: false, generation: 1 });
    });

    /**
     * #836 with #948 (FU-233, D-150/D-154): the row is proof only on economic-service's
     * explicit yes, asked again after the send. Where it is not had then, the refusal is not
     * proof, so the record is not confirmed, even for economic-service's own refusal on the
     * first send there has ever been.
     */
    it.each([
      ['its explicit no', async (): Promise<boolean> => false, false],
      [
        'no answer',
        async (): Promise<boolean> => {
          throw new Error('timed out');
        },
        true,
      ],
    ] as const)(
      'the rule after the send is %s: economic-service’s own refusal leaves the record open',
      async (_name, after, rowClosed) => {
        const row = freshRow();
        const record = freshRecord();
        let asked = 0;
        const { activities, sent } = activity(
          row,
          () => {
            throw ownRefusal();
          },
          1,
          record,
          async () => ((asked += 1) === 1 ? true : after()),
        );
        const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
        expect(sent).toHaveLength(1);
        expect(caught.details ?? []).toEqual([]);
        expect(row.closed).toBe(rowClosed);
        expect(record).toMatchObject({ open: true, generation: 1, openedAtClaims: [1] });
      },
    );

    it('the rule not had before the send: nothing sent, no record opened', async () => {
      const row = freshRow();
      const record = freshRecord();
      const { activities, sent } = activity(row, undefined, 1, record, async () => false);
      const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
      expect(caught.type).toBe(ECONOMIC_HOLD_RULE_UNCONFIRMED);
      expect(sent).toEqual([]);
      expect(record).toEqual(freshRecord());
    });

    it('a row kept closed with the rule unanswered, then a yes: the next attempt sends nothing and the record stays open', async () => {
      const row = freshRow();
      const record = freshRecord();
      let asked = 0;
      const first = activity(
        row,
        () => {
          throw ownRefusal();
        },
        1,
        record,
        async () => {
          if ((asked += 1) > 1) throw new Error('timed out');
          return true;
        },
      );
      await failure(first.activities.createObligation(INPUT.orderId, PROPOSED));
      expect(row.closed).toBe(true);
      const next = activity(row, undefined, 2, record);
      const ended = await failure(next.activities.createObligation(INPUT.orderId, PROPOSED));
      expect(next.sent).toEqual([]);
      expect(ended.type).toBe(HOLD_SENDS_CLOSED);
      expect(record).toMatchObject({ open: true, generation: 1 });
    });

    it('answered: the record the send opened is confirmed', async () => {
      const row = freshRow();
      const record = freshRecord();
      const { activities } = activity(row, () => ({ id: 'TXN' }), 1, record);
      await expect(activities.createObligation(INPUT.orderId, PROPOSED)).resolves.toEqual({
        transactionId: 'TXN',
      });
      expect(record).toMatchObject({ open: false, generation: 1, openedAtClaims: [1] });
    });

    it('answered without a send (the id already on the order): an earlier open record is confirmed', async () => {
      const row = freshRow({ economicTransactionId: 'TXN', claims: 1 });
      const record: CallRecord = { open: true, generation: 1, openedAtClaims: [1] };
      const { activities, sent } = activity(row, undefined, 2, record);
      await expect(activities.createObligation(INPUT.orderId, PROPOSED)).resolves.toEqual({
        transactionId: 'TXN',
      });
      expect(sent).toEqual([]);
      expect(record).toMatchObject({ open: false, generation: 2 });
      expect(row.claims).toBe(1);
    });
  });

  it('the row cannot record the proof: no proof, and the retry stays in doubt', async () => {
    const row = freshRow();
    const orders = {
      ...ordersOver(row, () => 0),
      closeHoldSendsOnRefusal: async () => {
        throw new Error('database gone');
      },
    };
    const activities = createActivities({
      orders: orders as unknown as OrderService,
      economic: {
        createObligation: async () => {
          throw refuse(BROKE);
        },
        requiresOrderHoldDeadline: async () => true,
      } as unknown as EconomicClient,
      currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
      currentAttempt: () => 1,
    });
    const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(caught.details ?? []).toEqual([]);
    expect(row.closed).toBe(false);
  });

  /**
   * FU-233: the row is proof only while economic-service says it refuses a send no row
   * counted (D-150). Its release before the rule does not say it (`heldProven` alone), and
   * an answer that does not come is no yes either.
   */
  const UNCONFIRMED: [string, () => Promise<boolean>][] = [
    ['economic-service before D-150 does not say it', async () => false],
    [
      'the capability cannot be read',
      async () => {
        throw new Error('unreadable');
      },
    ],
  ];

  it.each(UNCONFIRMED)('%s: no hold is sent, nothing counted, no proof', async (_n, advertises) => {
    const row = freshRow();
    const { activities, sent } = activity(row, undefined, 1, freshRecord(), advertises);
    const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(sent).toEqual([]);
    // Not retried within this scheduling (#948 r1, F1): a retry's send would be a later
    // attempt's, whose refusal is no proof. The saga's next round sends on a first attempt.
    expect(caught).toMatchObject({ type: ECONOMIC_HOLD_RULE_UNCONFIRMED, nonRetryable: true });
    expect(caught.details ?? []).toEqual([]);
    expect(row).toMatchObject({ claims: 0, holdNotAfter: null, closed: false });
  });

  it.each(UNCONFIRMED)('%s: an empty row does not say no hold can land', async (_n, advertises) => {
    const row = freshRow();
    const { activities } = activity(row, undefined, 1, freshRecord(), advertises);
    await expect(activities.noHoldCanLand(INPUT.orderId)).resolves.toBe(false);
    expect(row.closed).toBe(false);
  });

  it('a closed order’s row, on economic-service’s explicit no, reads as from before the fence', async () => {
    const row = freshRow({ status: 'CANCELLED', holdNotAfter: EARLIER, claims: 1, closed: true });
    const { activities } = activity(row, undefined, 1, freshRecord(), async () => false);
    await expect(activities.readOrder(INPUT.orderId)).resolves.toMatchObject({
      status: 'CANCELLED',
      holdNotAfter: null,
      holdSendsClosed: false,
      holdMayHaveSent: true,
    });
    const trusted = activity(row);
    await expect(trusted.activities.readOrder(INPUT.orderId)).resolves.toMatchObject({
      holdNotAfter: EARLIER,
      holdSendsClosed: true,
    });
  });

  it('a closed order’s row, with no answer: the read waits for one, and a blip changes nothing', async () => {
    const row = freshRow({ status: 'FAILED', claims: 1, closed: true });
    let down = true;
    let asked = 0;
    const { activities } = activity(row, undefined, 1, freshRecord(), async () => {
      asked += 1;
      if (down) throw new Error('timed out');
      return true;
    });
    await expect(failure(activities.readOrder(INPUT.orderId))).resolves.toMatchObject({
      type: ECONOMIC_HOLD_RULE_UNCONFIRMED,
      nonRetryable: false,
    });
    // Asked again within the read before it gives up (review of #948 r1, F1).
    expect(asked).toBe(3);
    down = false;
    await expect(activities.readOrder(INPUT.orderId)).resolves.toMatchObject({
      holdSendsClosed: true,
      holdMayHaveSent: true,
    });
  });

  it('a closed order’s row, one blip: asked again within the read, which answers', async () => {
    const row = freshRow({ status: 'FAILED', claims: 1, closed: true });
    let asked = 0;
    const { activities } = activity(row, undefined, 1, freshRecord(), async () => {
      if ((asked += 1) === 1) throw new Error('timed out');
      return true;
    });
    await expect(activities.readOrder(INPUT.orderId)).resolves.toMatchObject({
      holdSendsClosed: true,
    });
  });

  it.each([
    ['an open order', freshRow({ claims: 1, closed: true })],
    [
      'an order with its obligation',
      freshRow({ status: 'CANCELLED', economicTransactionId: 'T', closed: true }),
    ],
    ['a closed order whose row proves nothing', freshRow({ status: 'FAILED', claims: 1 })],
  ])('%s: read as it is, without asking', async (_n, row) => {
    let asked = 0;
    const { activities } = activity(row, undefined, 1, freshRecord(), async () => {
      asked += 1;
      return false;
    });
    await expect(activities.readOrder(INPUT.orderId)).resolves.toMatchObject({
      holdSendsClosed: row.closed,
    });
    expect(asked).toBe(0);
  });

  it('a blip before the send is asked again: the first send still goes on attempt 1, its refusal proof', async () => {
    const row = freshRow();
    let answers = 0;
    const { activities, sent } = activity(row, undefined, 1, freshRecord(), async () => {
      if ((answers += 1) === 1) throw new Error('timed out');
      return true;
    });
    const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(sent).toHaveLength(1);
    expect(caught).toMatchObject({ type: BROKE, details: [REFUSED_ON_FIRST_ATTEMPT] });
    expect(row.closed).toBe(true);
  });

  it.each([
    ['its first refusal', BROKE],
    ['the fence’s refusal', HOLD_DEADLINE_PASSED],
  ])('the rule gone while the send was out: %s is no proof', async (_n, code) => {
    const row = freshRow();
    let asked = 0;
    const { activities, sent } = activity(
      row,
      () => {
        throw refuse(code);
      },
      1,
      freshRecord(),
      async () => (asked += 1) === 1,
    );
    const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(sent).toHaveLength(1);
    expect(caught.details ?? []).toEqual([]);
    expect(row.closed).toBe(false);
  });

  /**
   * Review of #948 r1, F1: a refusal that is proof once the rule says yes. Unanswered after
   * the send, the proof is kept on the row (closed), and decided by the next yes, never lost.
   */
  it('its first refusal, the rule unanswered after the send: the row keeps the proof, and the next attempt ends on it without sending', async () => {
    const row = freshRow();
    let asked = 0;
    const { activities, sent } = activity(row, undefined, 1, freshRecord(), async () => {
      if ((asked += 1) > 1) throw new Error('timed out');
      return true;
    });
    const caught = await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(sent).toHaveLength(1);
    // Not proof yet: the workflow waits, as for any refusal it cannot take at its word.
    expect(caught.details ?? []).toEqual([]);
    expect(row).toMatchObject({ claims: 1, closed: true });

    const next = activity(row, undefined, 2);
    const ended = await failure(next.activities.createObligation(INPUT.orderId, PROPOSED));
    expect(next.sent).toEqual([]);
    expect(ended).toMatchObject({ type: HOLD_SENDS_CLOSED, details: [HOLD_SENDS_CLOSED] });
  });

  it('its first refusal, the rule unanswered after the send and then its explicit no: the kept proof decides nothing', async () => {
    const row = freshRow();
    let asked = 0;
    const { activities } = activity(row, undefined, 1, freshRecord(), async () => {
      if ((asked += 1) > 1) throw new Error('timed out');
      return true;
    });
    await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(row.closed).toBe(true);

    const refused = activity(row, undefined, 1, freshRecord(), async () => false);
    const caught = await failure(refused.activities.createObligation(INPUT.orderId, PROPOSED));
    expect(refused.sent).toEqual([]);
    expect(caught).toMatchObject({ type: ECONOMIC_HOLD_RULE_UNCONFIRMED });
    expect(caught.details ?? []).toEqual([]);
    await expect(refused.activities.noHoldCanLand(INPUT.orderId)).resolves.toBe(false);
  });

  it('a later attempt’s refusal, the rule unanswered: nothing is kept, the sends stay open', async () => {
    // The first claim there has been, on attempt 2: only the attempt keeps this from proof.
    const row = freshRow();
    let asked = 0;
    const { activities } = activity(row, undefined, 2, freshRecord(), async () => {
      if ((asked += 1) > 1) throw new Error('timed out');
      return true;
    });
    await failure(activities.createObligation(INPUT.orderId, PROPOSED));
    expect(row).toMatchObject({ claims: 1, closed: false });
  });
});

describe('a run that finds the row an earlier run left (#812 r2 F1)', () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  let queues = 0;

  /** Set when a test may have stalled the server's clock: the next test gets a new one. */
  let stalled = false;
  let budgetEndsAt = 0;

  beforeAll(async () => {
    workflowBundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') });
    env = await createTemporalTestEnvironment();
  }, 300_000);
  beforeEach(async () => {
    if (stalled) {
      // The new one first: `env` never names a server already torn down.
      const fresh = await createTemporalTestEnvironment();
      await env.teardown();
      env = fresh;
      stalled = false;
    }
    budgetEndsAt = Date.now() + TEST_BUDGET_MS;
  }, 300_000);
  afterAll(async () => {
    await env?.teardown();
  });

  type Fn = (...args: never[]) => unknown;

  /** An empty wallet's economic-service: its refusal, and past the deadline the fence's. */
  const emptyWallet = async (input: Sent): Promise<never> => {
    const past =
      input.holdNotAfter !== undefined &&
      (await env.currentTimeMs()) > Date.parse(input.holdNotAfter);
    throw refuse(past ? HOLD_DEADLINE_PASSED : BROKE);
  };

  function saga(
    row: Row,
    overrides: Record<string, Fn> = {},
    holds: (input: Sent) => Promise<unknown> = emptyWallet,
    advertises: () => Promise<boolean> = async () => true,
  ) {
    const calls: string[] = [];
    const sent: Sent[] = [];
    const rounds: string[] = [];
    const closedAt: number[] = [];
    const proposed: unknown[] = [];
    const real = createActivities({
      orders: ordersOver(row, () => env.currentTimeMs()) as unknown as OrderService,
      economic: {
        createObligation: async (input: Sent) => {
          sent.push(input);
          return holds(input);
        },
        readObligation: async () => ({ status: 'HELD', heldProven: true }),
        requiresOrderHoldDeadline: advertises,
      } as unknown as EconomicClient,
    });
    const close = (to: string) => async () => {
      closedAt.push(await env.currentTimeMs());
      row.status = to;
      return to;
    };
    const base: Record<string, Fn> = {
      readOrder: real.readOrder as unknown as Fn,
      createObligation: real.createObligation as unknown as Fn,
      noHoldCanLand: real.noHoldCanLand as unknown as Fn,
      findObligation: () => null,
      compensate: () => undefined,
      markFundsHeld: () => row.status,
      markFailed: async () => (row.status === 'PENDING' ? close('FAILED')() : row.status),
      markCancelled: close('CANCELLED'),
      recordReminder: () => undefined,
      noteReleaseUnconfirmed: () => undefined,
      noteEconomicCallUnconfirmed: (_id: never, operation: never, _round: never, words: never) => {
        rounds.push(`${String(operation)}: ${String(words)}`);
      },
      ...overrides,
    };
    const activities = Object.fromEntries(
      Object.entries(base).map(([name, fn]) => [
        name,
        (...args: never[]) => {
          calls.push(name);
          if (name === 'createObligation') proposed.push(args[1]);
          return fn(...args);
        },
      ]),
    ) as unknown as OrderActivities;
    return { calls, sent, rounds, closedAt, proposed, activities };
  }

  async function drive<T>(
    { activities }: ReturnType<typeof saga>,
    body: (handle: WorkflowHandle) => Promise<T>,
    input: Partial<OrderSagaInput> = {},
  ): Promise<T> {
    const taskQueue = `hold-row-${(queues += 1)}`;
    const running = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities,
    });
    // Under what is left of the test's budget (FU-214): every wait and SDK call
    // in `body` ends with it, and `body` is awaited before the worker stops.
    const ms = Math.max(budgetEndsAt - Date.now(), 0);
    return runBounded(
      running,
      { what: 'the test to drive the saga', ms, connection: env.connection },
      async (deadline) => {
        const latest = env.client.workflow.getHandle(taskQueue);
        let result: T;
        try {
          const handle = signalling(
            env,
            await env.client.workflow.start(orderSaga, {
              taskQueue,
              workflowId: taskQueue,
              args: [{ ...INPUT, ...input }],
            }),
          );
          result = await body(handle);
        } catch (error) {
          // Cut off, an awaited result may have left the clock unlocked, and
          // what follows must fit in the settle window; otherwise the saga gets
          // what is left of the budget to come quiet, as on success.
          const cutOff = deadline.signal.aborted;
          if (cutOff) stalled = true;
          const window = cutOff
            ? QUIET_FLOOR_MS
            : Math.max(budgetEndsAt - Date.now(), QUIET_FLOOR_MS);
          if ((await stopQuietly(env.connection, latest, window, QUIET_FLOOR_MS)) !== undefined) {
            stalled = true;
          }
          throw error;
        }
        // Not with an activity running: the test server would not skip time again.
        const window = Math.max(budgetEndsAt - Date.now(), QUIET_FLOOR_MS);
        const loud = await stopQuietly(env.connection, latest, window, QUIET_FLOOR_MS);
        if (loud !== undefined) {
          stalled = true;
          throw new Error(`${loud}: stopped with an activity in flight`);
        }
        return result;
      },
    );
  }

  /** Asks until `predicate` holds, under the run's deadline; refused outside a run (FU-214). */
  const eventually = (predicate: () => boolean | Promise<boolean>, what: string): Promise<void> =>
    askUntil(currentDeadline(what), async () => predicate(), what);
  const phase = async (handle: WorkflowHandle) =>
    (await handle.query<SagaStatus, []>('status')).phase;
  /**
   * `handle.result()`: the run's deadline ends it, and the body is awaited
   * before the worker stops (FU-214); outside a run it is refused.
   */
  const resultOf = (handle: WorkflowHandle): Promise<unknown> =>
    currentDeadline('the saga to end').call(() => handle.result());

  /** The row of a run whose first send was `ago`, its answer never heard, then reset. */
  const leftBy = async (over: Partial<Row> = {}, ago = 60_000) => {
    const holdNotAfter = holdDeadlineFrom((await env.currentTimeMs()) - ago);
    return {
      row: freshRow({ holdNotAfter, claims: 1, ...over }),
      limit: Date.parse(holdNotAfter) + HOLD_FENCE.clockMarginMs,
    };
  };
  const cancelling = { status: 'CANCELLING', cancellationReason: 'changed their mind' };

  it('the replacement’s first refusal: the order stays open until the persisted deadline and margin', async () => {
    const { row, limit } = await leftBy();
    const deadline = row.holdNotAfter;
    const s = saga(row);
    await expect(drive(s, resultOf)).resolves.toBe('FAILED');
    expect(s.closedAt[0]).toBeGreaterThan(limit);
    expect(s.rounds[0]).toContain('createObligation');
    // The deadline never moved, and it is what every request carried.
    expect(row.holdNotAfter).toBe(deadline);
    expect(new Set(s.sent.map((input) => input.holdNotAfter))).toEqual(new Set([deadline]));
    // And what this run took for its own, so it judges the fence by that same deadline.
    expect(new Set(s.proposed)).toEqual(new Set([deadline]));
    expect(s.sent.length).toBeGreaterThan(2);
  });

  it('the replacement starting at CANCELLING: no send, not cancelled until the persisted deadline and margin', async () => {
    const { row, limit } = await leftBy(cancelling);
    const s = saga(row);
    await expect(drive(s, resultOf)).resolves.toBe('CANCELLED');
    expect(s.closedAt[0]).toBeGreaterThanOrEqual(limit);
    expect(s.sent).toEqual([]);
    expect(s.calls).not.toContain('compensate');
    expect(row.closed).toBe(true);
    // Asked before the lookup: an empty answer from before it would cover nothing.
    expect(s.calls.indexOf('noHoldCanLand')).toBeLessThan(s.calls.indexOf('findObligation'));
    expect(s.calls.at(-2)).toBe('findObligation');
  });

  it('the replacement starting at CANCELLING: a hold that lands meanwhile is refunded', async () => {
    const { row } = await leftBy(cancelling);
    let landed = false;
    const s = saga(row, {
      findObligation: () => (landed ? { transactionId: 'TXN_LATE' } : null),
    });
    await expect(
      drive(s, async (handle) => {
        await eventually(() => s.rounds.length > 0, 'the wait');
        landed = true;
        await handle.signal(retryDisputeRelease);
        return resultOf(handle);
      }),
    ).resolves.toBe('CANCELLED');
    expect(s.calls).toContain('compensate');
  });

  it('the replacement finding the order closed: it watches until the persisted deadline and margin', async () => {
    const { row, limit } = await leftBy({ status: 'FAILED' });
    const s = saga(row);
    let ended = 0;
    await expect(
      drive(s, async (handle) => {
        const result = await resultOf(handle);
        ended = await env.currentTimeMs();
        return result;
      }),
    ).resolves.toBe('FAILED');
    expect(ended).toBeGreaterThanOrEqual(limit);
    expect(s.calls.filter((call) => call === 'findObligation').length).toBeGreaterThan(1);
    expect(s.sent).toEqual([]);
    // A watch, not a wait: an empty lookup is what it expects, and raises no alert.
    expect(s.rounds).toEqual([]);
    expect(s.calls).not.toContain('noHoldCanLand');
  });

  it('the replacement finding the order closed: a hold that lands is refunded, the order stays closed', async () => {
    const { row } = await leftBy({ status: 'CANCELLED' });
    const s = saga(row, { findObligation: () => ({ transactionId: 'TXN_LATE' }) });
    await expect(drive(s, resultOf)).resolves.toBe('CANCELLED');
    expect(s.calls).toContain('compensate');
    expect(row.status).toBe('CANCELLED');
  });

  it.each([
    ['its sends closed', { closed: true }, 60_000],
    ['past deadline and margin', {}, 26 * 3600_000],
  ])('a closed order with %s: nothing to watch', async (_name, over, ago) => {
    const { row } = await leftBy({ status: 'FAILED', ...over }, ago);
    const s = saga(row);
    await expect(drive(s, resultOf)).resolves.toBe('FAILED');
    expect(s.calls).not.toContain('findObligation');
  });

  it('a row closed by a proven refusal: the replacement sends nothing and ends at once', async () => {
    const { row, limit } = await leftBy({ closed: true });
    const s = saga(row);
    await expect(drive(s, resultOf)).resolves.toBe('FAILED');
    expect(s.sent).toEqual([]);
    expect(s.closedAt[0]).toBeLessThan(limit);
  });

  it('a first run, its first send refused: the order closes at once, as ever', async () => {
    const row = freshRow();
    const s = saga(row);
    const started = await env.currentTimeMs();
    await expect(drive(s, resultOf)).resolves.toBe('FAILED');
    expect(s.closedAt[0] - started).toBeLessThan(HOLD_FENCE.clockMarginMs);
    expect(s.rounds).toEqual([]);
    expect(row).toMatchObject({ claims: 1, closed: true });
    expect(s.calls).not.toContain('noHoldCanLand');
  });

  /**
   * Review of #948 r1, F1 (FU-233): the first send's refusal is proof once economic-service
   * has said yes before it. A capability question that then goes unanswered only delays that
   * proof: it does not leave the order waiting out the deadline and margin.
   */
  it('a first run, its first send refused and the rule unanswered right after: the order still closes before the deadline', async () => {
    const row = freshRow();
    let blip = false;
    const s = saga(
      row,
      {
        noteEconomicCallUnconfirmed: (_id: never, operation: never, _r: never, words: never) => {
          blip = false;
          s.rounds.push(`${String(operation)}: ${String(words)}`);
        },
      },
      async (input) => {
        blip = true;
        return emptyWallet(input);
      },
      async () => {
        if (blip) throw new Error('timed out');
        return true;
      },
    );
    const started = await env.currentTimeMs();
    await expect(drive(s, resultOf)).resolves.toBe('FAILED');
    expect(s.closedAt[0] - started).toBeLessThan(HOLD_FENCE.clockMarginMs);
    expect(s.sent).toHaveLength(1);
    expect(row).toMatchObject({ claims: 1, closed: true });
  });

  it('a first run, the rule unanswered before its first send: the send still goes on a first attempt, and its refusal closes the order', async () => {
    const row = freshRow();
    const s = saga(row, {}, emptyWallet, async () => {
      // Unanswered on the first scheduling's first attempt only: back by its retry.
      if (Context.current().info.attempt === 1 && s.sent.length === 0 && s.rounds.length === 0) {
        throw new Error('connection refused');
      }
      return true;
    });
    const started = await env.currentTimeMs();
    await expect(drive(s, resultOf)).resolves.toBe('FAILED');
    expect(s.closedAt[0] - started).toBeLessThan(HOLD_FENCE.clockMarginMs);
    expect(s.sent).toHaveLength(1);
    expect(row).toMatchObject({ claims: 1, closed: true });
  });

  it('a first run, cancelled as its first send is refused: closes at once, with no doubt', async () => {
    const row = freshRow();
    const real = saga(row);
    const s = saga(row, {
      createObligation: (async (id: string, deadline: string) => {
        row.status = 'CANCELLING';
        row.cancellationReason = 'changed their mind';
        return (real.activities.createObligation as (a: string, b: string) => unknown)(
          id,
          deadline,
        );
      }) as unknown as Fn,
    });
    await expect(drive(s, resultOf)).resolves.toBe('CANCELLED');
    expect(s.rounds).toEqual([]);
    expect(s.calls).toContain('noHoldCanLand');
  });

  it('a row that may have sent before the fence: no refusal or empty lookup closes it, past any deadline', async () => {
    const row = freshRow({ claims: 1, ...cancelling });
    const s = saga(row);
    await drive(s, async (handle) => {
      await eventually(() => s.rounds.length > 0, 'the wait');
      expect(await phase(handle)).toBe('COMPENSATION_UNCONFIRMED');
    });
    expect(row.status).toBe('CANCELLING');
    expect(s.calls).not.toContain('markCancelled');
  });

  describe('a legacy watch, from before the fence (protocol 9)', () => {
    const watching = async (order: string): Promise<Partial<OrderSagaInput>> => ({
      resume: {
        status: STATUS,
        waitingIn: order,
        activitySequence: 7,
        lateHoldWatch: { until: (await env.currentTimeMs()) - 1000, reason: 'given up on' },
      } as unknown as SagaResume,
    });

    it('an expired watch does not end on one empty lookup: it stays, and the alert says why', async () => {
      const row = freshRow({ status: 'FAILED' });
      const s = saga(row);
      await drive(
        s,
        async (handle) => {
          await eventually(() => s.rounds.length > 0, 'the alert');
          expect(await phase(handle)).toBe('LATE_HOLD_WATCH');
          expect((await handle.describe()).status.name).toBe('RUNNING');
        },
        await watching('FAILED'),
      );
      expect(s.rounds[0]).toContain('createObligation: A hold sent with no deadline');
    });

    it('a run that finds such an order closed: the same, with no watch handed to it', async () => {
      const row = freshRow({ status: 'CANCELLED', claims: 1 });
      const s = saga(row);
      await drive(s, async (handle) => {
        await eventually(() => s.rounds.length > 0, 'the alert');
        expect(await phase(handle)).toBe('LATE_HOLD_WATCH');
      });
      expect(row.closed).toBe(false);
    });

    it('a closed order no send was ever begun for: nothing to watch', async () => {
      const row = freshRow({ status: 'CANCELLED' });
      const s = saga(row);
      await expect(drive(s, resultOf)).resolves.toBe('CANCELLED');
      expect(s.calls).not.toContain('findObligation');
    });

    it('rolled over before the order closed: the order stays open', async () => {
      const row = freshRow();
      const s = saga(row);
      await drive(
        s,
        async () => {
          await eventually(() => s.rounds.length > 0, 'the alert');
        },
        await watching('PENDING'),
      );
      expect(row.status).toBe('PENDING');
      expect(s.calls).not.toContain('markFailed');
    });

    it('the hold landing is refunded, and only then does the order close', async () => {
      const row = freshRow();
      let landed = false;
      const s = saga(row, {
        findObligation: () => (landed ? { transactionId: 'TXN_LATE' } : null),
      });
      await expect(
        drive(
          s,
          async (handle) => {
            await eventually(() => s.rounds.length > 0, 'the alert');
            landed = true;
            await handle.signal(retryDisputeRelease);
            return resultOf(handle);
          },
          await watching('PENDING'),
        ),
      ).resolves.toBe('FAILED');
      expect(s.calls).toContain('compensate');
      expect(s.calls.indexOf('compensate')).toBeLessThan(s.calls.indexOf('markFailed'));
    });

    it('a terminal obligation with nothing to refund answers it', async () => {
      const row = freshRow({ status: 'FAILED' });
      const s = saga(row, {
        findObligation: () => ({
          notHeld: true,
          transactionId: 'T',
          status: 'REFUNDED',
          funds: 'RETURNED',
        }),
      });
      await expect(drive(s, resultOf, await watching('FAILED'))).resolves.toBe('FAILED');
      expect(s.calls).not.toContain('compensate');
    });

    it('a watch with its deadline carried still ends when it expires', async () => {
      const row = freshRow({ status: 'FAILED' });
      const s = saga(row);
      const input = await watching('FAILED');
      (input.resume as SagaResume).holdNotAfter = holdDeadlineFrom(0);
      await expect(drive(s, resultOf, input)).resolves.toBe('FAILED');
      expect(s.rounds).toEqual([]);
    });
  });

  /**
   * Review of #812 r3, F1 (PM decision D-150): an older or rolled-back marketplace build
   * sends the hold of an order this build placed, counting nothing on its row and carrying
   * no deadline, and that request lands after this build's saga has decided from the row.
   * The row cannot know of it, so economic-service refuses every such send, whoever sends
   * it (`refuseUnfencedOrderHold`, proven against the real endpoint and database in
   * economic-service's `order-hold-deadline-required.int-spec.ts`). Here that service is
   * a ledger under the order's one key, and each of the four consequences the review
   * reproduced is driven to its end. Its invariant: no hold is left held on an order the
   * saga closed without refunding it. `fenced: false` is the service before D-150, which
   * held such a send: the same runs then strand it, as the review found.
   */
  describe('an older build’s send, on an order this build placed (#812 r3 F1, D-150)', () => {
    function economicService({ fenced = true } = {}) {
      /** `orderHoldDeadlineRequired`: the release with the rule says it, one before does not. */
      const advertises = async () => fenced;
      const ledger = { funded: false, held: [] as string[], refunded: [] as string[] };
      let heldWith: string | undefined;
      const holds = async (input: Sent): Promise<{ id: string }> => {
        // One key: a hold already there answers the same request, and refuses another,
        // before any rule of the work is asked.
        if (ledger.held.length > 0 && heldWith !== input.holdNotAfter) {
          throw refuse('IDEMPOTENCY_KEY_REUSED');
        }
        if (fenced && input.holdNotAfter === undefined) throw refuse('HOLD_DEADLINE_REQUIRED');
        await emptyWallet(input).catch((refusal: RastaError) => {
          if (refusal.code === HOLD_DEADLINE_PASSED || !ledger.funded) throw refusal;
        });
        if (ledger.held.length === 0) {
          ledger.held.push('TXN_OLDER');
          heldWith = input.holdNotAfter;
        }
        return { id: ledger.held[0]! };
      };
      return {
        ledger,
        holds,
        advertises,
        /** What the saga can see of the ledger: the lookup, and the refund. */
        overrides: {
          findObligation: () => {
            const open = ledger.held.filter((id) => !ledger.refunded.includes(id));
            return open.length > 0 ? { transactionId: open[0] } : null;
          },
          compensate: () => {
            ledger.refunded.push(...ledger.held);
          },
        } as Record<string, Fn>,
        /**
         * origin/main's `createObligation`, the build a rollback runs: the same request,
         * nothing claimed on the row and no deadline (that build has neither). It left
         * before this build's saga decided, and is let through to land afterwards, with the
         * buyer's wallet funded by then.
         */
        olderBuildsSendLands: async (row: Row) => {
          const claims = row.claims;
          ledger.funded = true;
          const answer = await holds({}).catch((refusal: unknown) => refusal);
          expect(row.claims).toBe(claims);
          return answer;
        },
        /** Held on an order the saga closed, never refunded: the money the review lost. */
        stranded: () => ledger.held.filter((id) => !ledger.refunded.includes(id)),
      };
    }
    /**
     * The four consequences the review reproduced. Each drives a run of this build to its
     * end over a row an older build's send never counted on, and checks what the run
     * decided from it, the decision the review found unsafe.
     */
    const CONSEQUENCES: [
      string,
      () => Promise<Row>,
      (s: ReturnType<typeof saga>, row: Row) => Promise<void>,
    ][] = [
      [
        'zero count: the replacement cancels on "no send began"',
        async () => freshRow(cancelling),
        async (s) => {
          await expect(drive(s, resultOf)).resolves.toBe('CANCELLED');
          expect(s.calls).toContain('noHoldCanLand');
          expect(s.sent).toEqual([]);
        },
      ],
      [
        'first-ever refusal: the order fails at once on it',
        async () => freshRow(),
        async (s, row) => {
          const started = await env.currentTimeMs();
          await expect(drive(s, resultOf)).resolves.toBe('FAILED');
          expect(s.closedAt[0]! - started).toBeLessThan(HOLD_FENCE.clockMarginMs);
          expect(row).toMatchObject({ claims: 1, closed: true });
        },
      ],
      [
        'deadline expiry: the replacement fails the order past deadline and margin',
        async () => (await leftBy()).row,
        async (s, row) => {
          const limit = Date.parse(row.holdNotAfter!) + HOLD_FENCE.clockMarginMs;
          await expect(drive(s, resultOf)).resolves.toBe('FAILED');
          expect(s.closedAt[0]).toBeGreaterThan(limit);
          expect(s.sent.every((input) => input.holdNotAfter === row.holdNotAfter)).toBe(true);
        },
      ],
      [
        'closed-order recovery: the replacement finds no recorded send and ends',
        async () => freshRow({ status: 'CANCELLED' }),
        async (s) => {
          await expect(drive(s, resultOf)).resolves.toBe('CANCELLED');
          expect(s.calls).not.toContain('findObligation');
        },
      ],
    ];

    it.each(CONSEQUENCES)(
      '%s, and the older send that lands holds nothing',
      async (_name, rowOf, decides) => {
        const row = await rowOf();
        const economic = economicService();
        await decides(saga(row, economic.overrides, economic.holds, economic.advertises), row);

        expect(await economic.olderBuildsSendLands(row)).toMatchObject({
          code: 'HOLD_DEADLINE_REQUIRED',
        });
        expect(economic.stranded()).toEqual([]);
      },
    );

    it.each(CONSEQUENCES)(
      'before D-150, its row taken as proof all the same, %s, and the older send that lands is held for good',
      async (_name, rowOf, decides) => {
        const row = await rowOf();
        const economic = economicService({ fenced: false });
        // What FU-233 refuses: the row trusted without the rule's yes.
        await decides(
          saga(row, economic.overrides, economic.holds, async () => true),
          row,
        );

        expect(await economic.olderBuildsSendLands(row)).toEqual({ id: 'TXN_OLDER' });
        expect(economic.stranded()).toEqual(['TXN_OLDER']);
      },
    );

    /**
     * Review of #812 r4, N1 trigger (a) (FU-233): economic-service rolled back below D-150
     * and an older marketplace build sending again without the gate. That release does not
     * say it refuses an uncounted send, so this build decides nothing on the row and sends
     * nothing: it waits with the alert on, and the older send that lands is found, then
     * refunded on a cancelled order or adopted on an open one. Never stranded.
     */
    const RESCUES: [string, () => Promise<Row>, 'CANCELLED' | 'FUNDS_HELD'][] = [
      ['zero count', async () => freshRow(cancelling), 'CANCELLED'],
      ['first-ever refusal', async () => freshRow(), 'FUNDS_HELD'],
      ['deadline expiry', async () => (await leftBy()).row, 'FUNDS_HELD'],
      ['closed-order recovery', async () => freshRow({ status: 'CANCELLED' }), 'CANCELLED'],
    ];
    it.each(RESCUES)(
      'before D-150, which does not say it: %s decides nothing on the row, and the older send that lands is not stranded',
      async (_name, rowOf, ends) => {
        const row = await rowOf();
        const economic = economicService({ fenced: false });
        const s = saga(
          row,
          {
            ...economic.overrides,
            markFundsHeld: () => {
              row.status = 'FUNDS_HELD';
              return 'FUNDS_HELD';
            },
          },
          economic.holds,
          economic.advertises,
        );
        await drive(s, async (handle) => {
          await eventually(() => s.rounds.length > 0, 'the wait');
          expect(row.status).not.toBe('FAILED');
          expect(await economic.olderBuildsSendLands(row)).toEqual({ id: 'TXN_OLDER' });
          await handle.signal(retryDisputeRelease);
          if (ends === 'CANCELLED') {
            await expect(resultOf(handle)).resolves.toBe('CANCELLED');
          } else {
            await eventually(() => s.calls.includes('markFundsHeld'), 'the hold adopted');
          }
        });
        expect(s.sent).toEqual([]);
        expect(row.closed).toBe(false);
        expect(row.status).toBe(ends);
        if (ends === 'CANCELLED') expect(economic.stranded()).toEqual([]);
        else expect(economic.ledger.refunded).toEqual([]);
      },
    );

    it('this build’s own counted send still holds, and the older build’s send after it holds nothing more', async () => {
      const row = freshRow();
      const economic = economicService();
      economic.ledger.funded = true;
      const s = saga(
        row,
        { ...economic.overrides, markFundsHeld: () => 'FUNDS_HELD' },
        economic.holds,
      );
      await drive(s, async () => {
        await eventually(() => s.calls.includes('markFundsHeld'), 'the hold');
      });
      expect(economic.ledger.held).toEqual(['TXN_OLDER']);
      expect(s.sent[0]?.holdNotAfter).toBe(row.holdNotAfter);
      expect(await economic.olderBuildsSendLands(row)).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      expect(economic.ledger.held).toEqual(['TXN_OLDER']);
    });
  });

  describe('a terminal obligation in the hold’s recovery (#812 r2 F2)', () => {
    const lost = (): never => {
      throw ApplicationFailure.nonRetryable('gateway', 'UPSTREAM_UNAVAILABLE');
    };
    const TERMINAL = [
      ['REFUNDED', 'RETURNED'],
      ['CANCELLED', 'NEVER_HELD'],
      ['FAILED', 'NEVER_HELD'],
    ] as const;
    const noMoney = (s: ReturnType<typeof saga>) => {
      expect(s.calls).not.toContain('compensate');
      expect(s.calls).not.toContain('markFundsHeld');
    };

    it.each(TERMINAL)(
      '%s (funds %s), the buyer cancelled: cancelled, no refund, no FUNDS_HELD',
      async (status, funds) => {
        const row = freshRow();
        const s = saga(row, {
          createObligation: () => {
            row.status = 'CANCELLING';
            row.cancellationReason = 'changed their mind';
            return lost();
          },
          findObligation: () => ({ notHeld: true, transactionId: 'T', status, funds }),
        });
        await expect(drive(s, resultOf)).resolves.toBe('CANCELLED');
        expect(row.status).toBe('CANCELLED');
        noMoney(s);
      },
    );

    it.each(TERMINAL)(
      '%s (funds %s), found only after rounds of doubt: the wait ends too',
      async (status, funds) => {
        const row = freshRow();
        let lookups = 0;
        const s = saga(row, {
          createObligation: () => {
            row.status = 'CANCELLING';
            row.cancellationReason = 'changed their mind';
            return lost();
          },
          findObligation: () =>
            (lookups += 1) <= 2 ? null : { notHeld: true, transactionId: 'T', status, funds },
        });
        await expect(drive(s, resultOf)).resolves.toBe('CANCELLED');
        noMoney(s);
      },
    );

    it('after rounds of doubt the hold’s wait is over: a read refused next waits as a read', async () => {
      const row = freshRow();
      let lookups = 0;
      let refuseRead = false;
      const s = saga(row, {
        createObligation: () => {
          row.status = 'CANCELLING';
          row.cancellationReason = 'changed their mind';
          return lost();
        },
        findObligation: () =>
          (lookups += 1) <= 2
            ? null
            : { notHeld: true, transactionId: 'T', status: 'REFUNDED', funds: 'RETURNED' },
        markFailed: () => {
          refuseRead = true;
          return row.status;
        },
        readOrder: () => {
          if (refuseRead) {
            refuseRead = false;
            throw ApplicationFailure.nonRetryable('no', 'FORBIDDEN');
          }
          return { ...row, dispute: null };
        },
      });
      await expect(drive(s, resultOf)).resolves.toBe('CANCELLED');
      expect(s.rounds.at(-1)).toContain('readOrder');
      noMoney(s);
    });

    it.each(TERMINAL)(
      '%s (funds %s), nobody cancelled: the order fails, its stock returned',
      async (status, funds) => {
        const row = freshRow();
        const s = saga(row, {
          createObligation: lost,
          findObligation: () => ({ notHeld: true, transactionId: 'T', status, funds }),
        });
        await expect(drive(s, resultOf)).resolves.toBe('FAILED');
        noMoney(s);
      },
    );

    it.each([
      ['SETTLED', 'PAID_OUT'],
      ['PENDING_SETTLEMENT', 'UNPROVEN'],
      ['DISPUTED', 'UNPROVEN'],
      ['CREATED', 'NEVER_HELD'],
    ])('%s (funds %s): stays conservative, the order as it was', async (status, funds) => {
      const row = freshRow();
      const s = saga(row, {
        createObligation: lost,
        findObligation: () => ({ notHeld: true, transactionId: 'T', status, funds }),
      });
      const failure = await drive(s, resultOf).catch((error: unknown) => error);
      expect(failure).toMatchObject({ cause: { type: 'OBLIGATION_NOT_HELD' } });
      expect(row.status).toBe('PENDING');
      expect(s.calls).not.toContain('markFailed');
      noMoney(s);
    });
  });
});
