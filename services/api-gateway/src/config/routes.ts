import { z } from 'zod';

/**
 * The routing table.
 *
 * Kept as data rather than a chain of `if` statements so that "which service
 * owns this path, and who may reach it" is answerable by reading one file.
 *
 * Note what is *not* here: no request or response transformation, no field
 * mapping, no business rules. The gateway routes and enforces cross-cutting
 * concerns; the moment it starts reshaping domain payloads it becomes a hidden
 * monolith that every service change has to be coordinated with (ADR-009).
 */

export interface RouteRule {
  /** Path prefix under /v1, e.g. `users`. */
  prefix: string;
  /** Which service handles it. Resolved to a URL from configuration. */
  service: ServiceName;
  /**
   * Roles permitted at the route level.
   *
   * Coarse on purpose. This is a cheap first filter that rejects obvious
   * mismatches at the edge; it is NOT the authorization decision. Every
   * service re-checks independently, including object-level ownership, because
   * the gateway cannot know which record is being touched (ADR-020, Zero Trust).
   *
   * `undefined` means any authenticated caller may attempt it.
   */
  roles?: readonly string[];
  /** Reachable without a token. Each entry needs a stated reason. */
  publicReason?: string;
  /**
   * Requires an `Idempotency-Key` on unsafe methods.
   *
   * Set for anything that moves money or creates an irreversible external
   * effect (docs/06 § 6.8).
   */
  requiresIdempotencyKey?: boolean;
  /**
   * Overrides the default per-user rate limit for expensive endpoints.
   *
   * `unsafeMethodsOnly` narrows the override to the methods that create work,
   * leaving reads on the platform default. It exists because `docs/06` § 6.9
   * limits *operations* — "۲۰ فایل در ساعت" is a cap on uploading documents —
   * while this table matches on a path prefix, so without it an upload cap
   * silently becomes a cap on listing and reading too. Twenty requests an hour
   * would make a documents screen unusable after one page.
   *
   * Method-awareness is not new knowledge for the gateway: it already applies
   * `requiresIdempotencyKey` to unsafe methods only. It still knows nothing
   * about the domain — only that writes cost more than reads (ADR-009).
   */
  rateLimit?: { limit: number; windowSeconds: number; unsafeMethodsOnly?: boolean };
}

export const SERVICE_NAMES = [
  'identity',
  'organization',
  'asset',
  'fleet',
  'maintenance',
  'marketplace',
  'procurement',
  'supplier',
  'inventory',
  'construction',
  'contract',
  'economic',
  'notification',
  'document',
  'audit',
  'analytics',
] as const;

export type ServiceName = (typeof SERVICE_NAMES)[number];

/**
 * Ordered most-specific first: `registration-requests` must be matched before
 * any shorter prefix that could also match it.
 */
