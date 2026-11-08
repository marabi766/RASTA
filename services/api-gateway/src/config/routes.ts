import { z } from 'zod';
import { serviceUrlSchema } from '@rasta/config';

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
   * `appliesTo` narrows the override to the operations it is about, leaving
   * every other request under the prefix on the platform default. It exists
   * because `docs/06` § 6.9 limits *operations* — "۲۰ فایل در ساعت" is a cap on
   * uploading documents — while this table matches on a path prefix, so
   * without it an upload cap silently becomes a cap on listing and reading
   * too. Twenty requests an hour would make a documents screen unusable after
   * one page.
   *
   * - `'unsafe-methods'`: every method but `GET`, `HEAD` and `OPTIONS`.
   * - `'collection-post'`: `POST` to the prefix itself (`/v1/<prefix>`), nothing
   *   below it — the create of a collection whose other writes (a decision on
   *   one item, `/v1/<prefix>/<id>/approve`) are a different operation.
   * - omitted: every request under the prefix.
   *
   * The requests an override caps and the ones it does not count in separate
   * buckets (`rateLimitFor`): one sliding window serving two rules would let
   * either trim or fill the other.
   *
   * Method- and shape-awareness is not new knowledge for the gateway: it
   * already applies `requiresIdempotencyKey` to unsafe methods only. It still
   * knows nothing about the domain — only which requests create work (ADR-009).
   */
  rateLimit?: {
    limit: number;
    windowSeconds: number;
    appliesTo?: 'unsafe-methods' | 'collection-post';
  };
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
    // so it is the obvious target for flooding the review queue. The
    // submission only — `POST /v1/registration-requests` — whoever sends it.
    // The reviewer's queue reads and decisions under the same prefix
    // (`GET /v1/registration-requests`, `POST …/:id/approve`, `…/reject`) are
    // a different operation, on the platform default in a bucket of their own:
    // five an hour shared with the submission locked a reviewer out of the
    // queue after five page loads (task 130, PR #483 r1 R6).
    rateLimit: { limit: 5, windowSeconds: 3600, appliesTo: 'collection-post' },
  },
  { prefix: 'users', service: 'identity' },
  { prefix: 'memberships', service: 'identity' },
  { prefix: 'roles', service: 'identity' },
  // The audit correction command (ADR-053 § 7, AUD-003 correction). A top-level prefix
  // routed to identity-service, the command's owner: routing is by first
  // segment, and `audit-events` belongs to audit-service, which has no write
  // endpoint and never will. SYSTEM_ADMIN only, and an Idempotency-Key is
  // mandatory because a correction is irreversible; identity-service enforces
  // both again, and decides what may actually be corrected.
  {
    prefix: 'audit-corrections',
    service: 'identity',
    roles: ['SYSTEM_ADMIN'],
    requiresIdempotencyKey: true,
  },

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
  // Every unsafe method here adds a cost line, closes a bill or withdraws a
  // referral, and a form posted twice must be one of them: the key is required
  // (unsafe methods only; reads need none) and maintenance-service enforces it
  // again, storing the response with the write.
  { prefix: 'repair-orders', service: 'maintenance', requiresIdempotencyKey: true },

  // ---- commerce ----------------------------------------------------------
  // Search is read-heavy and cheap to abuse, so it carries the tighter limit
  // docs/06 § 6.9 sets for search rather than the default per-user one.
  // Creating a product and publishing or editing an offer need an
  // Idempotency-Key (docs/06 § 6.8 lists publishing an offer): a double submit
  // created two. Unsafe methods only, so search and reads need none, and
  // marketplace-service enforces it again, storing the response with the write.
  {
    prefix: 'products',
    service: 'marketplace',
    rateLimit: { limit: 60, windowSeconds: 60 },
    requiresIdempotencyKey: true,
  },
  { prefix: 'offers', service: 'marketplace', requiresIdempotencyKey: true },
  // `cart` is deferred, not removed (ADR-037 § 3): the prefix stays so the
  // routing table still reflects docs/04, and reaches a service that has no
  // handler for it — which answers 404, exactly what "not built yet" means.
  { prefix: 'cart', service: 'marketplace' },
  { prefix: 'orders', service: 'marketplace', requiresIdempotencyKey: true },
  // RUN-005 (ADR-048): a return request is asked, authorized, rejected or cancelled once; a
  // retried POST must not file two, so the key is required here and again by the service.
  { prefix: 'returns', service: 'marketplace', requiresIdempotencyKey: true },
  { prefix: 'demand-requests', service: 'procurement' },
  { prefix: 'aggregations', service: 'procurement' },
  { prefix: 'rfqs', service: 'procurement' },
  { prefix: 'purchase-orders', service: 'procurement', requiresIdempotencyKey: true },
  { prefix: 'suppliers', service: 'supplier' },
  // Every unsafe method of inventory-service creates a warehouse, moves stock or creates,
  // dispatches or delivers a shipment — an irreversible effect a retried POST must not repeat
  // (ADR-056 plan step 6). The key is required here (unsafe methods only) and again by the
  // service, which also keeps a key's effect once for good.
  { prefix: 'warehouses', service: 'inventory', requiresIdempotencyKey: true },
  { prefix: 'stock', service: 'inventory', requiresIdempotencyKey: true },
  { prefix: 'shipments', service: 'inventory', requiresIdempotencyKey: true },
  // RUN-005 (ADR-048): goods coming BACK. Not under `returns`, which is marketplace's request.
  { prefix: 'return-shipments', service: 'inventory', requiresIdempotencyKey: true },

  // ---- civil works -------------------------------------------------------
  { prefix: 'projects', service: 'construction' },
  { prefix: 'approvals', service: 'construction' },
  // Approval policies are configuration as data (ADR-023, ADR-063): the
  // authorities and thresholds a project's approvals come from.
  { prefix: 'approval-policies', service: 'construction' },
  { prefix: 'tenders', service: 'construction', requiresIdempotencyKey: true },
  // How a contractor finds a tender to bid on (CON-002 PR 6): the published tenders its
  // organization may bid on, public or invited, never its own. Read-only. construction-service
  // decides what is visible, and anything else answers 404 there (#223 F1).
  { prefix: 'open-tenders', service: 'construction' },
  // The owner's evaluation criteria templates (CON-002 PR 4a): versioned, never edited, scoped
  // to the caller's organization. A write takes the optional Idempotency-Key construction-service
  // honours; nothing here moves money or is irreversible, so the edge does not require one (#223 F1).
  { prefix: 'criteria-templates', service: 'construction' },
  // The approval policies a contract's employer is governed by (`contract.signature`, ADR-068 § 5).
  // `approval-policies` belongs to construction-service and routing is by first segment only, so
  // contract-service serves its own under a segment it alone owns. Same rules as construction's:
  // the service enforces authorization, validation, four-eyes approval and the Idempotency-Key.
  { prefix: 'contract-approval-policies', service: 'contract' },
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
  // screen of documents. In separate buckets: sharing one, a read trimmed the
  // window to its own minute and so wiped the hour of uploads (task 130).
  {
    prefix: 'documents',
    service: 'document',
    rateLimit: { limit: 20, windowSeconds: 3600, appliesTo: 'unsafe-methods' },
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

/** A request the gateway forwards under a deadline of its own, not `GATEWAY_UPSTREAM_TIMEOUT_MS`. */
export interface UpstreamDeadlineRoute {
  service: ServiceName;
  /** Upper-case HTTP method; `GET` also covers `HEAD` (see `TENDER_OPENING_ROUTES`). */
  method: string;
  /** The whole forwarded path (`/v1/...`, no query). */
  path: RegExp;
}

/**
 * The two requests that decrypt every standing bid of a tender in construction-service, under its
 * `CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS` (Codex r2 on #250, G1): opening the bids, and the owner's
 * read of every opened bid. They run under `GATEWAY_TENDER_OPEN_TIMEOUT_MS`; nothing else does — the
 * proposal, a single bid's read and every other route keep the default deadline. Data, like the
 * table above: the gateway learns which requests are slow, not why (ADR-009).
 *
 * Matched as the upstream's router matches them (Express 5, Codex r3 on #250, F2), or a request that
 * reaches the same handler would get the short deadline: the path **case-insensitively**
 * (`/OPEN-BIDS` is the opening), one optional trailing slash, and `HEAD` as `GET` (Express runs the
 * GET handler for it, the full read included). Percent-encoded letters (`open%2Dbids`) and doubled
 * slashes reach no handler upstream, so they keep the default.
 */
export const TENDER_OPENING_ROUTES: readonly UpstreamDeadlineRoute[] = [
  { service: 'construction', method: 'POST', path: /^\/v1\/tenders\/[^/]+\/open-bids\/?$/i },
  { service: 'construction', method: 'GET', path: /^\/v1\/tenders\/[^/]+\/bids\/?$/i },
];

/** The method a deadline route is matched under: the upstream answers `HEAD` with its GET handler. */
export function deadlineMethodOf(method: string): string {
  const upper = method.toUpperCase();
  return upper === 'HEAD' ? 'GET' : upper;
}

/** Longest-prefix match, so `orders` never shadows a longer sibling. */
export function resolveRoute(path: string): RouteRule | undefined {
  const segment = path.replace(/^\/+/, '').split('/')[0];
  if (!segment) return undefined;

  return ROUTES.find((route) => route.prefix === segment);
}

export const serviceUrlEnvSchema = z.object({
  IDENTITY_SERVICE_URL: serviceUrlSchema,
  ORGANIZATION_SERVICE_URL: serviceUrlSchema,
  ASSET_SERVICE_URL: serviceUrlSchema,
  FLEET_SERVICE_URL: serviceUrlSchema,
  MAINTENANCE_SERVICE_URL: serviceUrlSchema,
  MARKETPLACE_SERVICE_URL: serviceUrlSchema,
  PROCUREMENT_SERVICE_URL: serviceUrlSchema,
  SUPPLIER_SERVICE_URL: serviceUrlSchema,
  INVENTORY_SERVICE_URL: serviceUrlSchema,
  CONSTRUCTION_SERVICE_URL: serviceUrlSchema,
  CONTRACT_SERVICE_URL: serviceUrlSchema,
  ECONOMIC_SERVICE_URL: serviceUrlSchema,
  NOTIFICATION_SERVICE_URL: serviceUrlSchema,
  DOCUMENT_SERVICE_URL: serviceUrlSchema,
  AUDIT_SERVICE_URL: serviceUrlSchema,
  ANALYTICS_SERVICE_URL: serviceUrlSchema,
});

export type ServiceUrls = z.infer<typeof serviceUrlEnvSchema>;

export function serviceUrl(urls: ServiceUrls, service: ServiceName): string {
  const key = `${service.toUpperCase()}_SERVICE_URL` as keyof ServiceUrls;
  return urls[key];
}
