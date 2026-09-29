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

/**
 * What each owner of a machine's work answered when a transfer asked it
 * (ADR-062, docs/23 D-033).
 *
 * `owner` is `fleet-service` or `maintenance-service`. `outcome` is a closed
 * set:
 *   - `clear`: nothing open; the owner fenced the machine.
 *   - `open_work`: the owner has open work; the transfer was refused.
 *   - `conflict`: another transfer holds the fence, or the owner's replica
 *     does not yet place the machine with this organization.
 *   - `unavailable`: no usable answer (transport, timeout, 403, 5xx, a body
 *     that does not parse). The transfer was refused. Worth an alert: every
 *     transfer fails while it lasts.
 */
export const transferClearanceTotal = new Counter({
  name: 'rasta_asset_transfer_clearance_total',
  help: 'Answers from the owners of a machine’s work to a transfer’s clearance question',
  labelNames: ['service', 'owner', 'outcome'] as const,
  registers: [registry],
});

/**
 * Events older than the state already applied, whose status change was
 * skipped: a replay from `<topic>.retry` after a newer event (D-039). Their
 * dossier entry is still written. `event` is the closed set of projected names.
 */
export const staleStateEventsTotal = new Counter({
  name: 'rasta_asset_stale_state_events_total',
  help: 'Events whose status change was skipped because a newer event had already set the state',
  labelNames: ['service', 'event'] as const,
  registers: [registry],
});
