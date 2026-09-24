import { CachedRecipientPort } from './cached-recipient.port';
import {
  RecipientResolutionError,
  type RecipientPort,
  type RecipientQuery,
} from './recipient.port';

function counting(fail = false): RecipientPort & { calls: RecipientQuery[] } {
  const calls: RecipientQuery[] = [];
  return {
    calls,
    resolve: async (query) => {
      calls.push(query);
      if (fail) throw new RecipientResolutionError('UNREACHABLE', 'down');
      return {
        recipients: [{ userId: `USR_${calls.length}`, role: query.roles[0]!, email: null }],
        truncated: false,
      };
    },
  };
}

const query: RecipientQuery = {
  organizationId: 'ORG_A',
  roles: ['FLEET_MANAGER'],
  limit: 500,
  correlationId: 'COR',
};

describe('CachedRecipientPort', () => {
  it('answers a repeated query from cache inside the TTL', async () => {
    let now = 1_000;
    const inner = counting();
    const cached = new CachedRecipientPort(inner, 60_000, () => now);

    const first = await cached.resolve(query);
    const second = await cached.resolve({ ...query, correlationId: 'OTHER' });
    expect(inner.calls).toHaveLength(1);
    expect(second).toBe(first);

    now += 60_001;
    await cached.resolve(query);
    expect(inner.calls).toHaveLength(2);
  });

  it('keys on organization, role list and ceiling — a different tenant is a different call', async () => {
    const inner = counting();
    const cached = new CachedRecipientPort(inner, 60_000, () => 0);

    await cached.resolve(query);
    await cached.resolve({ ...query, organizationId: 'ORG_B' });
    await cached.resolve({ ...query, roles: ['ORGANIZATION_ADMIN'] });
    await cached.resolve({ ...query, limit: 10 });
    expect(inner.calls).toHaveLength(4);
  });

  it('never caches a failure', async () => {
    const inner = counting(true);
    const cached = new CachedRecipientPort(inner, 60_000, () => 0);

    await expect(cached.resolve(query)).rejects.toBeInstanceOf(RecipientResolutionError);
    await expect(cached.resolve(query)).rejects.toBeInstanceOf(RecipientResolutionError);
    expect(inner.calls).toHaveLength(2);
    expect(cached.size()).toBe(0);
  });

  it('is a pass-through with a zero TTL', async () => {
    const inner = counting();
    const cached = new CachedRecipientPort(inner, 0);
    await cached.resolve(query);
    await cached.resolve(query);
    expect(inner.calls).toHaveLength(2);
    expect(cached.size()).toBe(0);
  });

  it('evicts expired entries so memory stays bounded', async () => {
    let now = 0;
    const inner = counting();
    const cached = new CachedRecipientPort(inner, 1_000, () => now);
    await cached.resolve(query);
    await cached.resolve({ ...query, organizationId: 'ORG_B' });
    expect(cached.size()).toBe(2);
    now = 5_000;
    await cached.resolve({ ...query, organizationId: 'ORG_C' });
    expect(cached.size()).toBe(1);
  });
});
