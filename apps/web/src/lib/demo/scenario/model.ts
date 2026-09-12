/**
 * The interactive fixture scenario — types only.
 *
 * ## What this engine is, and what it deliberately is not
 *
 * A small, deterministic state machine that lives entirely inside the
 * browser tab, for presentation mode only. It does not call `fetch`, does
 * not know about `GatewayClient`, and has no opinion about HTTP — the
 * "commands" below are internal simulation events, not requests. Phase C
 * wires UI controls to `dispatch` them; this phase proves the machine itself
 * is correct and that `FixtureGatewayClient` can read through it.
 *
 * ## Why the state is this shape
 *
 * Every identifier is one of the five canonical ids in `../entry-points.ts`
 * (plus the supplier/offer/wallet ids added alongside them for this engine) —
 * never a second, parallel dataset. The reducer in `reducer.ts` refuses any
 * action that names an id other than these, which is what "no cross-tenant
 * reference" means for a fixed single-path demo rather than a free-form
 * sandbox.
 */

export const SCENARIO_SCHEMA_VERSION = 1;

/**
 * The furthest milestone the scenario has reached, in story order.
 *
 * Stored rather than only computed, because the task that commissioned this
 * engine wants it displayed — but it is never allowed to drift from the
 * entities it summarizes: `deriveStage` in `invariants.ts` recomputes it from
 * the rest of the snapshot, and a mismatch is an invariant violation, not a
 * silent inconsistency.
 */
export const SCENARIO_STAGES = [
  'ORGANIZATION_SELECTED',
  'MAINTENANCE_REQUESTED',
  'ESTIMATE_APPROVED',
  'OFFER_SELECTED',
  'ORDER_PLACED',
  'PAYMENT_CAPTURED',
  'DOCUMENT_ATTACHED',
  'DOCUMENT_SCAN_COMPLETED',
] as const;

export type ScenarioStage = (typeof SCENARIO_STAGES)[number];

/**
 * Which real platform role the presenter is narrating as.
 *
 * Reuses `DEMO_IDENTITY.roles` (`../mode.ts`) rather than inventing labels —
 * a persona here is "which of this session's own real roles to narrate
 * from", not a fourth, fictional role.
 */
export const PRESENTATION_PERSONAS = [
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
  'PROCUREMENT_USER',
] as const;

export type PresentationPersona = (typeof PRESENTATION_PERSONAS)[number];

/** Mirrors the real document fixture's scan states (`../fixtures.ts`). */
export const SCENARIO_DOCUMENT_SCAN_STATES = [
  'PENDING',
  'NOT_SCANNED',
  'CLEAN',
  'INFECTED',
  'FAILED',
] as const;

export type ScenarioDocumentScanState = (typeof SCENARIO_DOCUMENT_SCAN_STATES)[number];

export interface ScenarioMaintenanceState {
  readonly id: string;
  readonly assetId: string;
  readonly organizationId: string;
  readonly status: 'NONE' | 'REQUESTED' | 'ESTIMATE_APPROVED';
  readonly title: string | null;
  readonly estimateAmountMinor: string | null;
  readonly requestedAt: string | null;
  readonly approvedAt: string | null;
}

export interface ScenarioOfferSelection {
  readonly maintenanceRequestId: string;
  readonly supplierOrganizationId: string;
  readonly offerId: string;
  readonly unitPriceMinor: string;
  readonly selectedAt: string;
}

export interface ScenarioOrderState {
  readonly id: string;
  readonly organizationId: string;
  readonly offerId: string | null;
  readonly totalAmountMinor: string | null;
  readonly status: 'NONE' | 'PLACED' | 'PAYMENT_CAPTURED';
  readonly placedAt: string | null;
  readonly paymentCapturedAt: string | null;
}

export interface ScenarioWalletState {
  readonly id: string;
  readonly organizationId: string;
  readonly ledgerBalanceMinor: string;
  readonly pendingBalanceMinor: string;
  readonly availableBalanceMinor: string;
}

export interface ScenarioDocumentState {
  readonly id: string;
  readonly ownerResourceType: string;
  readonly ownerResourceId: string;
  readonly filename: string;
  readonly scanState: ScenarioDocumentScanState;
  readonly attachedAt: string;
  readonly scannedAt: string | null;
}

