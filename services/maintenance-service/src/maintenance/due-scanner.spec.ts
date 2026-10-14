import type { MaintenanceEnv } from '../config/env';
import type { DueAnnouncerService } from './due-announcer.service';
import { DueScanner } from './due-scanner';
import type { MaintenanceRepository } from './maintenance.repository';

/**
 * Codex r3 on #247: the due scanner stops with the relay and the purge, in the
 * destroy phase, by their shared deadline — no new schedule once stopping, and
 * no wait past the deadline for the one in flight.
 */
describe('DueScanner.stop', () => {
  const env = {
    MAINTENANCE_DUE_SCAN_ENABLED: true,
    MAINTENANCE_DUE_SCAN_INTERVAL_SECONDS: 900,
    MAINTENANCE_DUE_SCAN_BATCH_SIZE: 200,
  } as unknown as MaintenanceEnv;

  const schedules = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `SCH-${i}`, organizationId: 'ORG-1' }));

  /** A scanner over `n` schedules whose announcement waits for `announce`. */
  function scannerWith(n: number, announce: (id: string) => Promise<boolean>) {
    const repository = {
      claimUnannouncedSchedules: async () => schedules(n),
    } as unknown as MaintenanceRepository;
    const announced: string[] = [];
    const announcer = {
      announceIfDue: async (schedule: { id: string }) => {
        announced.push(schedule.id);
        return announce(schedule.id);
      },
    } as unknown as DueAnnouncerService;
    return { scanner: new DueScanner(repository, announcer, env), announced };
  }

  const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

  it('starts no further schedule once stopping, and waits for the one in flight', async () => {
    let release!: () => void;
    const { scanner, announced } = scannerWith(3, (id) =>
      id === 'SCH-0'
        ? new Promise<boolean>((resolve) => (release = () => resolve(true)))
        : Promise.resolve(true),
    );
    const pass = scanner.scan(new Date());
    await new Promise((resolve) => setImmediate(resolve));

    let stopped = false;
    const stopping = scanner.stop({ deadlineAt: Date.now() + 5000 }).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(await pass).toBe(1);
    expect(announced).toEqual(['SCH-0']);
    // Nothing after the stop, from the timer or by hand.
    expect(await scanner.scan(new Date())).toBe(0);
  });

  it('returns by the deadline when the schedule in flight never finishes', async () => {
    const { scanner } = scannerWith(2, () => never<boolean>());
    void scanner.scan(new Date());
    await new Promise((resolve) => setImmediate(resolve));

    const startedAt = Date.now();
    await scanner.stop({ deadlineAt: Date.now() + 300 });
    const ms = Date.now() - startedAt;
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(1000);
  });

  it('clears its timer, returns at once when idle, and is one stop', async () => {
    jest.useFakeTimers();
    try {
      const { scanner, announced } = scannerWith(1, async () => true);
      scanner.onModuleInit();
      const first = scanner.stop({ deadlineAt: Date.now() + 1000 });
      expect(scanner.stop()).toBe(first);
      expect(scanner.onApplicationShutdown()).toBe(first);
      await first;
      jest.advanceTimersByTime(3 * 900_000);
      expect(announced).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
