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
});
