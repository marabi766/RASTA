import {
  CAPABILITIES,
  ManifestIntegrityError,
  assertManifestIntegrity,
  capabilityByHref,
  capabilityByKey,
  mayCallNetwork,
  type Capability,
} from './capabilities';
import { ADAPTERS, REGISTERED_ADAPTERS } from './api/adapter-registry';

/**
 * The manifest is the one place a status claim is made, so it is the one place
 * a dishonest claim has to be impossible.
 */

const REGISTERED = REGISTERED_ADAPTERS as ReadonlySet<string>;

function capability(overrides: Partial<Capability>): Capability {
  return {
    key: 'sample',
    href: '/sample',
    title: 'نمونه',
    summary: 'نمونه',
    state: 'PLANNED',
    service: null,
    readiness: 'PLANNED',
    evidence: 'test fixture',
    group: 'platform',
    ...overrides,
  } as Capability;
}

describe('capability manifest integrity', () => {
  it('accepts the shipped manifest', () => {
    expect(() => assertManifestIntegrity()).not.toThrow();
  });

  it('refuses LIVE for a service with no adapter named', () => {
    expect(() =>
      assertManifestIntegrity(
        [capability({ key: 'procurement', state: 'LIVE', service: 'procurement-service' })],
        REGISTERED,
      ),
    ).toThrow(ManifestIntegrityError);
  });

  it('refuses LIVE when the named adapter is not registered', () => {
    let thrown: unknown;
    try {
      assertManifestIntegrity(
        [
          capability({
            key: 'inventory',
            state: 'LIVE',
            service: 'inventory-service',
            // A plausible-looking id for a service that does not exist.
            adapter: 'inventory.stock' as Capability['adapter'],
          }),
        ],
        REGISTERED,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestIntegrityError);
    expect((thrown as ManifestIntegrityError).violations.join(' ')).toContain('not registered');
  });

  it('refuses a non-live capability that names an adapter', () => {
    expect(() =>
      assertManifestIntegrity(
        [
          capability({
            state: 'PLANNED',
            adapter: 'marketplace.catalogue',
            readiness: 'PLANNED',
          }),
        ],
        REGISTERED,
      ),
    ).toThrow(/must not reach the network/);
  });

  it('refuses a non-live capability with no readiness reason', () => {
    expect(() =>
      assertManifestIntegrity([capability({ readiness: undefined })], REGISTERED),
    ).toThrow(/no readiness reason/);
  });

  it('refuses a status stated without evidence', () => {
    expect(() => assertManifestIntegrity([capability({ evidence: '   ' })], REGISTERED)).toThrow(
      /no evidence/,
    );
  });

  it('refuses duplicate keys', () => {
    expect(() =>
      assertManifestIntegrity([capability({}), capability({ href: '/other' })], REGISTERED),
    ).toThrow(/duplicate capability key/);
  });
});

describe('shipped manifest', () => {
  it('marks exactly the capabilities backed by a registered adapter as LIVE', () => {
    const live = CAPABILITIES.filter((entry) => entry.state === 'LIVE');
    expect(live.length).toBeGreaterThan(0);

    for (const entry of live) {
      expect(REGISTERED.has(entry.adapter as string)).toBe(true);
    }
  });

  it('does not claim any un-built service is LIVE', () => {
    // Nothing exists behind these prefixes at this branch baseline. Each has a
    // gateway route, and three have a Kafka topic or a merged service
    // bootstrap; none of that is an implementation.
    const notImplemented = [
      'procurement',
      'inventory',
      'construction',
      'contracts',
      'notifications',
      'audit',
      'analytics',
      'returns',
    ];

    for (const key of notImplemented) {
      const entry = capabilityByKey(key);
      expect(entry).toBeDefined();
      expect(entry?.state).toBe('PLANNED');
      expect(entry?.service).toBeNull();
    }
  });

  it('keeps supplier out of the finished states while COM-005 is in progress', () => {
    expect(capabilityByKey('suppliers')?.state).toBe('BETA');
  });

  it('lets only LIVE capabilities reach the network', () => {
    for (const entry of CAPABILITIES) {
      expect(mayCallNetwork(entry)).toBe(entry.state === 'LIVE');
    }
  });

  it('resolves every capability by key and by href', () => {
    for (const entry of CAPABILITIES) {
      expect(capabilityByKey(entry.key)).toBe(entry);
      expect(capabilityByHref(entry.href)).toBe(entry);
    }
  });
});

describe('adapter registry', () => {
  it('registers an id only where an adapter module defines it', () => {
    expect([...REGISTERED].sort()).toEqual(ADAPTERS.map((adapter) => adapter.id).sort());
  });

  it('declares only routes the gateway can resolve', () => {
    // `resolveRoute` in the gateway matches the first path segment after /v1.
    // Every prefix below appears in `services/api-gateway/src/config/routes.ts`.
    const gatewayPrefixes = new Set(['products', 'offers', 'organizations', 'wallets']);

    for (const adapter of ADAPTERS) {
      for (const route of adapter.routes) {
        const [method, path] = route.split(' ');
        expect(method).toMatch(/^(GET|POST|PATCH|PUT|DELETE)$/);
        expect(path?.startsWith('/v1/')).toBe(true);
        expect(gatewayPrefixes.has(path!.split('/')[2]!)).toBe(true);
      }
    }
  });
});
