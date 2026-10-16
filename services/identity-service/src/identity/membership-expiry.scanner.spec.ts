import { MembershipExpiryScanner } from './membership-expiry.scanner';
import type { IdentityRepository } from './identity.repository';
import type { IdentityService } from './identity.service';

/**
 * The sweep that notices a validUntil passing (ADR-060 § 5). What it decides
 * lives in `IdentityService.expireLapsedMembership`; what is asserted here is
 * that one pass visits every lapse it finds, with one clock, and survives any
 * one of them failing.
 */
describe('MembershipExpiryScanner', () => {
  const now = new Date('2026-10-01T00:01:00.000Z');
  const lapsed = [
    { id: 'MBR_1', userId: 'USR_1', organizationId: 'ORG-A', validUntil: new Date(0) },
    { id: 'MBR_2', userId: 'USR_2', organizationId: 'ORG-B', validUntil: new Date(0) },
    { id: 'MBR_3', userId: 'USR_3', organizationId: 'ORG-A', validUntil: new Date(0) },
  ];

  function scannerWith(expire: jest.Mock) {
    const repository = { findLapsedMemberships: jest.fn(async () => lapsed) };
    const identity = { expireLapsedMembership: expire };
    const scanner = new MembershipExpiryScanner(
      repository as unknown as IdentityRepository,
      identity as unknown as IdentityService,
      { enabled: true, intervalSeconds: 60, batchSize: 50 },
    );
    return { scanner, repository };
  }

  it('asks for lapses as of one clock and hands each the same clock', async () => {
    const expire = jest.fn(async (_membership: { id: string }, _at: Date) => true);
    const { scanner, repository } = scannerWith(expire);

    await expect(scanner.scan(now)).resolves.toBe(3);
    expect(repository.findLapsedMemberships).toHaveBeenCalledWith(now, 50);
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
