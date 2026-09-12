import { FIXTURE_ENTRY_POINTS } from '../entry-points';
import { buildInitialScenarioState } from './initial-state';
import { checkInvariants } from './invariants';
import type { ScenarioAction, ScenarioSnapshot } from './model';
import { reduceScenario } from './reducer';

/**
 * The reducer is the one place every transition is decided, so this file
 * proves its contract directly rather than through the UI: every successful
 * action advances revision by exactly one, every rejected one leaves the
 * exact same object, and the story's ordering constraints hold even when an
 * action is dispatched out of order on purpose.
 */

const ORG = FIXTURE_ENTRY_POINTS.organizationId;
const ASSET = FIXTURE_ENTRY_POINTS.assetId;
const SUPPLIER = FIXTURE_ENTRY_POINTS.supplierOrganizationId;
const OFFER = FIXTURE_ENTRY_POINTS.offerId;

function apply(state: ScenarioSnapshot, action: ScenarioAction): ScenarioSnapshot {
  const result = reduceScenario(state, action);
  expect(result.outcome).toBe('APPLIED');
  return result.state;
}

function maintenanceRequestId(state: ScenarioSnapshot): string {
  return state.maintenance.id;
}

function orderId(state: ScenarioSnapshot): string {
  return state.order.id;
}

describe('initial state', () => {
  it('is deterministic across calls', () => {
    expect(buildInitialScenarioState()).toEqual(buildInitialScenarioState());
  });

  it('satisfies its own invariants', () => {
    expect(checkInvariants(buildInitialScenarioState())).toEqual([]);
  });

  it('starts at revision 0 and stage ORGANIZATION_SELECTED', () => {
    const state = buildInitialScenarioState();
    expect(state.revision).toBe(0);
    expect(state.stage).toBe('ORGANIZATION_SELECTED');
    expect(state.activityLog).toEqual([]);
  });
});

