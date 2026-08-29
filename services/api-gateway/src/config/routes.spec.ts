import { ROUTES, resolveRoute, serviceUrl, SERVICE_NAMES, type ServiceUrls } from './routes';

/**
 * The routing table is configuration, so these tests assert the *properties*
 * that must hold across it rather than restating each row. A test that just
 * repeats the table catches nothing; these catch the mistakes an edit can
 * actually introduce.
 */

describe('routing table integrity', () => {
  it('has no duplicate prefixes', () => {
    // A duplicate is silently unreachable: resolveRoute returns the first
    // match and the second row never fires.
    const prefixes = ROUTES.map((r) => r.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('routes only to known services', () => {
    for (const route of ROUTES) {
      expect(SERVICE_NAMES).toContain(route.service);
    }
  });

  it('gives every public route a stated reason', () => {
    // Opening a route without recording why is how an endpoint quietly
    // becomes unauthenticated and nobody notices for a year.
    for (const route of ROUTES.filter((r) => r.publicReason !== undefined)) {
      expect(route.publicReason!.length).toBeGreaterThan(20);
    }
  });

  it('exposes exactly one public route', () => {
    // Self-registration is the only thing that must work before a caller has
    // an account. If this count ever grows, it should be a deliberate decision
    // that fails this test first.
    const publicRoutes = ROUTES.filter((r) => r.publicReason !== undefined);
    expect(publicRoutes.map((r) => r.prefix)).toEqual(['registration-requests']);
  });

  it('rate-limits the public route far more tightly than the default', () => {
    const registration = ROUTES.find((r) => r.prefix === 'registration-requests');
    expect(registration?.rateLimit).toBeDefined();
    expect(registration!.rateLimit!.limit).toBeLessThanOrEqual(10);
  });

  it('requires an idempotency key on every money-moving prefix', () => {
    // The failure this prevents is a retried POST charging twice.
    const financial = ['orders', 'wallets', 'transactions', 'settlements', 'purchase-orders'];
    for (const prefix of financial) {
      const route = ROUTES.find((r) => r.prefix === prefix);
      expect(route).toBeDefined();
      expect(route!.requiresIdempotencyKey).toBe(true);
    }
  });

  it('does not require an idempotency key on read-only prefixes', () => {
    for (const prefix of ['commissions', 'rewards', 'dashboards', 'kpis']) {
      expect(ROUTES.find((r) => r.prefix === prefix)?.requiresIdempotencyKey).toBeUndefined();
    }
  });

  it('restricts the ledger and audit trail to platform operators', () => {
    for (const prefix of ['ledger', 'audit-events']) {
      const route = ROUTES.find((r) => r.prefix === prefix);
      expect(route?.roles).toEqual(expect.arrayContaining(['SYSTEM_ADMIN', 'UNION_ADMIN']));
    }
  });

  it('never routes AUDITOR to a row-level economic prefix', () => {
    // CONSTRAINT (product document, ch. 4): province oversight is aggregate
    // only. No route may hand AUDITOR individual transactions.
    for (const prefix of [
      'transactions',
      'wallets',
      'ledger',
      'orders',
      'settlements',
      'commissions',
      'rewards',
      'payment-intents',
    ]) {
      const route = ROUTES.find((r) => r.prefix === prefix);
      expect(route?.roles ?? []).not.toContain('AUDITOR');
    }
  });

  it('requires an idempotency key on every prefix that moves money', () => {
    // docs/06 § 6.8. A retried POST that charges twice is the failure this
    // exists to prevent, and the gateway is the first of the two places that
    // enforce it — economic-service checks again, because a service must not
    // assume it was only reached through the gateway (ADR-020).
    for (const prefix of ['wallets', 'transactions', 'settlements', 'payment-intents', 'orders']) {
      const route = ROUTES.find((r) => r.prefix === prefix);
      expect(route?.requiresIdempotencyKey).toBe(true);
    }
  });
});

describe('resolveRoute', () => {
  it.each([
    ['/users/me', 'identity'],
    ['/organizations/ORG-DEH-0001/children', 'organization'],
    ['/assets/AST_123/usage', 'asset'],
    ['/drivers/DRV_1/assignments', 'fleet'],
    ['/assignments/ASG_1/end', 'fleet'],
    ['/usage-records', 'fleet'],
    ['/fleet/availability', 'fleet'],
    ['/orders', 'marketplace'],
    ['/orders/ORD_1/confirm-receipt', 'marketplace'],
    ['/products', 'marketplace'],
    ['/offers/OFR_1', 'marketplace'],
    ['/tenders/TND_1/bids', 'construction'],
    ['/ledger/trial-balance', 'economic'],
  ])('routes %s to %s', (path, service) => {
    expect(resolveRoute(path)?.service).toBe(service);
  });

  it('requires an Idempotency-Key on every unsafe order route', () => {
    // docs/06 § 6.8 lists order creation among the operations that must be
    // idempotent. The gateway applies it to the whole prefix, and
    // marketplace-service requires it again — the gateway is not the only way
    // to reach that port.
    expect(resolveRoute('/orders')?.requiresIdempotencyKey).toBe(true);
    expect(resolveRoute('/orders/ORD_1/cancel')?.requiresIdempotencyKey).toBe(true);
  });

  it('does not require one on catalogue reads', () => {
    // A search is safe and repeatable; demanding a key would be ceremony that
    // teaches clients to send meaningless ones.
    expect(resolveRoute('/products')?.requiresIdempotencyKey).toBeUndefined();
  });

  it('gives the oversight role no marketplace prefix at all', () => {
    // docs/09 § 9.3: aggregate access only, served by analytics-service. The
    // first of three layers — the service refuses AUDITOR independently.
    for (const path of ['/orders', '/products', '/offers']) {
      expect(resolveRoute(path)?.roles ?? []).not.toContain('AUDITOR');
    }
  });

  it('keeps usage records with fleet, not with the asset they describe', () => {
    // The asset is owned by asset-service and a usage record is not; routing
    // `usage-records` to `asset` would put a fleet write behind the wrong
    // service and the wrong database (ADR-026). This test is the guard on a
    // prefix that reads as if it belonged to assets.
    expect(resolveRoute('/usage-records/USG_1')?.service).toBe('fleet');
    expect(resolveRoute('/assets/AST_1')?.service).toBe('asset');
  });

  it('matches on the first segment only, so a longer path cannot escape', () => {
    // `/users/../ledger` must not resolve to the ledger route.
    expect(resolveRoute('/users/../ledger')?.service).toBe('identity');
  });

  it('returns undefined for an unknown prefix', () => {
    // An unmatched path is rejected at the edge and never forwarded.
    expect(resolveRoute('/definitely-not-a-route')).toBeUndefined();
  });

  it('returns undefined for an empty path', () => {
    expect(resolveRoute('/')).toBeUndefined();
    expect(resolveRoute('')).toBeUndefined();
  });

  it('is not confused by a leading slash or its absence', () => {
    expect(resolveRoute('users')?.service).toBe('identity');
    expect(resolveRoute('/users')?.service).toBe('identity');
  });
});

describe('serviceUrl', () => {
  it('resolves every service name to a configured URL', () => {
    // Guards the naming convention that maps `identity` to
    // IDENTITY_SERVICE_URL. A typo here is a runtime 500, not a build error.
    const urls = Object.fromEntries(
      SERVICE_NAMES.map((name) => [`${name.toUpperCase()}_SERVICE_URL`, `http://${name}:3000`]),
    ) as ServiceUrls;

    for (const name of SERVICE_NAMES) {
      expect(serviceUrl(urls, name)).toBe(`http://${name}:3000`);
    }
  });

  it('has a configured URL for every service the table routes to', () => {
    const referenced = new Set(ROUTES.map((r) => r.service));
    for (const service of referenced) {
      expect(SERVICE_NAMES).toContain(service);
    }
  });
});
