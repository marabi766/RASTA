import { Counter, Gauge, registry } from '@rasta/observability';

/**
 * The revocation list's own series (addendum § 8). No label names a user or
 * an organization — the list is about exactly those, and a label per pair is
 * a series per pair.
 */

export const REVOCATION_REFUSAL_REASONS = {
  /** Issued before the pair's latest cutoff. */
  REVOKED: 'revoked',
  /** Issued after it, still carrying a role taken away. */
  STALE_ROLES: 'stale_roles',
  /** The list cannot be vouched for: not caught up, stopped, or holding every pair. */
  UNAVAILABLE: 'unavailable',
  /** No usable `iat`, an `iat` in the future, or a lifetime above the supported one. */
  TOKEN_UNEVALUABLE: 'token_unevaluable',
  /** A tenant-scoped user token without the platform id the list is keyed by. */
  UNBOUND_IDENTITY: 'unbound_identity',
} as const;
export type RevocationRefusalReason =
  (typeof REVOCATION_REFUSAL_REASONS)[keyof typeof REVOCATION_REFUSAL_REASONS];

export const revocationRefusalsTotal = new Counter({
  name: 'rasta_gateway_revocation_refusals_total',
  help: 'Requests the gateway refused on its revocation list before forwarding, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

/** Read at scrape time from whatever `observeRevocationList` was last handed. */
let observed:
  | {
      size: () => number;
      stalenessSeconds: () => number | undefined;
      lag: () => number | undefined;
    }
  | undefined;

export function observeRevocationList(source: typeof observed): void {
  observed = source;
}

export const revocationListEntries = new Gauge({
  name: 'rasta_gateway_revocation_list_entries',
  help: 'Pairs the revocation list holds state for',
  registers: [registry],
  collect() {
    if (observed) this.set(observed.size());
  },
});

export const revocationFeedStalenessSeconds = new Gauge({
  name: 'rasta_gateway_revocation_feed_staleness_seconds',
  help: 'Seconds since the revocation list was last shown caught up with the identity topic; -1 before the first time',
  registers: [registry],
  collect() {
    if (observed) this.set(observed.stalenessSeconds() ?? -1);
  },
});

export const revocationFeedLagRecords = new Gauge({
  name: 'rasta_gateway_revocation_feed_lag_records',
  help: 'Identity topic records not yet read, against the latest high watermarks read; -1 when unknown',
  registers: [registry],
  collect() {
    if (!observed) return;
    const lag = observed.lag();
    this.set(lag === undefined || !Number.isFinite(lag) ? -1 : lag);
  },
});
