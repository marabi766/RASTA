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
import { OrderStatus } from '../generated/prisma';

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
      whileOrderHeld: (_id: string, fn: (row: unknown) => unknown) =>
        fn({ status: 'RECEIPT_CONFIRMED', receiptConfirmed: true }),
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
    status: 'RECEIPT_CONFIRMED',
    buyerOrganizationId: 'ORG',
    correlationId: 'COR',
    receiptConfirmed: true,
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
        whileOrderHeld: (_id: string, fn: (row: unknown) => unknown) => fn(order),
      } as unknown as OrderService,
      economic: {
        authoriseSettlement: failing,
        refund: failing,
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
    const caught = await failure(held.activities.compensate('ORD', 'TXN', 'why'));
    expect(caught.type).toBe('INVALID_STATE_TRANSITION');
    expect(caught.details ?? []).toEqual([]);

    const unread = over(stateRefused, refused, () => 1);
    expect(await failure(unread.activities.compensate('ORD', 'TXN', 'why'))).toMatchObject({
      type: 'RECONCILIATION_READ_FAILED',
    });
  });
});

/**
 * FU-178, D-138: whether an authorisation goes out is decided on the row as the
 * hold reads it, for every status there is, on every attempt. The order the
 * activity read first is what it knew before the hold, and proves nothing.
 */
