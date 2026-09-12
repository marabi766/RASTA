import { capabilityByKey, type Capability } from '../capabilities';
import { FIXTURE_ENTRY_POINTS } from './entry-points';

/**
 * The guided tour's itinerary.
 *
 * ## Why a stop carries narration and nothing else
 *
 * A stop names a `capabilityKey` and stops there. The destination, the title
 * and — most importantly — the `LIVE`/`BETA`/`PLANNED` badge are all resolved
 * from the capability registry at render time. Copying any of them here would
 * create a second place where a capability's status is stated, and the second
 * place is always the one that goes stale: a tour still telling an audience
 * that something is live after the manifest stopped saying so is the worst
 * possible location for that inconsistency to surface.
 *
 * So this file owns an ordering and nothing else. The narration lives in
 * `tour-narration.ts`, which the overlay loads only once a tour is running —
 * this module is in the portal layout's shared chunk, and several kilobytes of
 * presenter prose has no business in the initial download of a screen that
 * never shows it.
 */
export interface TourStop {
  readonly id: string;
  /** Resolved against the capability registry. Never a hard-coded href. */
  readonly capabilityKey: string;
  /**
   * A deeper link, valid only when the presentation dataset is loaded.
   *
   * A live tenant has no record with a known id, so a deep link would 404 on
   * every deployment but this one. In live mode the stop lands on the list
   * screen instead, which is always a real destination.
   */
  readonly fixtureHref?: string;
}

export const TOUR_STOPS: readonly TourStop[] = [
  { id: 'platform', capabilityKey: 'organizations' },
  { id: 'assets', capabilityKey: 'assets', fixtureHref: `/assets/${FIXTURE_ENTRY_POINTS.assetId}` },
  { id: 'fleet', capabilityKey: 'fleet' },
  {
    id: 'maintenance',
    capabilityKey: 'maintenance',
    fixtureHref: `/maintenance/${FIXTURE_ENTRY_POINTS.maintenanceRequestId}`,
  },
  {
    id: 'marketplace',
    capabilityKey: 'marketplace',
    fixtureHref: `/marketplace/${FIXTURE_ENTRY_POINTS.productId}`,
  },
  { id: 'orders', capabilityKey: 'orders', fixtureHref: `/orders/${FIXTURE_ENTRY_POINTS.orderId}` },
  { id: 'wallet', capabilityKey: 'wallet' },
  { id: 'ledger', capabilityKey: 'ledger' },
  { id: 'documents', capabilityKey: 'documents' },
  { id: 'suppliers', capabilityKey: 'suppliers' },
  {
    id: 'audit',
    capabilityKey: 'audit',
    fixtureHref: `/audit/${FIXTURE_ENTRY_POINTS.auditEventId}`,
  },
  { id: 'not-built', capabilityKey: 'procurement' },
];

export interface ResolvedTourStop extends TourStop {
  readonly capability: Capability;
  /** Where this stop actually goes, given the active data mode. */
  readonly href: string;
}

export class TourItineraryError extends Error {
  constructor(readonly violations: string[]) {
    super(
      `The guided tour points somewhere that does not exist:\n  - ${violations.join('\n  - ')}`,
    );
    this.name = 'TourItineraryError';
  }
}

/**
 * Joins the itinerary to the capability registry.
 *
 * Throws rather than skipping an unresolvable stop. A tour that silently
 * dropped a stop would renumber every step after it, and "step 4 of 11" would
 * quietly become a different screen than the presenter rehearsed.
 */
export function resolveTourStops(
  fixtureMode: boolean,
  stops: readonly TourStop[] = TOUR_STOPS,
): ResolvedTourStop[] {
  const violations: string[] = [];
  const resolved: ResolvedTourStop[] = [];

  for (const stop of stops) {
    const capability = capabilityByKey(stop.capabilityKey);

    if (!capability) {
      violations.push(`stop "${stop.id}" names unknown capability "${stop.capabilityKey}"`);
      continue;
    }

    resolved.push({
      ...stop,
      capability,
      href: fixtureMode && stop.fixtureHref ? stop.fixtureHref : capability.href,
    });
  }

  if (violations.length > 0) throw new TourItineraryError(violations);

  return resolved;
}
