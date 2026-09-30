import { loadEconomicEnv, type EconomicEnv } from '../config/env';
import { PaymentReconciliationSweeper } from './payment-reconciliation.sweeper';
import type {
  PaymentReconciliationRepository,
  ClaimedTask,
} from './payment-reconciliation.repository';
import type { PaymentReconciler, ReconcileResult } from './payment-reconciler';

/**
 * The sweeper's own behaviour, apart from the database (ADR-064 step B2): it
 * runs on its timer, never overlaps itself, survives a failed sweep and a
 * failed task, tallies every result, and waits for a running sweep on
 * shutdown. The database side is `test/payment-reconciler.int-spec.ts`.
 */
describe('PaymentReconciliationSweeper', () => {
  const env: EconomicEnv = loadEconomicEnv({
    DATABASE_URL: 'postgresql://u:p@localhost:5432/rasta_economic?schema=public',
    KAFKA_BROKERS: 'localhost:9092',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'a_secret_that_is_at_least_thirty_two_chars',
    MAINTENANCE_SERVICE_URL: 'http://localhost:3105',
    FLEET_SERVICE_URL: 'http://localhost:3104',
  });

  const task = (id: string): ClaimedTask => ({
    id,
    organizationId: 'ORG-SWEEP',
    paymentIntentId: `PAY_${id}`,
    kind: 'REFUND',
    attempts: 0,
    createdAt: new Date(),
    correlationId: `COR-${id}`,
    leaseToken: 'token',
  });

  function build(results: (ReconcileResult | Error)[], backlogFails = false) {
    const claimed = results.map((_, index) => task(`T${index}`));
    const tasks = {
      heal: jest.fn().mockResolvedValue({ opened: 0, closed: 0 }),
      claimDue: jest.fn().mockResolvedValue(claimed),
      backlog: backlogFails
        ? jest.fn().mockRejectedValue('database gone')
        : jest.fn().mockResolvedValue({ open: 1, escalated: 0, oldestDueAgeSeconds: 0 }),
    };
    let index = 0;
    const reconciler = {
      reconcile: jest.fn(async () => {
        const next = results[index++];
        if (next instanceof Error) throw next;
        return next;
      }),
    };
    const sweeper = new PaymentReconciliationSweeper(
      tasks as unknown as PaymentReconciliationRepository,
      reconciler as unknown as PaymentReconciler,
      env,
    );
    return { sweeper, tasks, reconciler };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('tallies every result, and a task that throws does not stall the batch', async () => {
    const { sweeper, reconciler } = build([
      'resolved_refunded',
      'resolved_declined',
      'resolved_not_reached',
      'resolved_uncredited',
      'noop',
      'retried',
      'deferred',
      'escalated',
      'lost_lease',
      new Error('beyond its own handling'),
    ]);

    expect(await sweeper.runOnce()).toEqual({
      claimed: 10,
      resolved: 4,
      noop: 1,
      retried: 1,
      deferred: 1,
      escalated: 1,
      lost: 2,
      healedOpened: 0,
      healedClosed: 0,
    });
    expect(reconciler.reconcile).toHaveBeenCalledTimes(10);
  });

  it('reports heals, and sweeps even when the backlog cannot be sampled', async () => {
    const { sweeper, tasks } = build([], true);
    tasks.heal.mockResolvedValue({ opened: 2, closed: 3 });
    await expect(sweeper.runOnce()).resolves.toMatchObject({
      claimed: 0,
      healedOpened: 2,
      healedClosed: 3,
    });
  });

  it('sweeps on its timer, never overlapping itself, and survives a failed sweep', async () => {
    jest.useFakeTimers();
    const { sweeper } = build([]);
    let finish!: () => void;
    const run = jest
      .spyOn(sweeper, 'runOnce')
      .mockRejectedValueOnce(new Error('database down'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({} as never);
          }),
      );

    sweeper.onModuleInit();
    const interval = env.ECONOMIC_PAYMENT_RECONCILER_INTERVAL_SECONDS * 1000;

    await jest.advanceTimersByTimeAsync(interval); // fails, is caught
    await jest.advanceTimersByTimeAsync(interval); // starts, hangs
    await jest.advanceTimersByTimeAsync(interval); // skipped: still running
    expect(run).toHaveBeenCalledTimes(2);

    const stopped = sweeper.onApplicationShutdown();
    finish();
    await stopped;
    await jest.advanceTimersByTimeAsync(interval * 3);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not start when switched off', async () => {
    jest.useFakeTimers();
    const { tasks } = build([]);
    const off = new PaymentReconciliationSweeper(
      tasks as unknown as PaymentReconciliationRepository,
      { reconcile: jest.fn() } as unknown as PaymentReconciler,
      { ...env, ECONOMIC_PAYMENT_RECONCILER_ENABLED: false },
    );
    off.onModuleInit();
    await jest.advanceTimersByTimeAsync(env.ECONOMIC_PAYMENT_RECONCILER_INTERVAL_SECONDS * 5000);
    expect(tasks.claimDue).not.toHaveBeenCalled();
    await off.onApplicationShutdown();
  });
});
