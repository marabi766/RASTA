import { FIXTURE_ENTRY_POINTS } from '../entry-points';
import { SCENARIO_EPOCH } from './clock';
import { SCENARIO_SCHEMA_VERSION, type ScenarioSnapshot } from './model';

/**
 * The canonical, deterministic starting snapshot.
 *
 * Every id here is one of `FIXTURE_ENTRY_POINTS` — never a fresh literal —
 * so the scenario's "asset" is the same grader the rest of the fixture
 * dataset already tells a story about, not a second, disconnected one.
 *
 * Calling this twice returns two snapshots that are deep-equal but not the
 * same reference, which is deliberate: `store.ts`'s `reset()` needs a fresh
 * object it can safely hand to a consumer that mutated a previous one by
 * mistake (it cannot, since everything is `readonly`, but the snapshot must
 * not rely on that alone).
 */
export function buildInitialScenarioState(): ScenarioSnapshot {
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    scenarioId: 'scenario_demo_grader_oil_change',
    revision: 0,
    clock: SCENARIO_EPOCH,
    stage: 'ORGANIZATION_SELECTED',
    persona: 'ORGANIZATION_ADMIN',
    organizationId: FIXTURE_ENTRY_POINTS.organizationId,
    assetId: FIXTURE_ENTRY_POINTS.assetId,
    supplierOrganizationId: FIXTURE_ENTRY_POINTS.supplierOrganizationId,
    maintenance: {
      id: FIXTURE_ENTRY_POINTS.maintenanceRequestId,
      assetId: FIXTURE_ENTRY_POINTS.assetId,
      organizationId: FIXTURE_ENTRY_POINTS.organizationId,
      status: 'NONE',
      title: null,
      estimateAmountMinor: null,
      requestedAt: null,
      approvedAt: null,
    },
    offerSelection: null,
    order: {
      id: FIXTURE_ENTRY_POINTS.orderId,
      organizationId: FIXTURE_ENTRY_POINTS.organizationId,
      offerId: null,
      totalAmountMinor: null,
      status: 'NONE',
      placedAt: null,
      paymentCapturedAt: null,
    },
    wallet: {
      id: FIXTURE_ENTRY_POINTS.walletId,
      organizationId: FIXTURE_ENTRY_POINTS.organizationId,
      // Mirrors `fixtures.ts`'s WALLET — the scenario starts from the same
      // balance the static wallet screen already shows.
      ledgerBalanceMinor: '1150400000',
      pendingBalanceMinor: '284000000',
      availableBalanceMinor: '866400000',
    },
    documents: [],
    activityLog: [],
  };
}