describe('no authorisation past the order as it stands (FU-178)', () => {
  const ALL_STATUSES = Object.values(OrderStatus);
  const AUTHORISABLE = ['RECEIPT_CONFIRMED', 'SETTLING'];
  const CLOSED = ALL_STATUSES.filter((status) => !AUTHORISABLE.includes(status));

  function over(
    row: { status: string; receiptConfirmed?: boolean },
    options: {
      attempt?: number;
      read?: () => unknown;
      send?: () => unknown;
      hold?: (fn: (row: unknown) => unknown) => unknown;
    } = {},
  ) {
    const trace: string[] = [];
    const activities = createActivities({
      orders: {
        // Stale on purpose: nothing may be decided from this read but the receipt.
        describe: async () => ({
          id: 'ORD',
          status: 'RECEIPT_CONFIRMED',
          buyerOrganizationId: 'ORG',
          correlationId: 'COR',
          receiptConfirmed: true,
        }),
        onceForSaga: (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => call(),
        whileOrderHeld: async (_id: string, fn: (held: unknown) => unknown) => {
          trace.push('hold');
          try {
            const held = () => fn({ receiptConfirmed: true, ...row });
            return await (options.hold ? options.hold(held) : held());
          } finally {
            trace.push('release');
          }
        },
      } as unknown as OrderService,
      economic: {
        authoriseSettlement: async () => {
          trace.push('send');
          return options.send?.();
        },
        readObligation: async () => {
          trace.push('read');
          return (options.read ?? (() => ({ status: 'HELD' })))();
        },
      } as unknown as EconomicClient,
      currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
      currentAttempt: () => options.attempt ?? 1,
    });
    return { activities, trace };
  }

  it('covers every status of the schema, so a new one is fenced until it is named', () => {
    expect(ALL_STATUSES.length).toBe(CLOSED.length + AUTHORISABLE.length);
    expect(CLOSED).toEqual(expect.arrayContaining(['DISPUTED', 'CANCELLING', 'PENDING']));
  });

  it.each(CLOSED)('%s on a first attempt: nothing is sent or read', async (status) => {
    const { activities, trace } = over({ status });
    await expect(activities.authoriseSettlement('ORD', 'TXN')).resolves.toEqual({
      fenced: true,
      status,
      inDoubt: false,
    });
    expect(trace).toEqual(['hold', 'release']);
  });

  it.each(AUTHORISABLE)('%s: sent, and only from inside the hold', async (status) => {
    const { activities, trace } = over({ status });
    await expect(activities.authoriseSettlement('ORD', 'TXN')).resolves.toBeUndefined();
    expect(trace).toEqual(['hold', 'send', 'release']);
  });

  it.each([
    ['a retry', 2, false],
    ['a later round', 1, true],
  ])(
    '%s, the row disputed: the obligation answers, and nothing is sent',
    async (_n, attempt, doubt) => {
      const ours = over(
        { status: 'DISPUTED' },
        { attempt, read: () => ({ status: 'PENDING_SETTLEMENT' }) },
      );
      await expect(
        ours.activities.authoriseSettlement('ORD', 'TXN', doubt),
      ).resolves.toBeUndefined();
      expect(ours.trace).toEqual(['read']);

      const noEffect = over({ status: 'DISPUTED' }, { attempt });
      await expect(noEffect.activities.authoriseSettlement('ORD', 'TXN', doubt)).resolves.toEqual({
        fenced: true,
        status: 'DISPUTED',
        inDoubt: true,
      });
      expect(noEffect.trace).toEqual(['read', 'hold', 'release']);
    },
  );

  it('in doubt with the row disputed, a failed read is a read failure: nothing is sent', async () => {
    const { activities, trace } = over(
      { status: 'DISPUTED' },
      {
        attempt: 2,
        read: () => {
          throw RastaError.upstreamUnavailable('economic-service');
        },
      },
    );
    await expect(activities.authoriseSettlement('ORD', 'TXN')).rejects.toMatchObject({
      type: 'RECONCILIATION_READ_FAILED',
      nonRetryable: false,
    });
    expect(trace).toEqual(['read']);
  });

  it('in doubt with the row eligible: the effect answers, and no second send goes out', async () => {
    const { activities, trace } = over(
      { status: 'RECEIPT_CONFIRMED' },
      { attempt: 2, read: () => ({ status: 'PENDING_SETTLEMENT' }) },
    );
    await expect(activities.authoriseSettlement('ORD', 'TXN')).resolves.toBeUndefined();
    expect(trace).toEqual(['read']);
  });

  it('in doubt with no effect and the row eligible: the same call, under the hold, after the read', async () => {
    const { activities, trace } = over({ status: 'RECEIPT_CONFIRMED' }, { attempt: 2 });
    await expect(activities.authoriseSettlement('ORD', 'TXN')).resolves.toBeUndefined();
    expect(trace).toEqual(['read', 'hold', 'send', 'release']);
  });

  it('a failed send is reconciled with the lock released', async () => {
    const { activities, trace } = over(
      { status: 'RECEIPT_CONFIRMED' },
      {
        send: () => {
          throw new RastaError('INVALID_STATE_TRANSITION' as never, 'answered');
        },
        read: () => ({ status: 'PENDING_SETTLEMENT' }),
      },
    );
    await expect(activities.authoriseSettlement('ORD', 'TXN')).resolves.toBeUndefined();
    expect(trace).toEqual(['hold', 'send', 'release', 'read']);
  });

  it('the hold itself failing sends nothing, and the attempt is retried', async () => {
    const { activities, trace } = over(
      { status: 'RECEIPT_CONFIRMED' },
      {
        hold: () => {
          throw new Error('lock_not_available');
        },
      },
    );
    const caught = await activities.authoriseSettlement('ORD', 'TXN').catch((e: Error) => e);
    expect((caught as Error).message).toBe('lock_not_available');
    expect(caught).not.toMatchObject({ nonRetryable: true });
    expect(trace).toEqual(['hold', 'release']);
  });

  it('no receipt on the row under the hold: refused with nothing sent, whatever was read first', async () => {
    const { activities, trace } = over({ status: 'RECEIPT_CONFIRMED', receiptConfirmed: false });
    await expect(activities.authoriseSettlement('ORD', 'TXN')).rejects.toMatchObject({
      type: 'BUSINESS_RULE_VIOLATION',
      nonRetryable: true,
      details: [REFUSED_ON_FIRST_ATTEMPT],
    });
    expect(trace).toEqual(['hold', 'release']);
  });

  it('another economic step is not held', async () => {
    const held = jest.fn();
    const economic = createActivities({
      orders: {
        describe: async () => ({ id: 'ORD', buyerOrganizationId: 'ORG', correlationId: 'COR' }),
        onceForSaga: (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => call(),
        whileOrderHeld: held,
      } as unknown as OrderService,
      economic: { refund: async () => undefined } as unknown as EconomicClient,
      currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
      currentAttempt: () => 1,
    });
    await expect(economic.compensate('ORD', 'TXN', 'why')).resolves.toBeUndefined();
    expect(held).not.toHaveBeenCalled();
  });
});
