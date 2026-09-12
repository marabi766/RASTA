import {
  CAPABILITIES,
  ManifestIntegrityError,
  assertManifestIntegrity,
  capabilityByHref,
  capabilityByKey,
  mayCallNetwork,
  type Capability,
} from './capabilities';
import { ADAPTERS, REGISTERED_ADAPTERS, declaredGatewayPrefixes } from './api/adapter-registry';

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
    domain: 'platform',
    ...overrides,
  } as Capability;
}

describe('capability manifest integrity', () => {
  it('accepts the shipped manifest', () => {
    expect(() => assertManifestIntegrity()).not.toThrow();
  });

  it('refuses BETA for a capability with no adapter named', () => {
    expect(() =>
      assertManifestIntegrity(
        [
          capability({
            key: 'x',
            state: 'BETA',
            service: 'supplier-service',
            readiness: 'PARTIAL',
          }),
        ],
        REGISTERED,
      ),
    ).toThrow(ManifestIntegrityError);
  });

  it('refuses two capabilities claiming the same route', () => {
    expect(() =>
      assertManifestIntegrity([capability({ key: 'a' }), capability({ key: 'b' })], REGISTERED),
    ).toThrow(/duplicate href/);
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
  it('backs every network-capable capability with a registered adapter', () => {
    const networked = CAPABILITIES.filter(mayCallNetwork);
    expect(networked.length).toBeGreaterThan(0);

    for (const entry of networked) {
      expect(REGISTERED.has(entry.adapter as string)).toBe(true);
    }
  });

  it('gives every registered adapter a capability that uses it', () => {
    // The inverse direction. An adapter nothing points at is dead code that
    // would still pass the integrity check, and dead code in the API layer is
    // the kind that quietly outlives the contract it was written against.
    const claimed = new Set(CAPABILITIES.map((entry) => entry.adapter).filter(Boolean));

    for (const adapter of ADAPTERS) {
      expect(claimed.has(adapter.id)).toBe(true);
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

  it('calls audit BETA, not LIVE, because this session never ran it against a real backend', () => {
    // AUD-001 through AUD-003 are stable and merged (PR #39, #40, #41), and the
    // screen's adapter reaches the real gateway route — but a parallel task is
    // forbidden from starting, stopping, resetting or reseeding the shared
    // integration stack, so there is no live smoke test behind this claim yet.
    const entry = capabilityByKey('audit');
    expect(entry?.state).toBe('BETA');
    expect(entry?.service).toBe('audit-service');
    expect(entry?.readiness).toBe('NOT_LIVE_VERIFIED');
  });

  it('lets only LIVE and BETA capabilities reach the network', () => {
    // BETA is included deliberately: `supplier-service` Phase 1 is merged and
    // this application calls it. What BETA says is that the *domain* is
    // unfinished, not that the endpoint is imaginary — and pretending
    // otherwise would understate a service that is really there.
    for (const entry of CAPABILITIES) {
      expect(mayCallNetwork(entry)).toBe(entry.state === 'LIVE' || entry.state === 'BETA');
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
    // `resolveRoute` in the gateway matches on the first path segment after
    // `/v1`. This list is copied from the `prefix` values in
    // `services/api-gateway/src/config/routes.ts`; an adapter aimed anywhere
    // else would reach a 404 at the edge rather than a service.
    const gatewayPrefixes = new Set([
      'registration-requests',
      'users',
      'memberships',
      'roles',
      'organizations',
      'assets',
      'insurance-policies',
      'drivers',
      'assignments',
      'usage-records',
      'fleet',
      'maintenance-requests',
      'maintenance-schedules',
      'repair-orders',
      'products',
      'offers',
      'cart',
      'orders',
      'demand-requests',
      'aggregations',
      'rfqs',
      'purchase-orders',
      'suppliers',
      'warehouses',
      'stock',
      'shipments',
      'projects',
      'approvals',
      'tenders',
      'contracts',
      'statements',
      'wallets',
      'transactions',
      'settlements',
      'payment-intents',
      'commissions',
      'rewards',
      'ledger',
      'notifications',
      'preferences',
      'documents',
      'audit-events',
      'dashboards',
      'kpis',
    ]);

    for (const adapter of ADAPTERS) {
      for (const route of adapter.routes) {
        const [method, path] = route.split(' ');
        expect(method).toMatch(/^(GET|POST|PATCH|PUT|DELETE)$/);
        expect(path?.startsWith('/v1/')).toBe(true);
        expect(gatewayPrefixes.has(path!.split('/')[2]!)).toBe(true);
      }
    }
  });

  it('reaches only prefixes the gateway routes', () => {
    for (const prefix of declaredGatewayPrefixes()) {
      expect(typeof prefix).toBe('string');
      expect(prefix).not.toContain('{');
    }
  });
});
