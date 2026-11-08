import { Logger } from '@nestjs/common';
import { createActivities } from './activities';
import { economicCallsUnconfirmedTotal, releasesUnconfirmedTotal } from '../observability/metrics';
import { ActivityFailure } from '@temporalio/client';
import { RastaError } from '@rasta/nest-common';
import { ApplicationFailure } from '@temporalio/activity';
import {
  FINAL_ANSWER_CONTRACT,
  OWNER_STATE_IS_FINAL,
  REFUSED_ON_FIRST_ATTEMPT,
  REFUSED_PAST_HOLD_DEADLINE,
} from './economic-refusal';
import { outcomeUnknown } from './workflows';
import type { EconomicClient } from '../economic/economic.client';
import type { OrderService } from '../order/order.service';
import { OrderStatus } from '../generated/prisma';

type Activities = ReturnType<typeof createActivities>;

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

it('starts every call behind the wait at zero, not only the first (FU-117)', async () => {
  createActivities({ orders: {} as OrderService, economic: {} as EconomicClient });
  const { values } = await economicCallsUnconfirmedTotal.get();
  const operations = values.map((value) => value.labels.operation);
  expect(operations).toEqual(
    expect.arrayContaining([
      'readOrder',
      'authoriseSettlement',
      'settle',
      'disputeObligation',
      'compensate',
    ]),
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
      claimHoldSend: async (_o: unknown, proposed?: string) => ({
        holdNotAfter: proposed ?? null,
        claims: 1,
      }),
      closeHoldSendsOnRefusal: async () => true,
      whileOrderHeld: (_id: string, fn: (row: unknown) => unknown) =>
        fn({ status: 'RECEIPT_CONFIRMED', receiptConfirmed: true }),
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
    status: 'RECEIPT_CONFIRMED',
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
  ): {
    activities: ReturnType<typeof createActivities>;
    reads: () => number;
    answered: unknown[][];
  } {
    let reads = 0;
    const answered: unknown[][] = [];
    const failing = async () => send();
    const activities = createActivities({
      orders: {
        describe: async () => order,
        onceForSaga: (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => call(),
        claimHoldSend: async (_o: unknown, proposed?: string) => ({
          holdNotAfter: proposed ?? null,
          claims: 1,
        }),
        closeHoldSendsOnRefusal: async () => true,
        whileOrderHeld: (_id: string, fn: (row: unknown) => unknown) => fn(order),
        // The durable call record (#836, FU-145): opened before the call, confirmed after it.
        openSagaCall: async () => ({ generation: 1, started: true }),
        confirmSagaCall: async () => undefined,
        confirmSagaCallsOn: async (_o: unknown, operations: unknown, subject: unknown) => {
          answered.push([operations, subject]);
        },
      } as unknown as OrderService,
      economic: {
        // economic-service with the D-150 rule, which the row's proof needs (FU-233).
        requiresOrderHoldDeadline: async () => true,
        createObligation: failing,
        authoriseSettlement: failing,
        refund: failing,
        settle: failing,
        dispute: failing,
        resolveDispute: failing,
        readObligation: async () => {
          reads += 1;
          return read();
        },
      } as unknown as EconomicClient,
      currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
      ...(currentAttempt ? { currentAttempt } : {}),
    });
    return { activities, reads: () => reads, answered };
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
    'in doubt, %s is terminal without the effect: the owner’s answer',
    async (status) => {
      const { activities } = over(refused, obligation(status), () => 2);
      await expect(
        activities.authoriseSettlement('ORD', 'TXN', false, FINAL_ANSWER_CONTRACT),
      ).resolves.toMatchObject({ final: true, status });
    },
  );

  // Review of #796 r1, F3: the marked refusal ended the saga, and the owner's status
  // is what decides what the order can do, on the first attempt as on any other.
  it('a first attempt refused for its state, the obligation terminal: the owner’s answer', async () => {
    const { activities } = over(
      () => {
        throw refuse('INVALID_STATE_TRANSITION');
      },
      obligation('REFUNDED'),
      () => 1,
    );
    await expect(
      activities.authoriseSettlement('ORD', 'TXN', false, FINAL_ANSWER_CONTRACT),
    ).resolves.toEqual({ final: true, status: 'REFUNDED', funds: 'RETURNED' });
  });

  it.each([
    ['SETTLED', 'PAID_OUT'],
    ['REVERSED', 'UNPROVEN'],
    ['REFUNDED', 'RETURNED'],
    ['CANCELLED', 'NEVER_HELD'],
    ['FAILED', 'NEVER_HELD'],
  ])(
    'a release refused with the obligation %s has nothing left to release',
    async (status, funds) => {
      const { activities } = over(() => {
        throw refuse('INVALID_STATE_TRANSITION');
      }, obligation(status));
      await expect(
        activities.resolveObligationDispute(
          'ORD',
          'TXN',
          'DSP',
          'decided',
          'ECON',
          FINAL_ANSWER_CONTRACT,
        ),
      ).resolves.toEqual({ final: true, status, funds });
    },
  );

  it.each(['HELD', 'DISPUTED', 'PENDING_SETTLEMENT'])(
    'a release refused with the obligation %s stays refused',
    async (status) => {
      const { activities } = over(() => {
        throw refuse('INVALID_STATE_TRANSITION');
      }, obligation(status));
      const caught = await failure(
        activities.resolveObligationDispute(
          'ORD',
          'TXN',
          'DSP',
          'decided',
          'ECON',
          FINAL_ANSWER_CONTRACT,
        ),
      );
      expect(caught.type).toBe('INVALID_STATE_TRANSITION');
    },
  );

  it.each(['PARTIALLY_REVERSED', 'REVERSED'])(
    'a refund refused with the obligation %s is told so: no refund can land past a settlement',
    async (status) => {
      const { activities } = over(
        () => {
          throw refuse('INVALID_STATE_TRANSITION');
        },
        obligation(status),
        () => 1,
      );
      await expect(
        activities.compensate('ORD', 'TXN', 'why', false, FINAL_ANSWER_CONTRACT),
      ).resolves.toEqual({ final: true, status, funds: 'UNPROVEN' });
    },
  );

  it('a first attempt refused otherwise reads nothing, and stays its own proof', async () => {
    const { activities, reads } = over(refused, obligation('REFUNDED'), () => 1);
    const caught = await failure(activities.authoriseSettlement('ORD', 'TXN'));
    expect(caught.details).toEqual([REFUSED_ON_FIRST_ATTEMPT]);
    expect(reads()).toBe(0);
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

  // A pin for the late hold's refund (`watchForLateHold`): the order has ended, and no
  // status guard may be added here, as nothing else would ever refund it.
  it.each(['FAILED', 'CANCELLED'])('a refund goes out for an order already %s', async (status) => {
    const closed = order as unknown as { status: string };
    const was = closed.status;
    closed.status = status;
    try {
      const send = jest.fn();
      const { activities } = over(send, obligation('HELD'), () => 1);
      await expect(
        activities.compensate('ORD', 'TXN', 'why', true, FINAL_ANSWER_CONTRACT),
      ).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      closed.status = was;
    }
  });

  // Review of #796 r2, F5: an older workflow reads any answer as the call's own effect,
  // and a paid-out order would be cancelled under it. What did not declare the contract
  // keeps the refusal; a contract it cannot name is not a declaration.
  describe.each([
    [
      'compensate',
      (a: Activities, contract?: string) =>
        a.compensate('ORD', 'TXN', 'why', true, contract as string),
    ],
    [
      'disputeObligation',
      (a: Activities, contract?: string) =>
        a.disputeObligation('ORD', 'TXN', 'DSP', 'why', true, contract as string),
    ],
    [
      'resolveObligationDispute',
      (a: Activities, contract?: string) =>
        a.resolveObligationDispute('ORD', 'TXN', 'DSP', 'decided', 'ECON', contract as string),
    ],
  ] as const)('%s for a caller below the contract', (_name, call) => {
    const stateRefused = () => {
      throw refuse('INVALID_STATE_TRANSITION');
    };

    describe.each([
      ['undeclared', undefined],
      ['an unknown contract', 'obligation-final-v0'],
    ])('%s', (_how, contract) => {
      it.each(['SETTLED', 'PARTIALLY_REVERSED', 'REVERSED', 'CANCELLED', 'FAILED'])(
        '%s stays the refusal it was, unmarked',
        async (status) => {
          const { activities } = over(stateRefused, obligation(status), () => 2);
          const caught = await failure(call(activities, contract));
          expect(caught.type).toBe('INVALID_STATE_TRANSITION');
          expect(caught.details ?? []).toEqual([]);
        },
      );
    });

    it('declared, the same obligation is the answer', async () => {
      const { activities } = over(stateRefused, obligation('SETTLED'), () => 2);
      await expect(call(activities, FINAL_ANSWER_CONTRACT)).resolves.toEqual({
        final: true,
        status: 'SETTLED',
        funds: 'PAID_OUT',
      });
    });
  });

  it.each([
    ['undeclared', undefined],
    ['an unknown contract', 'obligation-final-v0'],
  ])(
    'authoriseSettlement %s, in doubt: the failure it can read, not an answer',
    async (_how, c) => {
      for (const status of ['REFUNDED', 'CANCELLED', 'FAILED']) {
        const { activities } = over(refused, obligation(status), () => 2);
        const caught = await failure(
          activities.authoriseSettlement('ORD', 'TXN', true, c as string),
        );
        expect(caught.type).toBe('OBLIGATION_ALREADY_FINAL');
        expect(caught.nonRetryable).toBe(true);
        expect(caught.details).toEqual([OWNER_STATE_IS_FINAL]);
      }
      for (const status of ['PARTIALLY_REVERSED', 'REVERSED']) {
        const { activities } = over(refused, obligation(status), () => 2);
        expect(
          (await failure(activities.authoriseSettlement('ORD', 'TXN', true, c as string))).type,
        ).toBe('FORBIDDEN');
      }
    },
  );

  it('authoriseSettlement undeclared on a first attempt keeps its own mark, as before', async () => {
    const { activities, reads } = over(refused, obligation('REFUNDED'), () => 1);
    const caught = await failure(activities.authoriseSettlement('ORD', 'TXN'));
    expect(caught.type).toBe('FORBIDDEN');
    expect(caught.details).toEqual([REFUSED_ON_FIRST_ATTEMPT]);
    expect(reads()).toBe(0);
  });

  it.each([
    ['compensate', (a: Activities) => a.compensate('ORD', 'TXN', 'why')],
    ['disputeObligation', (a: Activities) => a.disputeObligation('ORD', 'TXN', 'DSP', 'why')],
  ] as const)(
    '%s undeclared is not behind the wait: no mark, and only a state refusal asks',
    async (_name, call) => {
      const { activities, reads } = over(refused, obligation('HELD'), () => 2);
      const caught = await failure(call(activities));
      expect(caught.type).toBe('FORBIDDEN');
      expect(caught.details ?? []).toEqual([]);
      expect(reads()).toBe(0);
    },
  );

  describe.each([
    [
      'compensate',
      (a: ReturnType<typeof createActivities>, inDoubt?: boolean) =>
        a.compensate('ORD', 'TXN', 'why', inDoubt, FINAL_ANSWER_CONTRACT),
      { status: 'REFUNDED' },
      ['SETTLED', 'CANCELLED', 'FAILED'],
    ],
    [
      'disputeObligation',
      (a: ReturnType<typeof createActivities>, inDoubt?: boolean) =>
        a.disputeObligation('ORD', 'TXN', 'DSP', 'why', inDoubt, FINAL_ANSWER_CONTRACT),
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

    it.each(finals)('in doubt, %s is final: the answer says so', async (status) => {
      const { activities } = over(refused, obligation(status), () => 2);
      await expect(call(activities)).resolves.toMatchObject({ final: true, status });
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

  // #836 sync with #796: only REFUNDED proves no authorisation or settlement of the
  // obligation can land; another final status answers the refund, not those calls.
  it('a refund answers the open authorisation and settlement records only once REFUNDED', async () => {
    const refunded = over(refused, obligation('REFUNDED'), () => 2);
    await refunded.activities.compensate('ORD', 'TXN', 'why', true, FINAL_ANSWER_CONTRACT);
    expect(refunded.answered).toEqual([[['authoriseSettlement', 'settle'], 'TXN']]);
    for (const status of ['SETTLED', 'CANCELLED', 'FAILED']) {
      const final = over(refused, obligation(status), () => 2);
      await expect(
        final.activities.compensate('ORD', 'TXN', 'why', true, FINAL_ANSWER_CONTRACT),
      ).resolves.toMatchObject({ final: true, status });
      expect(final.answered).toEqual([]);
    }
  });

  describe('createObligation behind the wait (FU-117)', () => {
    const DEADLINE = '2026-11-08T00:00:00.000Z';
    const noTransaction = () => null;
    const refuses = (code: string) => () => {
      throw refuse(code);
    };

    it('the send’s own listed refusal on its first attempt is proof', async () => {
      const { activities } = over(refuses('INSUFFICIENT_BALANCE'), noTransaction, () => 1);
      const caught = await failure(activities.createObligation('ORD', DEADLINE));
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
      const caught = await failure(activities.createObligation('ORD', DEADLINE));
      expect(caught.type).toBe(code);
      expect(caught.details ?? []).toEqual([]);
    });

    it.each(['FAILED', 'CANCELLED'])(
      'an attempt running on past a saga that closed the order %s sends nothing, and proves nothing',
      async (status) => {
        const closed = order as unknown as { status?: string };
        closed.status = status;
        try {
          const send = jest.fn();
          const { activities } = over(send, noTransaction, () => 1);
          const caught = await failure(activities.createObligation('ORD'));
          expect(caught.type).toBe('ORDER_ALREADY_CLOSED');
          expect(caught.details ?? []).toEqual([]);
          expect(send).not.toHaveBeenCalled();
        } finally {
          delete closed.status;
        }
      },
    );

    it.each(['PENDING', 'CANCELLING'])(
      'at %s the send still goes: it is the fence',
      async (status) => {
        const closed = order as unknown as { status?: string };
        closed.status = status;
        try {
          const send = jest.fn(() => ({ id: 'TXN' }));
          const { activities } = over(
            send,
            () => ({ status: 'HELD', heldProven: true }),
            () => 1,
          );
          await expect(activities.createObligation('ORD')).resolves.toEqual({
            transactionId: 'TXN',
          });
          expect(send).toHaveBeenCalledTimes(1);
        } finally {
          delete closed.status;
        }
      },
    );

    it('no attempt known: no proof', async () => {
      const { activities } = over(refuses('INSUFFICIENT_BALANCE'), noTransaction);
      expect((await failure(activities.createObligation('ORD', DEADLINE))).details ?? []).toEqual(
        [],
      );
    });
  });
});

/**
 * Review of #812 F1, executed: `describe()` before the awaited `onceForSaga()` lookup, the
 * order closed in between, printed `sent: 1` for both FAILED and CANCELLED.
 */
describe('every guard of an economic step reads the order after the step looked', () => {
  const refuse = (code: string): Error => new RastaError(code as never, 'answered');
  function racing(row: Record<string, unknown>, read: () => Promise<unknown> = async () => row) {
    let resume: () => void = () => undefined;
    const lookup = new Promise<void>((resolve) => (resume = resolve));
    let entered: () => void = () => undefined;
    const looking = new Promise<void>((resolve) => (entered = resolve));
    const sent: unknown[] = [];
    let reads = 0;
    const send = async (input: unknown) => {
      sent.push(input);
      return { id: 'TXN' };
    };
    const activities = createActivities({
      orders: {
        describe: async () => {
          reads += 1;
          return { ...((reads === 1 ? row : await read()) as object) };
        },
        onceForSaga: async (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => {
          entered();
          await lookup;
          return call();
        },
        claimHoldSend: async (_o: unknown, proposed?: string) => ({
          holdNotAfter: proposed ?? null,
          claims: 1,
        }),
        closeHoldSendsOnRefusal: async () => true,
        // The durable call record (#836, FU-145): opened before the send, confirmed after it.
        openSagaCall: async () => ({ generation: 1, started: true }),
        confirmSagaCall: async () => undefined,
        // The row as it stands when the send would go, under the order's lock (D-138).
        whileOrderHeld: (_id: string, fn: (held: unknown) => unknown) => fn({ ...row }),
      } as unknown as OrderService,
      economic: {
        // economic-service with the D-150 rule, which the row's proof needs (FU-233).
        requiresOrderHoldDeadline: async () => true,
        createObligation: send,
        authoriseSettlement: send,
        readObligation: async () => ({ status: 'HELD', heldProven: true }),
      } as unknown as EconomicClient,
      currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
      currentAttempt: () => 1,
    });
    return { activities, looking, resume, sent };
  }
  const pending = () => ({
    id: 'ORD',
    status: 'PENDING',
    buyerOrganizationId: 'ORG',
    supplierOrganizationId: 'SUP',
    correlationId: 'COR',
    receiptConfirmed: true,
    totalAmountMinor: '1000',
    economicTransactionId: null as string | null,
  });

  it.each(['FAILED', 'CANCELLED'])(
    'createObligation: the order closed %s during the lookup sends nothing',
    async (closed) => {
      const row = pending();
      const { activities, looking, resume, sent } = racing(row);
      const attempt = activities.createObligation('ORD', '2026-11-07T00:00:00.000Z');
      await looking;
      row.status = closed;
      resume();
      await expect(attempt).rejects.toMatchObject({ type: 'ORDER_ALREADY_CLOSED', details: [] });
      expect(sent).toEqual([]);
    },
  );

  it('createObligation: a hold recorded during the lookup is that hold, not a second send', async () => {
    const row = pending();
    const { activities, looking, resume, sent } = racing(row);
    const attempt = activities.createObligation('ORD');
    await looking;
    row.economicTransactionId = 'TXN_KNOWN';
    resume();
    await expect(attempt).resolves.toEqual({ transactionId: 'TXN_KNOWN' });
    expect(sent).toEqual([]);
  });

  it('authoriseSettlement: its fence reads the order as it stands, under the lock', async () => {
    const row = { ...pending(), status: 'RECEIPT_CONFIRMED' };
    const { activities, looking, resume, sent } = racing(row);
    const attempt = activities.authoriseSettlement('ORD', 'TXN');
    await looking;
    row.receiptConfirmed = false;
    resume();
    await expect(attempt).rejects.toMatchObject({ type: 'BUSINESS_RULE_VIOLATION' });
    expect(sent).toEqual([]);
  });

  it('a read that fails after the lookup is no refusal of the call: not marked, nothing sent', async () => {
    const { activities, resume, sent } = racing(pending(), async () => {
      throw refuse('NOT_FOUND');
    });
    resume();
    const caught = await activities.createObligation('ORD').then(
      () => {
        throw new Error('expected to fail');
      },
      (error: ApplicationFailure) => error,
    );
    expect(caught.type).toBe('NOT_FOUND');
    expect(caught.details ?? []).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('the deadline of a hold (D-132)', () => {
  const DEADLINE = '2026-11-07T00:00:00.000Z';
  function sending(answer: () => unknown, attempt = 1, rowDeadline?: string) {
    const send = jest.fn(async (_input: { holdNotAfter?: string }) => answer());
    const activities = createActivities({
      orders: {
        describe: async () => ({
          id: 'ORD',
          status: 'PENDING',
          buyerOrganizationId: 'ORG',
          supplierOrganizationId: 'SUP',
          correlationId: 'COR',
          totalAmountMinor: '1000',
          economicTransactionId: null,
        }),
        onceForSaga: (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => call(),
        claimHoldSend: async (_o: unknown, proposed?: string) => ({
          holdNotAfter: rowDeadline ?? proposed ?? null,
          claims: 1,
        }),
        closeHoldSendsOnRefusal: async () => true,
        // The durable call record (#836, FU-145): opened before the send, confirmed after it.
        openSagaCall: async () => ({ generation: 1, started: true }),
        confirmSagaCall: async () => undefined,
      } as unknown as OrderService,
      economic: {
        // economic-service with the D-150 rule, which the row's proof needs (FU-233).
        requiresOrderHoldDeadline: async () => true,
        createObligation: send,
        readObligation: async () => ({ status: 'HELD', heldProven: true }),
      } as unknown as EconomicClient,
      currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
      currentAttempt: () => attempt,
    });
    return { activities, send };
  }
  const past = () => {
    throw new RastaError('HOLD_DEADLINE_PASSED', 'past it');
  };

  it('goes to economic-service as the workflow fixed it', async () => {
    const { activities, send } = sending(() => ({ id: 'TXN' }));
    await activities.createObligation('ORD', DEADLINE);
    expect(send.mock.calls[0]?.[0].holdNotAfter).toBe(DEADLINE);
  });

  it('a workflow from before the fence sends none', async () => {
    const { activities, send } = sending(() => ({ id: 'TXN' }));
    await activities.createObligation('ORD');
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('holdNotAfter');
  });

  it.each([1, 2, 3])('its refusal is marked on attempt %d, and not retried', async (attempt) => {
    const { activities } = sending(past, attempt);
    await expect(activities.createObligation('ORD', DEADLINE)).rejects.toMatchObject({
      type: 'HOLD_DEADLINE_PASSED',
      nonRetryable: true,
      details: [REFUSED_PAST_HOLD_DEADLINE],
    });
  });

  // FU-234: the row's deadline can be later than the one the workflow proposed (a legacy
  // row's backfilled one, or an earlier run's), and the workflow judges by its own.
  it.each([
    ['not yet past the row’s deadline and margin: unmarked', -30 * 60_000, []],
    ['past the row’s deadline and margin: marked', 30 * 60_000, [REFUSED_PAST_HOLD_DEADLINE]],
  ])('a refusal to the row’s later deadline, %s', async (_name, pastBy, details) => {
    const row = new Date(Date.now() - pastBy - 3_600_000).toISOString();
    const { activities, send } = sending(past, 1, row);
    await expect(activities.createObligation('ORD', DEADLINE)).rejects.toMatchObject({
      type: 'HOLD_DEADLINE_PASSED',
      nonRetryable: true,
      details,
    });
    expect(send.mock.calls[0]?.[0].holdNotAfter).toBe(row);
  });

  it('the same code to a request that set no deadline proves nothing', async () => {
    const { activities } = sending(past, 2);
    const caught = await activities.createObligation('ORD').then(
      () => {
        throw new Error('expected to fail');
      },
      (error: ApplicationFailure) => error,
    );
    expect(caught.details ?? []).not.toContain(REFUSED_PAST_HOLD_DEADLINE);
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
        // The durable call record (#836, FU-145): opened before the call, confirmed after it.
        openSagaCall: async () => ({ generation: 1, started: true }),
        confirmSagaCall: async () => undefined,
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
        // The durable call record (#836, FU-145); a refund answers the open ones on it.
        openSagaCall: async () => ({ generation: 1, started: true }),
        confirmSagaCall: async () => undefined,
        confirmSagaCallsOn: async () => undefined,
      } as unknown as OrderService,
      economic: { refund: async () => undefined } as unknown as EconomicClient,
      currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
      currentAttempt: () => 1,
    });
    await expect(economic.compensate('ORD', 'TXN', 'why')).resolves.toBeUndefined();
    // Behind the wait too (FU-117): it waits on confirmation, but it authorises nothing.
    await expect(
      economic.compensate('ORD', 'TXN', 'why', false, FINAL_ANSWER_CONTRACT),
    ).resolves.toBeUndefined();
    expect(held).not.toHaveBeenCalled();
  });

  it('in doubt with the row disputed, a terminal obligation is the final answer: nothing is sent', async () => {
    const { activities, trace } = over(
      { status: 'DISPUTED' },
      { attempt: 2, read: () => ({ status: 'REFUNDED', amountMinor: '1' }) },
    );
    await expect(
      activities.authoriseSettlement('ORD', 'TXN', false, FINAL_ANSWER_CONTRACT),
    ).resolves.toMatchObject({ final: true, status: 'REFUNDED' });
    expect(trace).toEqual(['read']);
  });

  it('a caller declaring final answers is fenced all the same on a first attempt', async () => {
    const { activities, trace } = over({ status: 'DISPUTED' });
    await expect(
      activities.authoriseSettlement('ORD', 'TXN', false, FINAL_ANSWER_CONTRACT),
    ).resolves.toEqual({ fenced: true, status: 'DISPUTED', inDoubt: false });
    expect(trace).toEqual(['hold', 'release']);
  });
});

/**
 * D-151: only economic-service's answer closes an authorisation's call record.
 * A fenced attempt sent nothing, so it never confirms it, whatever its doubt,
 * attempt or episode: an earlier send of the episode may still land.
 */
describe('a fenced authorisation never confirms its call record (D-151)', () => {
  function over(
    row: { status: string },
    opening: { generation: number; started: boolean },
    attempt: number,
  ) {
    const records: string[] = [];
    const sends: string[] = [];
    const activities = createActivities({
      orders: {
        describe: async () => ({
          id: 'ORD',
          status: 'RECEIPT_CONFIRMED',
          buyerOrganizationId: 'ORG',
          correlationId: 'COR',
          receiptConfirmed: true,
        }),
        onceForSaga: (_o: unknown, _s: unknown, _a: unknown, call: () => unknown) => call(),
        whileOrderHeld: async (_id: string, fn: (held: unknown) => unknown) =>
          fn({ receiptConfirmed: true, ...row }),
        openSagaCall: async () => {
          records.push('open');
          return opening;
        },
        confirmSagaCall: async () => {
          records.push('confirm');
        },
      } as unknown as OrderService,
      economic: {
        authoriseSettlement: async () => {
          sends.push('send');
        },
        readObligation: async () => ({ status: 'HELD' }),
      } as unknown as EconomicClient,
      currentStep: () => ({ key: 'K', scheduledAt: new Date(0) }),
      currentAttempt: () => attempt,
    });
    return { activities, records, sends };
  }

  it.each([
    ['a retry in doubt, the episode begun earlier', 2, false, { generation: 2, started: false }],
    ['a first attempt the workflow holds in doubt', 1, true, { generation: 2, started: false }],
    ['a first attempt that began the episode', 1, false, { generation: 1, started: true }],
  ] as const)(
    '%s: opened, never confirmed, nothing sent',
    async (_name, attempt, inDoubt, opening) => {
      const { activities, records, sends } = over({ status: 'DISPUTED' }, opening, attempt);
      await expect(activities.authoriseSettlement('ORD', 'TXN', inDoubt)).resolves.toEqual({
        fenced: true,
        status: 'DISPUTED',
        inDoubt: attempt !== 1 || inDoubt,
      });
      expect(records).toEqual(['open']);
      expect(sends).toEqual([]);
    },
  );

  it("economic-service's answer still confirms it (control)", async () => {
    const { activities, records, sends } = over(
      { status: 'RECEIPT_CONFIRMED' },
      { generation: 1, started: true },
      1,
    );
    await expect(activities.authoriseSettlement('ORD', 'TXN')).resolves.toBeUndefined();
    expect(records).toEqual(['open', 'confirm']);
    expect(sends).toEqual(['send']);
  });
});
