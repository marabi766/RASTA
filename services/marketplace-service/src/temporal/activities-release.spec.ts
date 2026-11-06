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

/**
 * The durable record (FU-104): on before the call, off only once it is confirmed.
 * The order of the calls is the point, so one log records them all.
 */
describe('resolveObligationDispute on record', () => {
  const STEP = { key: 'k', scheduledAt: new Date('2026-11-06T00:00:00.000Z') };
  function build(options: { resolveDispute: () => Promise<unknown>; recorded?: boolean }) {
    const log: string[] = [];
    const orders = {
      describe: async () => ({
        id: 'ORD_R',
        buyerOrganizationId: 'ORG_B',
        correlationId: 'COR',
      }),
      onceForSaga: async (_o: unknown, _s: unknown, _a: unknown, call: () => Promise<unknown>) =>
        options.recorded ? (log.push('answered from the record'), undefined) : call(),
      openSagaCall: async (...args: unknown[]) => {
        log.push(`open ${JSON.stringify(args)}`);
        return { generation: 7, started: true };
      },
      confirmSagaCall: async (...args: unknown[]) =>
        void log.push(`confirm ${JSON.stringify(args)}`),
    };
    const economic = {
      resolveDispute: async () => {
        log.push('call');
        return options.resolveDispute();
      },
      readObligation: async () => null,
      dispute: async () => {
        log.push('tell');
        return { disputeId: 'ECO' };
      },
    };
    const activities = createActivities({
      orders: orders as unknown as OrderService,
      economic: economic as unknown as EconomicClient,
      currentStep: () => STEP,
    });
    const release = () => activities.resolveObligationDispute('ORD_R', 'TX', 'DSP', 'SETTLE');
    return { log, release, activities };
  }
  const call = [{ id: 'ORD_R', organizationId: 'ORG_B' }, 'resolveObligationDispute', 'DSP'];
  // By the scheduled command that runs (#836 r1 R1).
  const args = JSON.stringify([...call, STEP]);
  // With the command and the generation its own opening was given.
  const confirmArgs = JSON.stringify([...call, { command: STEP, generation: 7, started: true }]);

  it('opens before the call and confirms after it, under the buying tenant', async () => {
    const { log, release } = build({ resolveDispute: async () => ({}) });

    await release();

    expect(log).toEqual([`open ${args}`, 'call', `confirm ${confirmArgs}`]);
  });

  it('confirms a retry answered from the step record', async () => {
    const { log, release } = build({ resolveDispute: async () => ({}), recorded: true });

    await release();

    expect(log).toEqual([`open ${args}`, 'answered from the record', `confirm ${confirmArgs}`]);
  });

  it('opens when economic-service is told of the dispute, before the telling', async () => {
    const { log, activities } = build({ resolveDispute: async () => ({}) });

    await activities.disputeObligation('ORD_R', 'TX', 'DSP', 'it does not fit');

    expect(log).toEqual([`open ${args}`, 'tell']);
  });

  it('stays open when the call fails', async () => {
    const { log, release } = build({ resolveDispute: () => Promise.reject(new Error('down')) });

    await expect(release()).rejects.toThrow();

    expect(log).toEqual([`open ${args}`, 'call']);
  });
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
      // The durable call record (#836, FU-145): opened before the call, confirmed after it.
      openSagaCall: async () => ({ generation: 1, started: true }),
      confirmSagaCall: async () => undefined,
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
        // The durable call record (#836, FU-145): opened before the call, confirmed after it.
        openSagaCall: async () => ({ generation: 1, started: true }),
        confirmSagaCall: async () => undefined,
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