export const ROUTES: readonly RouteRule[] = [
  // ---- identity ----------------------------------------------------------
  {
    prefix: 'registration-requests',
    service: 'identity',
    publicReason:
      'Self-registration must be reachable before the applicant has an account. It creates a PENDING user with no credentials and a reviewable request, so it cannot grant access.',
    // Tightly limited: this is the one unauthenticated write on the platform,
    // so it is the obvious target for flooding the review queue.
    rateLimit: { limit: 5, windowSeconds: 3600 },
  },
  { prefix: 'users', service: 'identity' },
  { prefix: 'memberships', service: 'identity' },
  { prefix: 'roles', service: 'identity' },

  // ---- organization ------------------------------------------------------
  { prefix: 'organizations', service: 'organization' },

  // ---- assets and fleet --------------------------------------------------
  { prefix: 'assets', service: 'asset' },
  { prefix: 'insurance-policies', service: 'asset' },
  { prefix: 'drivers', service: 'fleet' },
  { prefix: 'assignments', service: 'fleet' },
  // docs/04 § 4.6 sketched usage as `POST /assets/{assetId}/usage`. This
  // gateway resolves a route from the *first* path segment only, so anything
  // under `assets/` reaches asset-service — and teaching it to route by second
  // segment would give it knowledge of a domain it deliberately does not have
  // (ADR-009). A top-level prefix is the honest fix: a usage record belongs to
  // fleet, not to the asset (ADR-026).
  { prefix: 'usage-records', service: 'fleet' },
  { prefix: 'fleet', service: 'fleet' },

  // ---- maintenance -------------------------------------------------------
  { prefix: 'maintenance-requests', service: 'maintenance' },
  { prefix: 'maintenance-schedules', service: 'maintenance' },
  { prefix: 'repair-orders', service: 'maintenance' },

  // ---- commerce ----------------------------------------------------------
  // Search is read-heavy and cheap to abuse, so it carries the tighter limit
  // docs/06 § 6.9 sets for search rather than the default per-user one.
  { prefix: 'products', service: 'marketplace', rateLimit: { limit: 60, windowSeconds: 60 } },
  { prefix: 'offers', service: 'marketplace' },
  // `cart` is deferred, not removed (ADR-037 § 3): the prefix stays so the
  // routing table still reflects docs/04, and reaches a service that has no
  // handler for it — which answers 404, exactly what "not built yet" means.
  { prefix: 'cart', service: 'marketplace' },
  { prefix: 'orders', service: 'marketplace', requiresIdempotencyKey: true },
  { prefix: 'demand-requests', service: 'procurement' },
  { prefix: 'aggregations', service: 'procurement' },
  { prefix: 'rfqs', service: 'procurement' },
  { prefix: 'purchase-orders', service: 'procurement', requiresIdempotencyKey: true },
  { prefix: 'suppliers', service: 'supplier' },
  { prefix: 'warehouses', service: 'inventory' },
  { prefix: 'stock', service: 'inventory' },
  { prefix: 'shipments', service: 'inventory' },

  // ---- civil works -------------------------------------------------------
  { prefix: 'projects', service: 'construction' },
  { prefix: 'approvals', service: 'construction' },
  { prefix: 'tenders', service: 'construction', requiresIdempotencyKey: true },
  { prefix: 'contracts', service: 'contract' },
  { prefix: 'statements', service: 'contract', requiresIdempotencyKey: true },

  // ---- economic ----------------------------------------------------------
  // Everything that moves money requires an idempotency key. A retried POST
  // that charges twice is the failure mode this exists to prevent.
  { prefix: 'wallets', service: 'economic', requiresIdempotencyKey: true },
  { prefix: 'transactions', service: 'economic', requiresIdempotencyKey: true },
  { prefix: 'settlements', service: 'economic', requiresIdempotencyKey: true },
  // A refund is the only unsafe method here, and it moves money, so the whole
  // prefix carries the key requirement rather than the route table learning
  // which verb does what.
  { prefix: 'payment-intents', service: 'economic', requiresIdempotencyKey: true },
  { prefix: 'commissions', service: 'economic' },
  { prefix: 'rewards', service: 'economic' },
  { prefix: 'ledger', service: 'economic', roles: ['SYSTEM_ADMIN', 'UNION_ADMIN'] },

  // ---- platform ----------------------------------------------------------
  { prefix: 'notifications', service: 'notification' },
  { prefix: 'preferences', service: 'notification' },
  // `docs/06` § 6.9: twenty document uploads an hour. Unsafe methods only —
  // requesting an upload URL, registering the result, issuing a download URL
  // and deleting are the operations that cap; listing and reading metadata run
  // on the platform default, or a user would be locked out for an hour by one
  // screen of documents.
  {
    prefix: 'documents',
    service: 'document',
    rateLimit: { limit: 20, windowSeconds: 3600, unsafeMethodsOnly: true },
  },
  {
    prefix: 'audit-events',
    service: 'audit',
    roles: ['SYSTEM_ADMIN', 'UNION_ADMIN'],
  },
  {
    // CONSTRAINT (product document, ch. 4): province oversight is aggregate
    // only. AUDITOR reaches analytics and nothing else — no route in this
    // table grants it row-level data.
    prefix: 'dashboards',
    service: 'analytics',
  },
  { prefix: 'kpis', service: 'analytics' },
];

/** Longest-prefix match, so `orders` never shadows a longer sibling. */
export function resolveRoute(path: string): RouteRule | undefined {
  const segment = path.replace(/^\/+/, '').split('/')[0];
  if (!segment) return undefined;

  return ROUTES.find((route) => route.prefix === segment);
}

export const serviceUrlEnvSchema = z.object({
  IDENTITY_SERVICE_URL: z.string().url(),
  ORGANIZATION_SERVICE_URL: z.string().url(),
  ASSET_SERVICE_URL: z.string().url(),
  FLEET_SERVICE_URL: z.string().url(),
  MAINTENANCE_SERVICE_URL: z.string().url(),
  MARKETPLACE_SERVICE_URL: z.string().url(),
  PROCUREMENT_SERVICE_URL: z.string().url(),
  SUPPLIER_SERVICE_URL: z.string().url(),
  INVENTORY_SERVICE_URL: z.string().url(),
  CONSTRUCTION_SERVICE_URL: z.string().url(),
  CONTRACT_SERVICE_URL: z.string().url(),
  ECONOMIC_SERVICE_URL: z.string().url(),
  NOTIFICATION_SERVICE_URL: z.string().url(),
  DOCUMENT_SERVICE_URL: z.string().url(),
  AUDIT_SERVICE_URL: z.string().url(),
  ANALYTICS_SERVICE_URL: z.string().url(),
});

export type ServiceUrls = z.infer<typeof serviceUrlEnvSchema>;

export function serviceUrl(urls: ServiceUrls, service: ServiceName): string {
  const key = `${service.toUpperCase()}_SERVICE_URL` as keyof ServiceUrls;
  return urls[key];
}
