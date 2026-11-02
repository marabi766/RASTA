import { Logger } from '@nestjs/common';
import type { IdentityRepository } from './identity.repository';
import type { IdentityService } from './identity.service';
import {
  MAX_INTAKE_BACKOFF_INTERVALS,
  RegistrationIntakeWorker,
} from './registration-intake.worker';

/**
 * The registration worker's own contract (task 130, PR #483 r1 R5): what a
 * pass does with the rows it is given, a failing row deferred without holding
 * back the rest, one pass at a time, and a stop that starts nothing further
 * and waits for the pass in flight. What a row becomes is the service's
 * (`registration-acknowledgement.int-spec.ts`, against PostgreSQL).
 */

type Outcome = Awaited<ReturnType<IdentityService['processRegistrationIntake']>>;

function harness(due: string[], outcomes: Record<string, Outcome | Error | Promise<Outcome>>) {
  const processed: string[] = [];
  const deferred: Array<[string, number, number]> = [];
  const repository = {
    findDueRegistrationIntakes: jest.fn(async () => [...due]),
    deferRegistrationIntake: jest.fn(async (id: string, interval: number, cap: number) => {
      deferred.push([id, interval, cap]);
    }),
  } as unknown as IdentityRepository;
  const identity = {
    processRegistrationIntake: jest.fn(async (id: string) => {
      processed.push(id);
      const outcome = outcomes[id] ?? { outcome: 'GONE' };
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  } as unknown as IdentityService;
  const worker = new RegistrationIntakeWorker(repository, identity, {
    intervalSeconds: 5,
    batchSize: 50,
  });
  return { worker, repository, processed, deferred };
}

describe('RegistrationIntakeWorker', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('handles every due row in order and counts what it recorded or discarded', async () => {
    const { worker, repository, processed } = harness(['REG_1', 'REG_2', 'REG_3'], {
      REG_1: { outcome: 'RECORDED', registrationId: 'REG_1' },
      REG_2: { outcome: 'DUPLICATE' },
      REG_3: { outcome: 'GONE' },
    });

    expect(await worker.drain()).toBe(2);
    expect(processed).toEqual(['REG_1', 'REG_2', 'REG_3']);
    expect(repository.findDueRegistrationIntakes).toHaveBeenCalledWith(50);
  });

  it('defers a row that fails, by its interval and cap, and goes on with the rest', async () => {
    const { worker, processed, deferred } = harness(['REG_1', 'REG_2'], {
      REG_1: new Error('the database went away'),
      REG_2: { outcome: 'RECORDED', registrationId: 'REG_2' },
    });

    expect(await worker.drain()).toBe(1);
    expect(processed).toEqual(['REG_1', 'REG_2']);
    expect(deferred).toEqual([['REG_1', 5, MAX_INTAKE_BACKOFF_INTERVALS]]);
  });

  it('a failed read ends the pass quietly: the rows stay for the next one', async () => {
    const { worker, repository } = harness([], {});
    (repository.findDueRegistrationIntakes as jest.Mock).mockRejectedValueOnce(new Error('down'));

    await expect(worker.drain()).resolves.toBe(0);
  });

  it('one pass at a time: a drain while one runs starts nothing', async () => {
    let finish!: (outcome: Outcome) => void;
    const slow = new Promise<Outcome>((resolve) => (finish = resolve));
    const { worker, repository } = harness(['REG_1'], { REG_1: slow });

    const first = worker.drain();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await worker.drain()).toBe(0);
    finish({ outcome: 'RECORDED', registrationId: 'REG_1' });

    expect(await first).toBe(1);
    expect(repository.findDueRegistrationIntakes).toHaveBeenCalledTimes(1);
  });

  it('a stop waits for the pass in flight, which starts no further row, and no pass starts after it', async () => {
    let finish!: (outcome: Outcome) => void;
    const slow = new Promise<Outcome>((resolve) => (finish = resolve));
    const { worker, processed } = harness(['REG_1', 'REG_2'], {
      REG_1: slow,
      REG_2: { outcome: 'RECORDED', registrationId: 'REG_2' },
    });

    const pass = worker.drain();
    await new Promise((resolve) => setImmediate(resolve));
    let stopped = false;
    const stop = worker.stop({ deadlineAt: Date.now() + 5_000 }).then(() => (stopped = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    finish({ outcome: 'RECORDED', registrationId: 'REG_1' });
    await stop;

    expect(await pass).toBe(1);
    expect(processed).toEqual(['REG_1']);
    expect(await worker.drain()).toBe(0);
    expect(processed).toEqual(['REG_1']);
  });

  it('runs on its interval once started, and the stop clears the timer', async () => {
    jest.useFakeTimers();
    try {
      const { worker, repository } = harness([], {});
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(repository.findDueRegistrationIntakes).toHaveBeenCalledTimes(1);

      await worker.stop();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(repository.findDueRegistrationIntakes).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