describe('revision and log bookkeeping', () => {
  it('advances revision by exactly one on every applied action', () => {
    let state = buildInitialScenarioState();
    state = apply(state, { type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    expect(state.revision).toBe(1);
    state = apply(state, { type: 'PERSONA_SELECTED', persona: 'PROCUREMENT_USER' });
    expect(state.revision).toBe(2);
  });

  it('appends exactly one append-only log entry per applied action, sequence starting at 1', () => {
    let state = buildInitialScenarioState();
    state = apply(state, { type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    expect(state.activityLog).toHaveLength(1);
    expect(state.activityLog[0]?.sequence).toBe(1);

    state = apply(state, { type: 'PERSONA_SELECTED', persona: 'ORGANIZATION_ADMIN' });
    expect(state.activityLog).toHaveLength(2);
    expect(state.activityLog[1]?.sequence).toBe(2);
    // Append-only: the first entry is still exactly what it was.
    expect(state.activityLog[0]?.sequence).toBe(1);
  });

  it('does not advance the clock with the wall clock', () => {
    const a = buildInitialScenarioState();
    const b = apply(a, { type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    // Two calls, however far apart in real time, produce the same delta.
    expect(Date.parse(b.clock) - Date.parse(a.clock)).toBe(15 * 60_000);
  });
});

describe('a rejected transition leaves state untouched', () => {
  it('returns the exact same object reference, not a clone', () => {
    const state = buildInitialScenarioState();
    const result = reduceScenario(state, {
      type: 'MAINTENANCE_ESTIMATE_APPROVED',
      maintenanceRequestId: maintenanceRequestId(state),
      estimateAmountMinor: '1000',
    });

    expect(result.outcome).toBe('REJECTED');
    expect(result.state).toBe(state);
  });

  it('reports a deterministic reason', () => {
    const state = buildInitialScenarioState();
    const result = reduceScenario(state, {
      type: 'MAINTENANCE_ESTIMATE_APPROVED',
      maintenanceRequestId: maintenanceRequestId(state),
      estimateAmountMinor: '1000',
    });
    expect(result.reason).toBe('INVALID_TRANSITION');
  });
});

describe('unknown and malformed actions', () => {
  it('refuses an action naming an identifier outside the scenario', () => {
    const state = buildInitialScenarioState();
    const result = reduceScenario(state, {
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: maintenanceRequestId(state),
      assetId: 'ast_not_in_this_scenario',
      organizationId: ORG,
      title: 'x',
    });
    expect(result.outcome).toBe('REJECTED');
    expect(result.reason).toBe('UNKNOWN_REFERENCE');
    expect(result.state).toBe(state);
  });

  it('refuses a cross-organization reference', () => {
    const state = buildInitialScenarioState();
    const result = reduceScenario(state, {
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: maintenanceRequestId(state),
      assetId: ASSET,
      organizationId: 'org_not_the_scenario_org',
      title: 'x',
    });
    expect(result.reason).toBe('CROSS_ORGANIZATION_REFERENCE');
  });

  it('refuses a negative-looking amount', () => {
    let state = buildInitialScenarioState();
    state = apply(state, {
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: maintenanceRequestId(state),
      assetId: ASSET,
      organizationId: ORG,
      title: 'تعویض روغن',
    });
    const result = reduceScenario(state, {
      type: 'MAINTENANCE_ESTIMATE_APPROVED',
      maintenanceRequestId: maintenanceRequestId(state),
      estimateAmountMinor: '-500',
    });
    expect(result.outcome).toBe('REJECTED');
    expect(result.reason).toBe('MALFORMED_ACTION');
    expect(result.state).toBe(state);
  });

  it('refuses an order placed before any offer was selected', () => {
    const state = buildInitialScenarioState();
    const result = reduceScenario(state, {
      type: 'ORDER_PLACED',
      orderId: orderId(state),
      offerId: OFFER,
      totalAmountMinor: '284000000',
    });
    expect(result.reason).toBe('UNKNOWN_REFERENCE');
  });

  it('refuses payment before an order is placed', () => {
    const state = buildInitialScenarioState();
    const result = reduceScenario(state, {
      type: 'PAYMENT_CAPTURED',
      orderId: orderId(state),
      amountMinor: '284000000',
    });
    expect(result.reason).toBe('INVALID_TRANSITION');
  });

  it('refuses a document attached before payment is captured', () => {
    const state = buildInitialScenarioState();
    const result = reduceScenario(state, {
      type: 'DOCUMENT_ATTACHED',
      documentId: 'doc_demo_scenario_1',
      ownerResourceType: 'Order',
      ownerResourceId: orderId(state),
      filename: 'فاکتور.pdf',
    });
    expect(result.reason).toBe('INVALID_TRANSITION');
  });
});

describe('idempotency', () => {
  it('rejects a repeated MAINTENANCE_REQUEST_CREATED deterministically', () => {
    let state = buildInitialScenarioState();
    const action: ScenarioAction = {
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: maintenanceRequestId(state),
      assetId: ASSET,
      organizationId: ORG,
      title: 'تعویض روغن',
    };
    state = apply(state, action);

    const second = reduceScenario(state, action);
    expect(second.outcome).toBe('REJECTED');
    expect(second.reason).toBe('INVALID_TRANSITION');
    expect(second.state).toBe(state);
  });

  it('PERSONA_SELECTED is explicitly idempotent-safe: repeating it never fails', () => {
    let state = buildInitialScenarioState();
    state = apply(state, { type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    const again = reduceScenario(state, { type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    expect(again.outcome).toBe('APPLIED');
  });
});

describe('the happy path, in story order', () => {
  function driveToPaymentCaptured(): ScenarioSnapshot {
    let state = buildInitialScenarioState();
    const mrqId = maintenanceRequestId(state);
    const ordId = orderId(state);

    state = apply(state, {
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: mrqId,
      assetId: ASSET,
      organizationId: ORG,
      title: 'تعویض روغن و فیلتر',
    });
    expect(state.stage).toBe('MAINTENANCE_REQUESTED');

    state = apply(state, {
      type: 'MAINTENANCE_ESTIMATE_APPROVED',
      maintenanceRequestId: mrqId,
      estimateAmountMinor: '284000000',
    });
    expect(state.stage).toBe('ESTIMATE_APPROVED');

    state = apply(state, {
      type: 'SUPPLIER_OFFER_SELECTED',
      maintenanceRequestId: mrqId,
      supplierOrganizationId: SUPPLIER,
      offerId: OFFER,
      unitPriceMinor: '284000000',
    });
    expect(state.stage).toBe('OFFER_SELECTED');

    state = apply(state, {
      type: 'ORDER_PLACED',
      orderId: ordId,
      offerId: OFFER,
      totalAmountMinor: '284000000',
    });
    expect(state.stage).toBe('ORDER_PLACED');

    state = apply(state, { type: 'PAYMENT_CAPTURED', orderId: ordId, amountMinor: '284000000' });
    expect(state.stage).toBe('PAYMENT_CAPTURED');

    return state;
  }

  it('reaches PAYMENT_CAPTURED with a balanced wallet and no floating-point anywhere', () => {
    const state = driveToPaymentCaptured();

    expect(state.wallet.ledgerBalanceMinor).toBe('866400000');
    expect(state.wallet.pendingBalanceMinor).toBe('0');
    expect(state.wallet.availableBalanceMinor).toBe('866400000');
    // Every amount field is a string, end to end.
    for (const value of [
      state.wallet.ledgerBalanceMinor,
      state.wallet.pendingBalanceMinor,
      state.wallet.availableBalanceMinor,
      state.maintenance.estimateAmountMinor,
      state.order.totalAmountMinor,
    ]) {
      expect(typeof value).toBe('string');
    }
    expect(checkInvariants(state)).toEqual([]);
  });

  it('attaches and scans a document only after payment, reaching the final stage', () => {
    let state = driveToPaymentCaptured();

    state = apply(state, {
      type: 'DOCUMENT_ATTACHED',
      documentId: 'doc_demo_scenario_1',
      ownerResourceType: 'Order',
      ownerResourceId: orderId(state),
      filename: 'فاکتور.pdf',
    });
    expect(state.stage).toBe('DOCUMENT_ATTACHED');
    expect(state.documents[0]?.scanState).toBe('PENDING');
    expect(state.documents[0]?.scannedAt).toBeNull();

    state = apply(state, {
      type: 'DOCUMENT_SCAN_COMPLETED',
      documentId: 'doc_demo_scenario_1',
      scanState: 'CLEAN',
    });
    expect(state.stage).toBe('DOCUMENT_SCAN_COMPLETED');
    expect(state.documents[0]?.scannedAt).not.toBeNull();
    expect(checkInvariants(state)).toEqual([]);
  });

  it('refuses to capture a payment that does not match the order total', () => {
    let state = buildInitialScenarioState();
    const mrqId = maintenanceRequestId(state);
    const ordId = orderId(state);
    state = apply(state, {
      type: 'MAINTENANCE_REQUEST_CREATED',
      maintenanceRequestId: mrqId,
      assetId: ASSET,
      organizationId: ORG,
      title: 'x',
    });
    state = apply(state, {
      type: 'MAINTENANCE_ESTIMATE_APPROVED',
      maintenanceRequestId: mrqId,
      estimateAmountMinor: '284000000',
    });
    state = apply(state, {
      type: 'SUPPLIER_OFFER_SELECTED',
      maintenanceRequestId: mrqId,
      supplierOrganizationId: SUPPLIER,
      offerId: OFFER,
      unitPriceMinor: '284000000',
    });
    state = apply(state, {
      type: 'ORDER_PLACED',
      orderId: ordId,
      offerId: OFFER,
      totalAmountMinor: '284000000',
    });

    const result = reduceScenario(state, {
      type: 'PAYMENT_CAPTURED',
      orderId: ordId,
      amountMinor: '1',
    });
    expect(result.outcome).toBe('REJECTED');
    expect(result.state).toBe(state);
  });
});

describe('SCENARIO_RESET', () => {
  it('restores the exact canonical initial snapshot, not revision + 1', () => {
    let state = buildInitialScenarioState();
    state = apply(state, { type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    expect(state.revision).toBe(1);

    const result = reduceScenario(state, { type: 'SCENARIO_RESET' });
    expect(result.outcome).toBe('APPLIED');
    expect(result.state).toEqual(buildInitialScenarioState());
    expect(result.state.revision).toBe(0);
  });
});
