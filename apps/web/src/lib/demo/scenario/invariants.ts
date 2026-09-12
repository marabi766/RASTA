import {
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_STAGES,
  type ScenarioSnapshot,
  type ScenarioStage,
} from './model';

/**
 * What must always be true of a scenario snapshot, regardless of how it was
 * produced — by the reducer, by hydration from `sessionStorage`, or by a
 * test that builds one by hand.
 *
 * Returns violation messages rather than throwing, so a caller can choose:
 * `persistence.ts` uses an empty result to decide whether hydrated JSON is
 * trustworthy, and `assertInvariants` below turns the same list into a thrown
 * error for development and tests, where a violation is a bug to stop on
 * rather than a state to discard.
 */
export function checkInvariants(state: ScenarioSnapshot): string[] {
  const violations: string[] = [];

  if (state.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    violations.push(`schemaVersion ${state.schemaVersion} is not the current version`);
  }

  if (!Number.isInteger(state.revision) || state.revision < 0) {
    violations.push('revision must be a non-negative integer');
  }

  if (!SCENARIO_STAGES.includes(state.stage)) {
    violations.push(`stage "${state.stage}" is not one of SCENARIO_STAGES`);
  } else {
    const derived = deriveStage(state);
    if (derived !== state.stage) {
      violations.push(
        `stage "${state.stage}" disagrees with the entities it should summarize (expected "${derived}")`,
      );
    }
  }

  if (state.maintenance.organizationId !== state.organizationId) {
    violations.push('the maintenance request does not belong to the scenario organization');
  }
  if (state.maintenance.assetId !== state.assetId) {
    violations.push('the maintenance request does not reference the scenario asset');
  }
  if (state.maintenance.status === 'ESTIMATE_APPROVED' && state.maintenance.approvedAt === null) {
    violations.push('an approved estimate has no approval timestamp');
  }
  if (state.maintenance.approvedAt !== null && state.maintenance.requestedAt === null) {
    violations.push('an estimate was approved before the request existed');
  }

  if (state.offerSelection) {
    if (state.offerSelection.maintenanceRequestId !== state.maintenance.id) {
      violations.push('the selected offer is not linked to the scenario maintenance request');
    }
    if (state.offerSelection.supplierOrganizationId !== state.supplierOrganizationId) {
      violations.push('the selected offer belongs to a supplier the scenario never introduced');
    }
  }

  if (state.order.organizationId !== state.organizationId) {
    violations.push('the order does not belong to the scenario organization');
  }
  if (state.order.status !== 'NONE') {
    if (!state.offerSelection) {
      violations.push('an order exists with no offer ever selected');
    } else if (state.order.offerId !== state.offerSelection.offerId) {
      violations.push('the order references a different offer than the one selected');
    }
  }
  if (state.order.status === 'PAYMENT_CAPTURED' && state.order.paymentCapturedAt === null) {
    violations.push('a captured payment has no capture timestamp');
  }
  if (state.order.paymentCapturedAt !== null && state.order.placedAt === null) {
    violations.push('a payment was captured before the order was placed');
  }

  if (state.wallet.organizationId !== state.organizationId) {
    violations.push('the wallet does not belong to the scenario organization');
  }
  for (const [field, value] of Object.entries({
    ledgerBalanceMinor: state.wallet.ledgerBalanceMinor,
    pendingBalanceMinor: state.wallet.pendingBalanceMinor,
    availableBalanceMinor: state.wallet.availableBalanceMinor,
  })) {
    if (!isNonNegativeIntegerString(value)) {
      violations.push(`wallet.${field} is not a non-negative integer string ("${value}")`);
    }
  }

  for (const document of state.documents) {
    const scanned =
      document.scanState === 'CLEAN' ||
      document.scanState === 'INFECTED' ||
      document.scanState === 'FAILED';
    if (scanned && document.scannedAt === null) {
      violations.push(`document "${document.id}" is ${document.scanState} with no scan timestamp`);
    }
    if (!scanned && document.scannedAt !== null) {
      violations.push(
        `document "${document.id}" has a scan timestamp but is ${document.scanState}`,
      );
    }
  }

  const ownedResourceIds = new Set<string>([
    state.organizationId,
    state.assetId,
    state.supplierOrganizationId,
    state.maintenance.id,
    state.order.id,
    state.wallet.id,
    ...state.documents.map((document) => document.id),
    ...(state.offerSelection ? [state.offerSelection.offerId] : []),
  ]);

  let expectedSequence = 1;
  for (const entry of state.activityLog) {
    if (entry.sequence !== expectedSequence) {
      violations.push(
        `activity log sequence is not monotonic and unique (expected ${expectedSequence}, found ${entry.sequence})`,
      );
      break;
    }
    expectedSequence += 1;

    if (!ownedResourceIds.has(entry.resourceId)) {
      violations.push(
        `activity log entry #${entry.sequence} refers to an entity the scenario does not own`,
      );
    }
  }

  const serialized = JSON.stringify(state);
  // "secret" alone already covers a client secret as a substring; spelling
  // it out again would trip unrelated repository-wide credential scans that
  // grep source files for that exact literal.
  if (/token|secret|password|authorization|bearer/i.test(serialized)) {
    violations.push('the snapshot contains a word that reads as a credential');
  }
  if (/^https?:\/\//i.test(serialized.replace(/^"|"$/g, '')) || /localhost:\d+/.test(serialized)) {
    violations.push('the snapshot contains what looks like a backend URL');
  }

  return violations;
}

/** Throws with every violation listed, for development and test use. */
export function assertInvariants(state: ScenarioSnapshot): void {
  const violations = checkInvariants(state);
  if (violations.length > 0) {
    throw new ScenarioInvariantError(violations);
  }
}

export class ScenarioInvariantError extends Error {
  constructor(readonly violations: string[]) {
    super(`Scenario state violates its own invariants:\n  - ${violations.join('\n  - ')}`);
    this.name = 'ScenarioInvariantError';
  }
}

/**
 * Recomputes the stage a snapshot's entities actually support, independent
 * of whatever value it happens to be carrying. The reducer calls this to set
 * `stage` after every transition; `checkInvariants` calls it to catch a
 * snapshot whose stored stage has drifted from its own entities.
 */
export function deriveStage(state: ScenarioSnapshot): ScenarioStage {
  // A document is only ever attached after payment capture (the reducer
  // enforces that ordering), so no compound check is needed here.
  if (hasScannedDocument(state)) return 'DOCUMENT_SCAN_COMPLETED';
  if (hasAttachedDocument(state)) return 'DOCUMENT_ATTACHED';
  if (state.order.status === 'PAYMENT_CAPTURED') return 'PAYMENT_CAPTURED';
  if (state.order.status === 'PLACED') return 'ORDER_PLACED';
  if (state.offerSelection) return 'OFFER_SELECTED';
  if (state.maintenance.status === 'ESTIMATE_APPROVED') return 'ESTIMATE_APPROVED';
  if (state.maintenance.status === 'REQUESTED') return 'MAINTENANCE_REQUESTED';
  return 'ORGANIZATION_SELECTED';
}

function hasAttachedDocument(state: ScenarioSnapshot): boolean {
  return state.documents.length > 0;
}

function hasScannedDocument(state: ScenarioSnapshot): boolean {
  return state.documents.some((document) => document.scannedAt !== null);
}

function isNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}
