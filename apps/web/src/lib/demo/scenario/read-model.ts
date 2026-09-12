import type { ScenarioSnapshot } from './model';

/**
 * Pure projectors from a scenario snapshot onto the shape a fixture GET
 * response already has.
 *
 * Deliberately ignorant of `fixtures.ts`. Each function takes the *existing*
 * static object as `base` and returns a new object with only the fields the
 * scenario actually changes overridden — everything else passes through
 * untouched, which is what keeps "every existing static fixture response
 * stays byte-identical while the scenario is still at its initial state"
 * true without this module needing to know what the full real shape is.
 *
 * `fixture-client.ts` is the only place that wires a real base object and a
 * live snapshot together; that keeps this module trivially unit-testable
 * with a synthetic `base` and keeps `fixtures.ts` reachable from exactly the
 * one module the existing architecture test already pins down.
 */

type FixtureRecord = Record<string, unknown>;

export function projectMaintenanceRequestDetail(
  base: FixtureRecord,
  snapshot: ScenarioSnapshot,
): FixtureRecord {
  const { maintenance } = snapshot;
  if (maintenance.status === 'NONE') return base;

  return {
    ...base,
    status: maintenance.status === 'ESTIMATE_APPROVED' ? 'APPROVED' : base.status,
    title: maintenance.title ?? base.title,
    reportedAt: maintenance.requestedAt ?? base.reportedAt,
    approvedAt: maintenance.approvedAt,
    approvedBy: maintenance.approvedAt ? 'usr_demo_presenter' : null,
    totalCostMinor: maintenance.estimateAmountMinor ?? base.totalCostMinor,
  };
}

export function projectOrder(base: FixtureRecord, snapshot: ScenarioSnapshot): FixtureRecord {
  const { order } = snapshot;
  if (order.status === 'NONE') return base;

  return {
    ...base,
    status: order.status === 'PAYMENT_CAPTURED' ? 'FUNDS_HELD' : 'CREATED',
    totalAmountMinor: order.totalAmountMinor ?? base.totalAmountMinor,
    createdAt: order.placedAt ?? base.createdAt,
  };
}

export function projectOrdersPage(base: FixtureRecord, snapshot: ScenarioSnapshot): FixtureRecord {
  const items = Array.isArray(base.items) ? base.items : [];
  return {
    ...base,
    items: items.map((item) =>
      isRecord(item) && item.id === snapshot.order.id ? projectOrder(item, snapshot) : item,
    ),
  };
}

export function projectWallet(base: FixtureRecord, snapshot: ScenarioSnapshot): FixtureRecord {
  const { wallet } = snapshot;
  return {
    ...base,
    ledgerBalanceMinor: wallet.ledgerBalanceMinor,
    pendingBalanceMinor: wallet.pendingBalanceMinor,
    availableBalanceMinor: wallet.availableBalanceMinor,
  };
}

export function projectDocumentsPage(
  base: FixtureRecord,
  snapshot: ScenarioSnapshot,
): FixtureRecord {
  if (snapshot.documents.length === 0) return base;

  const existing = Array.isArray(base.items) ? base.items : [];
  const scenarioDocuments = snapshot.documents.map((document) => ({
    id: document.id,
    organizationId: snapshot.organizationId,
    documentClass: 'OTHER',
    status: 'REGISTERED',
    contentType: 'application/pdf',
    sizeBytes: 1,
    filename: document.filename,
    scanState: document.scanState,
    scanInspectedContent: document.scanState === 'CLEAN' || document.scanState === 'INFECTED',
    scanEngine:
      document.scanState === 'PENDING' || document.scanState === 'NOT_SCANNED' ? null : 'clamav',
    scanSignatureVersion: document.scanState === 'CLEAN' ? '27142' : null,
    scanSignature: null,
    scanFailureReason: document.scanState === 'FAILED' ? 'SCAN_ENGINE_ERROR' : null,
    quarantinedAt: null,
    scannedAt: document.scannedAt,
    ownerResourceType: document.ownerResourceType,
    ownerResourceId: document.ownerResourceId,
    createdAt: document.attachedAt,
    createdBy: 'usr_demo_presenter',
    deletedAt: null,
    deletionReason: null,
  }));

  return { ...base, items: [...scenarioDocuments, ...existing] };
}

/**
 * Appends one audit-event-shaped record per activity-log entry, newest
 * first — matching `GET /v1/audit-events`'s own documented order
 * (`occurredAt DESC`).
 *
 * The shape mirrors `auditEventViewSchema` (`lib/api/adapters/audit.ts`)
 * field for field, so a record this projector builds passes the exact same
 * validation a real response would have to.
 */
export function projectAuditEventsPage(
  base: FixtureRecord,
  snapshot: ScenarioSnapshot,
): FixtureRecord {
  if (snapshot.activityLog.length === 0) return base;

  const existing = Array.isArray(base.items) ? base.items : [];
  const scenarioEvents = [...snapshot.activityLog].reverse().map((entry) => ({
    id: `aev_demo_scenario_${entry.sequence}`,
    occurredAt: entry.occurredAt,
    recordedAt: entry.occurredAt,
    actorType: 'USER',
    actorId: 'usr_demo_presenter',
    actorRoles: [],
    organizationId: snapshot.organizationId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    outcome: 'SUCCESS',
    errorCode: null,
    reason: null,
    changes: null,
    occurrenceCount: 1,
    sourceService: 'scenario-engine',
    sourceServiceVersion: null,
    sourceEventId: `evt_demo_scenario_${entry.sequence}`,
    sourceEventName: entry.action.toUpperCase(),
    sourceTopic: 'rasta.demo.scenario.v1',
    sourceIp: null,
    sourceUserAgent: null,
    correlationId: `cid_demo_scenario_${entry.sequence}`,
    causationId: null,
    traceparent: null,
    sourceStreamSeq: null,
    sequenceNo: String(entry.sequence),
    integrity: 'UNCHAINED',
  }));

  return { ...base, items: [...scenarioEvents, ...existing] };
}

function isRecord(value: unknown): value is FixtureRecord {
  return typeof value === 'object' && value !== null;
}