export interface ScenarioActivityLogEntry {
  /** 1-based, strictly increasing, unique within one scenario lifetime. */
  readonly sequence: number;
  readonly occurredAt: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  /** Persian, one sentence — what a presenter would say happened. */
  readonly summary: string;
}

export interface ScenarioSnapshot {
  readonly schemaVersion: number;
  readonly scenarioId: string;
  /** Advances by exactly one on every successfully applied action. */
  readonly revision: number;
  /** The scenario's own logical clock — never `Date.now()`. See `clock.ts`. */
  readonly clock: string;
  readonly stage: ScenarioStage;
  readonly persona: PresentationPersona;
  readonly organizationId: string;
  readonly assetId: string;
  readonly supplierOrganizationId: string;
  readonly maintenance: ScenarioMaintenanceState;
  readonly offerSelection: ScenarioOfferSelection | null;
  readonly order: ScenarioOrderState;
  readonly wallet: ScenarioWalletState;
  readonly documents: readonly ScenarioDocumentState[];
  readonly activityLog: readonly ScenarioActivityLogEntry[];
}

// ---------------------------------------------------------------------------
// The closed command contract
// ---------------------------------------------------------------------------

export interface ScenarioResetAction {
  readonly type: 'SCENARIO_RESET';
}

export interface PersonaSelectedAction {
  readonly type: 'PERSONA_SELECTED';
  readonly persona: PresentationPersona;
}

export interface MaintenanceRequestCreatedAction {
  readonly type: 'MAINTENANCE_REQUEST_CREATED';
  readonly maintenanceRequestId: string;
  readonly assetId: string;
  readonly organizationId: string;
  readonly title: string;
}

export interface MaintenanceEstimateApprovedAction {
  readonly type: 'MAINTENANCE_ESTIMATE_APPROVED';
  readonly maintenanceRequestId: string;
  readonly estimateAmountMinor: string;
}

export interface SupplierOfferSelectedAction {
  readonly type: 'SUPPLIER_OFFER_SELECTED';
  readonly maintenanceRequestId: string;
  readonly supplierOrganizationId: string;
  readonly offerId: string;
  readonly unitPriceMinor: string;
}

export interface OrderPlacedAction {
  readonly type: 'ORDER_PLACED';
  readonly orderId: string;
  readonly offerId: string;
  readonly totalAmountMinor: string;
}

export interface PaymentCapturedAction {
  readonly type: 'PAYMENT_CAPTURED';
  readonly orderId: string;
  readonly amountMinor: string;
}

export interface DocumentAttachedAction {
  readonly type: 'DOCUMENT_ATTACHED';
  readonly documentId: string;
  readonly ownerResourceType: string;
  readonly ownerResourceId: string;
  readonly filename: string;
}

export interface DocumentScanCompletedAction {
  readonly type: 'DOCUMENT_SCAN_COMPLETED';
  readonly documentId: string;
  readonly scanState: ScenarioDocumentScanState;
}

export interface AuditRecordAppendedAction {
  readonly type: 'AUDIT_RECORD_APPENDED';
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly summary: string;
}

export type ScenarioAction =
  | ScenarioResetAction
  | PersonaSelectedAction
  | MaintenanceRequestCreatedAction
  | MaintenanceEstimateApprovedAction
  | SupplierOfferSelectedAction
  | OrderPlacedAction
  | PaymentCapturedAction
  | DocumentAttachedAction
  | DocumentScanCompletedAction
  | AuditRecordAppendedAction;

export type ScenarioActionType = ScenarioAction['type'];

/** Every reason a dispatch can be refused. A closed set, never a free string. */
export const SCENARIO_REJECTION_REASONS = [
  'UNKNOWN_ACTION',
  'MALFORMED_ACTION',
  'CROSS_ORGANIZATION_REFERENCE',
  'UNKNOWN_REFERENCE',
  'INVALID_TRANSITION',
  'INSUFFICIENT_WALLET_BALANCE',
] as const;

export type ScenarioRejectionReason = (typeof SCENARIO_REJECTION_REASONS)[number];

export interface ScenarioDispatchResult {
  readonly state: ScenarioSnapshot;
  readonly outcome: 'APPLIED' | 'REJECTED';
  readonly reason?: ScenarioRejectionReason;
  readonly message?: string;
}
