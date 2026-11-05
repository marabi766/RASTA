import { Logger } from '@nestjs/common';
import { createActivities } from './activities';
import { economicCallsUnconfirmedTotal, releasesUnconfirmedTotal } from '../observability/metrics';
import { ActivityFailure } from '@temporalio/client';
import { RastaError } from '@rasta/nest-common';
import { ApplicationFailure } from '@temporalio/activity';
import { OWNER_STATE_IS_FINAL, REFUSED_ON_FIRST_ATTEMPT } from './economic-refusal';
import { outcomeUnknown } from './workflows';
import type { EconomicClient } from '../economic/economic.client';
import type { OrderService } from '../order/order.service';

/** The report of an unconfirmed release (FU-080): what the alert and the operator read. */
it('counts each round from a series that starts at zero, and logs the order', async () => {
  const count = async (): Promise<number | undefined> =>
    (await releasesUnconfirmedTotal.get()).values[0]?.value;
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  try {
    expect(await count()).toBeUndefined();
    const activities = createActivities({
      orders: {} as OrderService,
      economic: {} as EconomicClient,
    });
    // `increase()` cannot see the first increment of a series that was not there.
    expect(await count()).toBe(0);

    await activities.noteReleaseUnconfirmed('ORD_NOTE', 4, 'UPSTREAM_UNAVAILABLE: down');

    expect(await count()).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toContain('ORD_NOTE');
    expect(error.mock.calls[0]?.[0]).toContain('round 4');
    expect(error.mock.calls[0]?.[0]).toContain('UPSTREAM_UNAVAILABLE: down');
  } finally {
    error.mockRestore();
  }
});

it('reports another economic call by operation, from a series at zero (FU-103)', async () => {
  const count = async (): Promise<number | undefined> =>
    (await economicCallsUnconfirmedTotal.get()).values.find(
      (value) => value.labels.operation === 'authoriseSettlement',
    )?.value;
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  try {
    const activities = createActivities({
      orders: {} as OrderService,
      economic: {} as EconomicClient,
    });
    expect(await count()).toBe(0);

    await activities.noteEconomicCallUnconfirmed('ORD', 'authoriseSettlement', 2, 'CONFLICT: busy');

    expect(await count()).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain('authoriseSettlement call of order ORD');
    expect(error.mock.calls[0]?.[0]).toContain('CONFLICT: busy');
  } finally {
    error.mockRestore();
  }
});

it('starts every call behind the wait at zero, not only the first (FU-117)', async () => {
  createActivities({ orders: {} as OrderService, economic: {} as EconomicClient });
  const { values } = await economicCallsUnconfirmedTotal.get();
  const operations = values.map((value) => value.labels.operation);
  expect(operations).toEqual(
    expect.arrayContaining(['authoriseSettlement', 'disputeObligation', 'compensate']),
  );
});

it.each([
  ['an outage', RastaError.upstreamUnavailable('economic-service'), true],
  ['a request in flight', new RastaError('CONFLICT', 'busy'), true],
  ['a business refusal', RastaError.businessRule('no', {}), false],
])('%s is classified as the activity really fails it (FU-103)', async (_name, error, unknown) => {
  const order = {
    id: 'ORD',
    buyerOrganizationId: 'ORG',
    correlationId: 'COR',
    receiptConfirmed: true,
  };
  const activities = createActivities({
    orders: {
      describe: async () => order,
      onceForSaga: (_order: unknown, _step: unknown, _activity: unknown, call: () => unknown) =>
        call(),
    } as unknown as OrderService,
    economic: {
      authoriseSettlement: async () => {
        throw error;
      },
    } as unknown as EconomicClient,
    currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
    currentAttempt: () => 1,
  });
  const cause = await activities.authoriseSettlement('ORD', 'TXN').catch((e: Error) => e);
  const failed = new ActivityFailure(
    'x',
    'authorise',
    '1',
    'TIMEOUT' as never,
    'w',
    cause as Error,
  );
  expect(outcomeUnknown(failed, false)).toBe(unknown);
});

