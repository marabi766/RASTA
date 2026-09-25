import { Counter, registry } from '@rasta/observability';

/**
 * Metrics owned by asset-service.
 *
 * The platform-wide ones (HTTP, outbox, DLQ, event processing) are defined in
 * `@rasta/observability` and are not duplicated here. No label is unbounded:
 * nothing is labelled by asset or organization.
 */

/**
 * Events the timeline consumer could not attach to a dossier, and why
 * (PR #108 review #1).
 *
 * `reason` is a closed set:
 *   - `owner_changed`: the asset exists but belongs to another organization
 *     than the event's tenant. The event was published by the previous owner's
 *     side and consumed after a transfer (an assignment or repair that
 *     overtook the transfer). Its status consequence and dossier entry are
 *     not applied. Worth an alert: docs/23 records this as a known risk.
 *   - `asset_unknown`: no asset by that id at all.
 */
export const timelineEventsSkippedTotal = new Counter({
  name: 'rasta_asset_timeline_events_skipped_total',
  help: 'Events the timeline consumer did not attach to a dossier, by reason',
  labelNames: ['service', 'event', 'reason'] as const,
  registers: [registry],
});
