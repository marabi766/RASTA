import {
  MAX_BACKOFF_INTERVALS,
  MAX_PAGES_PER_PASS,
  MembershipExpiryScanner,
} from './membership-expiry.scanner';
import type { IdentityRepository } from './identity.repository';
import type { IdentityService } from './identity.service';
import type { KeycloakProjector } from '../keycloak/keycloak.projector';
import {
  membershipLapseBacklog,
  membershipLapseFailuresTotal,
} from '../observability/keycloak-projection.metrics';

/**
 * The sweep that notices a validUntil passing (ADR-060 § 5). What it decides
 * lives in `IdentityService.expireLapsedMembership`; what is asserted here is
 * that one pass visits the lapses it finds, oldest first, with one clock;
 * survives any one of them failing; never lets failing ones starve the rest
 * (D-064); and re-asserts users whose Keycloak write was left unconfirmed.
 */
describe('MembershipExpiryScanner', () => {
  const now = new Date('2026-10-01T00:01:00.000Z');
  const lapse = (n: number, userId = `USR_${n}`) => ({
    id: `MBR_${n}`,
    userId,
    organizationId: n % 2 ? 'ORG-A' : 'ORG-B',
    validUntil: new Date(n),
  });
  const lapsed = [lapse(1), lapse(2), lapse(3)];

  /** The repository's lapse query, keyset and all, over `rows` minus what was handled. */
  function scannerWith(
    expire: jest.Mock,
    rows: ReturnType<typeof lapse>[] = lapsed,
    options: { batchSize?: number; due?: string[] } = {},
  ) {
    const handled = new Set<string>();
    const open = () => rows.filter((row) => !handled.has(row.id));
    const repository = {
      findLapsedMemberships: jest.fn(
        async (_now: Date, take: number, after: { validUntil: Date; id: string } | null) =>
          open()
            .filter(
              (row) =>
                !after ||
                row.validUntil > after.validUntil ||
                (row.validUntil.getTime() === after.validUntil.getTime() && row.id > after.id),
            )
            .slice(0, take),
      ),
      countLapsedMemberships: jest.fn(async () => open().length),
      findUsersDueKeycloakReassert: jest.fn(async () => options.due ?? []),
    };
    const identity = {
      expireLapsedMembership: jest.fn(async (membership: { id: string }, at: Date) => {
        const acted = (await expire(membership, at)) as boolean;
        if (acted) handled.add(membership.id);
        return acted;
      }),
    };
    const projector = { project: jest.fn(async () => 'projected') };
    const scanner = new MembershipExpiryScanner(
      repository as unknown as IdentityRepository,
      identity as unknown as IdentityService,
      { enabled: true, intervalSeconds: 60, batchSize: options.batchSize ?? 50 },
      projector as unknown as Pick<KeycloakProjector, 'project'>,
    );
    return { scanner, repository, projector, identity };
  }

  it('asks for lapses as of one clock and hands each the same clock', async () => {
    const expire = jest.fn(async (_membership: { id: string }, _at: Date) => true);
    const { scanner, repository } = scannerWith(expire);

    await expect(scanner.scan(now)).resolves.toBe(3);
    expect(repository.findLapsedMemberships).toHaveBeenCalledWith(now, 50, null);
    expect(expire.mock.calls.map(([membership, at]) => [membership.id, at])).toEqual([
      ['MBR_1', now],
      ['MBR_2', now],
      ['MBR_3', now],
    ]);
  });

  it('counts only the lapses it claimed', async () => {
    const expire = jest.fn(async (membership: { id: string }) => membership.id !== 'MBR_2');
    const { scanner } = scannerWith(expire);

    await expect(scanner.scan(now)).resolves.toBe(2);
  });

  it('keeps going past a lapse it could not handle', async () => {
    const expire = jest.fn(async (membership: { id: string }) => {
      if (membership.id === 'MBR_1') throw new Error('database unavailable');
      return true;
    });
    const { scanner } = scannerWith(expire);

    await expect(scanner.scan(now)).resolves.toBe(2);
    expect(expire).toHaveBeenCalledTimes(3);
  });

  it('never throws, even when the lapse query fails', async () => {
    const { scanner, repository } = scannerWith(jest.fn());
    repository.findLapsedMemberships.mockRejectedValue(new Error('down'));

    await expect(scanner.scan(now)).resolves.toBe(0);
  });

  it('never runs two passes at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const expire = jest.fn(async () => {
      await gate;
      return true;
    });
    const { scanner, repository } = scannerWith(expire);

    const first = scanner.scan(now);
    await expect(scanner.scan(now)).resolves.toBe(0);
    release();
    await expect(first).resolves.toBe(3);
    expect(repository.findLapsedMemberships).toHaveBeenCalledTimes(1);
  });

  /**
   * D-064: a lapse whose Keycloak write fails is not acted on, and is retried;
   * it must never hold back the lapses behind it, and nothing is given up.
   */
  describe('failing lapses never starve the rest (D-064)', () => {
    const minutes = (n: number) => new Date(now.getTime() + n * 60_000);
    const rows = [lapse(1), lapse(2), lapse(3), lapse(4)];
    // MBR_1 and MBR_2 cannot be written (their users' Keycloak refuses).
    const failing = new Set(['MBR_1', 'MBR_2']);
    const expire = () =>
      jest.fn(async (membership: { id: string }) => {
        if (failing.has(membership.id)) throw new Error('KEYCLOAK_UNAVAILABLE');
        return true;
      });

    it('sits a failed lapse out for the next pass, which reaches the ones behind it', async () => {
      const fn = expire();
      const { scanner } = scannerWith(fn, rows, { batchSize: 2 });

      // Pass 1: the two oldest, both failing, use up the pass.
      await expect(scanner.scan(now)).resolves.toBe(0);
      // Pass 2, one interval later: they wait, and the next two are acted on.
      await expect(scanner.scan(minutes(1))).resolves.toBe(2);
      expect(fn.mock.calls.map(([membership]) => membership.id)).toEqual([
        'MBR_1',
        'MBR_2',
        'MBR_3',
        'MBR_4',
      ]);
    });

    it('retries a failing lapse with a doubling backoff, capped, and never gives it up', async () => {
      const fn = jest.fn(async (): Promise<boolean> => {
        throw new Error('KEYCLOAK_UNAVAILABLE');
      });
      const { scanner } = scannerWith(fn, [lapse(1)]);

      const attemptsBy = async (passes: number) => {
        for (let pass = 0; pass < passes; pass += 1) await scanner.scan(minutes(pass));
        return fn.mock.calls.length;
      };
      // Tried at minute 0, 2, 6, 14, 30, then every 16 minutes: never dropped.
      expect(await attemptsBy(31)).toBe(5);
      fn.mockClear();
      for (let pass = 31; pass <= 31 + 3 * MAX_BACKOFF_INTERVALS; pass += 1) {
        await scanner.scan(minutes(pass));
      }
      expect(fn.mock.calls.length).toBe(3);
    });

    it('acts on a lapse once its write succeeds, and forgets its backoff', async () => {
      let refuse = true;
      const fn = jest.fn(async () => {
        if (refuse) throw new Error('KEYCLOAK_UNAVAILABLE');
        return true;
      });
      const { scanner } = scannerWith(fn, [lapse(1)]);

      await expect(scanner.scan(now)).resolves.toBe(0);
      refuse = false;
      await expect(scanner.scan(minutes(1))).resolves.toBe(0);
      await expect(scanner.scan(minutes(2))).resolves.toBe(1);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('makes at most batchSize attempts, and reads at most MAX_PAGES_PER_PASS pages', async () => {
      const many = Array.from({ length: 200 }, (_, n) => lapse(n + 1));
      const fn = jest.fn(async (): Promise<boolean> => {
        throw new Error('KEYCLOAK_UNAVAILABLE');
      });
      const { scanner, repository } = scannerWith(fn, many, { batchSize: 5 });

      await scanner.scan(now);
      expect(fn).toHaveBeenCalledTimes(5);
      // The next pass: every row it reads is waiting out a backoff or new.
      fn.mockClear();
      repository.findLapsedMemberships.mockClear();
      await scanner.scan(minutes(1));
      expect(fn).toHaveBeenCalledTimes(5);
      expect(repository.findLapsedMemberships.mock.calls.length).toBeLessThanOrEqual(
        MAX_PAGES_PER_PASS,
      );
    });

    it('publishes the backlog after every pass, and counts each failed attempt', async () => {
      const failuresBefore = (await membershipLapseFailuresTotal.get()).values[0]?.value ?? 0;
      const { scanner } = scannerWith(expire(), rows, { batchSize: 2 });

      await scanner.scan(now);
      expect((await membershipLapseBacklog.get()).values[0]?.value).toBe(4);
      await scanner.scan(minutes(1));
      expect((await membershipLapseBacklog.get()).values[0]?.value).toBe(2);
      expect((await membershipLapseFailuresTotal.get()).values[0]?.value).toBe(failuresBefore + 2);
    });
  });

  /** D-064: users whose Keycloak write was left unconfirmed are projected again, once it can no longer land. */
  describe('re-assertion', () => {
    it('projects every user whose mark has passed, as the reassert trigger', async () => {
      const { scanner, projector } = scannerWith(
        jest.fn(async () => true),
        [],
        {
          due: ['USR_7', 'USR_8'],
        },
      );

      await scanner.scan(now);
      expect(projector.project.mock.calls).toEqual([
        ['USR_7', 'reassert'],
        ['USR_8', 'reassert'],
      ]);
    });

    it('goes on past a user it cannot project, and never throws', async () => {
      const { scanner, projector } = scannerWith(
        jest.fn(async () => true),
        [],
        {
          due: ['USR_7', 'USR_8'],
        },
      );
      projector.project.mockRejectedValueOnce(new Error('KEYCLOAK_UNAVAILABLE'));

      await expect(scanner.scan(now)).resolves.toBe(0);
      expect(projector.project).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * D-052: an `OutboxShutdown` worker. Every lapse writes an outbox row, so
   * the stop ends the pass by the shutdown's shared deadline rather than only
   * clearing the timer.
   */
  describe('the stop', () => {
    it('waits for the lapse in flight, and starts no further one', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const expire = jest.fn(async () => {
        await gate;
        return true;
      });
      const { scanner } = scannerWith(expire);

      const pass = scanner.scan(now);
      await new Promise((resolve) => setImmediate(resolve));
      expect(expire).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopping = scanner.stop({ deadlineAt: Date.now() + 5000 }).then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stopped).toBe(false);

      release();
      await stopping;
      // MBR_2 and MBR_3 are left for the next pass.
      await expect(pass).resolves.toBe(1);
      expect(expire).toHaveBeenCalledTimes(1);
    });

    it('returns by the deadline, with a warning, when the lapse in flight does not end', async () => {
      const expire = jest.fn(() => new Promise<boolean>(() => undefined));
      const { scanner } = scannerWith(expire);
      const warn = jest
        .spyOn(
          (scanner as unknown as { logger: { warn: (message: string) => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      void scanner.scan(now);
      await new Promise((resolve) => setImmediate(resolve));

      const startedAt = Date.now();
      await scanner.stop({ deadlineAt: Date.now() + 200 });
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/abandoned/));
      expect(expire).toHaveBeenCalledTimes(1);
    });

    it('starts no pass once stopping, and a later stop joins the first', async () => {
      const expire = jest.fn(async () => true);
      const { scanner, repository } = scannerWith(expire);

      const first = scanner.stop({ deadlineAt: Date.now() + 1000 });
      expect(scanner.stop()).toBe(first);
      expect(scanner.onApplicationShutdown()).toBe(first);
      await first;

      await expect(scanner.scan(now)).resolves.toBe(0);
      expect(repository.findLapsedMemberships).not.toHaveBeenCalled();
    });

    it('with nothing in flight, returns at once', async () => {
      const { scanner } = scannerWith(jest.fn());
      const startedAt = Date.now();
      await scanner.stop({ deadlineAt: Date.now() + 5000 });
      expect(Date.now() - startedAt).toBeLessThan(100);
    });
  });
});