describe('what a failure says of where it came from (#770 r1 F2)', () => {
  const refuse = (code: string): Error => new RastaError(code as never, 'answered');
  const order = {
    id: 'ORD',
    buyerOrganizationId: 'ORG',
    correlationId: 'COR',
    receiptConfirmed: true,
    totalAmountMinor: '1000',
  };
  afterEach(() => {
    order.receiptConfirmed = true;
  });
  function over(
    send: () => unknown,
    read: () => unknown,
    currentAttempt?: () => number,
  ): { activities: ReturnType<typeof createActivities>; reads: () => number } {
    let reads = 0;
    const failing = async () => send();
    const activities = createActivities({
      orders: {
        describe: async () => order,
        onceForSaga: (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => call(),
      } as unknown as OrderService,
      economic: {
        createObligation: failing,
        authoriseSettlement: failing,
        refund: failing,
        settle: failing,
        dispute: failing,
        readObligation: async () => {
          reads += 1;
          return read();
        },
      } as unknown as EconomicClient,
      currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
      ...(currentAttempt ? { currentAttempt } : {}),
    });
    return { activities, reads: () => reads };
  }
  const failure = (attempted: Promise<unknown>): Promise<ApplicationFailure> =>
    attempted.then(
      () => {
        throw new Error('expected to fail');
      },
      (error: ApplicationFailure) => error,
    );
  const refused = () => {
    throw refuse('FORBIDDEN');
  };
  const obligation = (status: string) => () => ({ status });

  it('the first attempt: marked, not read, and not retried even when its code would be', async () => {
    const forbidden = over(refused, obligation('PENDING_SETTLEMENT'), () => 1);
    const caught = await failure(forbidden.activities.authoriseSettlement('ORD', 'TXN'));
    expect(caught).toMatchObject({ type: 'FORBIDDEN', nonRetryable: true });
    expect(caught.details).toEqual([REFUSED_ON_FIRST_ATTEMPT]);
    expect(forbidden.reads()).toBe(0);

    const state = over(
      () => {
        throw refuse('INVALID_STATE_TRANSITION');
      },
      obligation('DISPUTED'),
      () => 1,
    );
    const inState = await failure(state.activities.authoriseSettlement('ORD', 'TXN'));
    expect(inState).toMatchObject({ type: 'INVALID_STATE_TRANSITION', nonRetryable: true });
    expect(inState.details).toEqual([REFUSED_ON_FIRST_ATTEMPT]);
  });

  it('an unlisted code on the first attempt keeps its own retry class, unmarked', async () => {
    const { activities } = over(
      () => {
        throw refuse('CONFLICT');
      },
      obligation('HELD'),
      () => 1,
    );
    const caught = await failure(activities.authoriseSettlement('ORD', 'TXN'));
    expect(caught).toMatchObject({ type: 'CONFLICT', nonRetryable: false });
    expect(caught.details ?? []).toEqual([]);
  });

  it.each([
    ['a retry', () => 2, false],
    ['a round the workflow says is in doubt', () => 1, true],
    ['an attempt nobody can name', undefined, false],
  ])('%s: asks the obligation, and its effect is the answer', async (_name, attempt, inDoubt) => {
    const { activities, reads } = over(refused, obligation('PENDING_SETTLEMENT'), attempt);
    await expect(activities.authoriseSettlement('ORD', 'TXN', inDoubt)).resolves.toBeUndefined();
    expect(reads()).toBe(1);
  });

  it.each(['HELD', 'DISPUTED', 'CREATED'])(
    'in doubt, %s can still move: the code comes through unmarked',
    async (status) => {
      const { activities } = over(refused, obligation(status), () => 2);
      const caught = await failure(activities.authoriseSettlement('ORD', 'TXN'));
      expect(caught.type).toBe('FORBIDDEN');
      expect(caught.details ?? []).toEqual([]);
    },
  );

  it('in doubt, a transaction that is not this order’s proves nothing', async () => {
    const { activities } = over(
      refused,
      () => null,
      () => 2,
    );
    const caught = await failure(activities.authoriseSettlement('ORD', 'TXN'));
    expect(caught.details ?? []).toEqual([]);
  });

  it.each(['REFUNDED', 'CANCELLED', 'FAILED'])(
    'in doubt, %s is terminal without the effect: the owner’s proof',
    async (status) => {
      const { activities } = over(refused, obligation(status), () => 2);
      const caught = await failure(activities.authoriseSettlement('ORD', 'TXN'));
      expect(caught).toMatchObject({ type: 'OBLIGATION_ALREADY_FINAL', nonRetryable: true });
      expect(caught.details).toEqual([OWNER_STATE_IS_FINAL]);
    },
  );

  it('a first attempt’s state refusal with a terminal obligation stays the send’s, not the owner’s', async () => {
    const { activities } = over(
      () => {
        throw refuse('INVALID_STATE_TRANSITION');
      },
      obligation('REFUNDED'),
      () => 1,
    );
    const caught = await failure(activities.authoriseSettlement('ORD', 'TXN'));
    expect(caught.details).toEqual([REFUSED_ON_FIRST_ATTEMPT]);
  });

  it.each([
    ['refused', () => refused()],
    [
      'unreachable',
      () => {
        throw RastaError.upstreamUnavailable('economic-service');
      },
    ],
  ])('the reconciliation read %s: a read failure, whatever it got', async (_name, read) => {
    const { activities } = over(
      () => {
        throw refuse('INVALID_STATE_TRANSITION');
      },
      read,
      () => 1,
    );
    const caught = await failure(activities.authoriseSettlement('ORD', 'TXN'));
    expect(caught).toMatchObject({ type: 'RECONCILIATION_READ_FAILED', nonRetryable: false });
    expect(caught.details ?? []).toEqual([]);
  });

  it.each([
    ['a retry', () => 2, false],
    ['a round in doubt', () => 1, true],
    ['an attempt nobody can name', undefined, false],
  ])(
    'no receipt, on %s: the obligation is not asked, and PENDING_SETTLEMENT cannot read as authorised',
    async (_name, attempt, inDoubt) => {
      order.receiptConfirmed = false;
      const sends = jest.fn();
      const { activities, reads } = over(sends, obligation('PENDING_SETTLEMENT'), attempt);
      const caught = await failure(activities.authoriseSettlement('ORD', 'TXN', inDoubt));
      expect(caught.type).toBe('BUSINESS_RULE_VIOLATION');
      expect(caught.details ?? []).toEqual([]);
      expect(reads()).toBe(0);
      expect(sends).not.toHaveBeenCalled();
    },
  );

  it('no receipt, on the first attempt: the guard’s refusal is the proof, with nothing sent', async () => {
    order.receiptConfirmed = false;
    const sends = jest.fn();
    const { activities, reads } = over(sends, obligation('PENDING_SETTLEMENT'), () => 1);
    const caught = await failure(activities.authoriseSettlement('ORD', 'TXN'));
    expect(caught).toMatchObject({ type: 'BUSINESS_RULE_VIOLATION', nonRetryable: true });
    expect(caught.details).toEqual([REFUSED_ON_FIRST_ATTEMPT]);
    expect(reads()).toBe(0);
    expect(sends).not.toHaveBeenCalled();
  });

  it('a step not behind the wait keeps its refusal unmarked, and its read failure is a read', async () => {
    const stateRefused = () => {
      throw refuse('INVALID_STATE_TRANSITION');
    };
    const held = over(stateRefused, obligation('HELD'), () => 2);
    const caught = await failure(held.activities.settle('ORD', 'TXN'));
    expect(caught.type).toBe('INVALID_STATE_TRANSITION');
    expect(caught.details ?? []).toEqual([]);

    const unread = over(stateRefused, refused, () => 1);
    expect(await failure(unread.activities.settle('ORD', 'TXN'))).toMatchObject({
      type: 'RECONCILIATION_READ_FAILED',
    });
  });

  describe.each([
    [
      'compensate',
      (a: ReturnType<typeof createActivities>, inDoubt?: boolean) =>
        a.compensate('ORD', 'TXN', 'why', inDoubt),
      { status: 'REFUNDED' },
      ['SETTLED', 'CANCELLED', 'FAILED'],
    ],
    [
      'disputeObligation',
      (a: ReturnType<typeof createActivities>, inDoubt?: boolean) =>
        a.disputeObligation('ORD', 'TXN', 'DSP', 'why', inDoubt),
      { status: 'DISPUTED', disputeReason: 'why', disputeId: 'E' },
      ['SETTLED', 'REFUNDED', 'CANCELLED', 'FAILED'],
    ],
  ] as const)('%s behind the wait (FU-117)', (_name, call, effect, finals) => {
    it('its first attempt is proof, unread', async () => {
      const first = over(refused, obligation('HELD'), () => 1);
      const caught = await failure(call(first.activities));
      expect(caught.type).toBe('FORBIDDEN');
      expect(caught.details).toEqual([REFUSED_ON_FIRST_ATTEMPT]);
      expect(first.reads()).toBe(0);
    });

    it.each([
      ['a later attempt', undefined, 2],
      ['the workflow’s word', true, 1],
    ] as const)('in doubt by %s: unmarked, and asks the owner', async (_how, inDoubt, attempt) => {
      const later = over(refused, obligation('HELD'), () => attempt);
      const caught = await failure(call(later.activities, inDoubt));
      expect(caught.type).toBe('FORBIDDEN');
      expect(caught.details ?? []).toEqual([]);
      expect(later.reads()).toBe(1);
    });

    it('in doubt, its effect is the answer', async () => {
      const { activities } = over(
        refused,
        () => effect,
        () => 2,
      );
      await expect(call(activities)).resolves.not.toThrow();
    });

    it.each(finals)('in doubt, %s is final: no late request can move it', async (status) => {
      const { activities } = over(refused, obligation(status), () => 2);
      const caught = await failure(call(activities));
      expect(caught.type).toBe('OBLIGATION_ALREADY_FINAL');
      expect(caught.details).toEqual([OWNER_STATE_IS_FINAL]);
    });

    // DISPUTED: no words of this filing's on it, and neither call's final state.
    it.each(['HELD', 'PENDING_SETTLEMENT', 'CREATED', 'DISPUTED'])(
      'in doubt, %s proves nothing',
      async (status) => {
        const { activities } = over(refused, obligation(status), () => 2);
        expect((await failure(call(activities))).details ?? []).toEqual([]);
      },
    );

    it('in doubt, a failed read is a read', async () => {
      const { activities } = over(refused, refused, () => 2);
      expect(await failure(call(activities))).toMatchObject({
        type: 'RECONCILIATION_READ_FAILED',
      });
    });
  });

  describe('createObligation behind the wait (FU-117)', () => {
    const noTransaction = () => null;
    const refuses = (code: string) => () => {
      throw refuse(code);
    };

    it('the send’s own listed refusal on its first attempt is proof', async () => {
      const { activities } = over(refuses('INSUFFICIENT_BALANCE'), noTransaction, () => 1);
      const caught = await failure(activities.createObligation('ORD'));
      expect(caught.type).toBe('INSUFFICIENT_BALANCE');
      expect(caught.details).toEqual([REFUSED_ON_FIRST_ATTEMPT]);
    });

    it.each([
      ['a later attempt', 'INSUFFICIENT_BALANCE', 2],
      ['an unlisted code', 'IDEMPOTENCY_KEY_REUSED', 1],
      ['a key in flight', 'CONFLICT', 1],
      ['a source already taken', 'ALREADY_EXISTS', 1],
    ] as const)('%s is no proof', async (_name, code, attempt) => {
      const { activities } = over(refuses(code), noTransaction, () => attempt);
      const caught = await failure(activities.createObligation('ORD'));
      expect(caught.type).toBe(code);
      expect(caught.details ?? []).toEqual([]);
    });

    it('no attempt known: no proof', async () => {
      const { activities } = over(refuses('INSUFFICIENT_BALANCE'), noTransaction);
      expect((await failure(activities.createObligation('ORD'))).details ?? []).toEqual([]);
    });
  });
});
