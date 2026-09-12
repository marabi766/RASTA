import { FIXTURE_ENTRY_POINTS } from '../entry-points';
import { buildInitialScenarioState } from './initial-state';
import { createScenarioStore } from './store';

const TOUR_KEY = 'rasta.tour.state';

describe('createScenarioStore', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('starts from the canonical initial state when nothing is persisted', () => {
    const store = createScenarioStore();
    expect(store.getState()).toEqual(buildInitialScenarioState());
  });

  it('notifies subscribers only on an applied dispatch, not a rejected one', () => {
    const store = createScenarioStore();
    const listener = jest.fn();
    store.subscribe(listener);

    store.dispatch({
      type: 'MAINTENANCE_ESTIMATE_APPROVED',
      maintenanceRequestId: store.getState().maintenance.id,
      estimateAmountMinor: '1',
    });
    expect(listener).not.toHaveBeenCalled();

    store.dispatch({ type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying once unsubscribed', () => {
    const store = createScenarioStore();
    const listener = jest.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();

    store.dispatch({ type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('persists an applied dispatch so a fresh store hydrates it', () => {
    const first = createScenarioStore();
    first.dispatch({ type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });

    const second = createScenarioStore();
    expect(second.getState().persona).toBe('FLEET_MANAGER');
  });

  it('reset() returns to the canonical snapshot and clears the persisted key', () => {
    const store = createScenarioStore();
    store.dispatch({ type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    store.reset();

    expect(store.getState()).toEqual(buildInitialScenarioState());

    const next = createScenarioStore();
    expect(next.getState()).toEqual(buildInitialScenarioState());
  });

  it('reset() notifies subscribers', () => {
    const store = createScenarioStore();
    const listener = jest.fn();
    store.subscribe(listener);
    store.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reset() never touches the guided tour’s own sessionStorage key', () => {
    window.sessionStorage.setItem(
      TOUR_KEY,
      JSON.stringify({ active: true, index: 3, detailed: false }),
    );

    const store = createScenarioStore();
    store.dispatch({ type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    store.reset();

    expect(window.sessionStorage.getItem(TOUR_KEY)).toBe(
      JSON.stringify({ active: true, index: 3, detailed: false }),
    );
  });

  it('drives the whole story through dispatch alone, ending at the final stage', () => {
    const store = createScenarioStore();
    const mrqId = store.getState().maintenance.id;
    const ordId = store.getState().order.id;

    const steps = [
      {
        type: 'MAINTENANCE_REQUEST_CREATED' as const,
        maintenanceRequestId: mrqId,
        assetId: FIXTURE_ENTRY_POINTS.assetId,
        organizationId: FIXTURE_ENTRY_POINTS.organizationId,
        title: 'x',
      },
      {
        type: 'MAINTENANCE_ESTIMATE_APPROVED' as const,
        maintenanceRequestId: mrqId,
        estimateAmountMinor: '284000000',
      },
      {
        type: 'SUPPLIER_OFFER_SELECTED' as const,
        maintenanceRequestId: mrqId,
        supplierOrganizationId: FIXTURE_ENTRY_POINTS.supplierOrganizationId,
        offerId: FIXTURE_ENTRY_POINTS.offerId,
        unitPriceMinor: '284000000',
      },
      {
        type: 'ORDER_PLACED' as const,
        orderId: ordId,
        offerId: FIXTURE_ENTRY_POINTS.offerId,
        totalAmountMinor: '284000000',
      },
      { type: 'PAYMENT_CAPTURED' as const, orderId: ordId, amountMinor: '284000000' },
      {
        type: 'DOCUMENT_ATTACHED' as const,
        documentId: 'doc_1',
        ownerResourceType: 'Order',
        ownerResourceId: ordId,
        filename: 'x.pdf',
      },
      {
        type: 'DOCUMENT_SCAN_COMPLETED' as const,
        documentId: 'doc_1',
        scanState: 'CLEAN' as const,
      },
    ];

    for (const action of steps) {
      const result = store.dispatch(action);
      expect(result.outcome).toBe('APPLIED');
    }

    expect(store.getState().stage).toBe('DOCUMENT_SCAN_COMPLETED');
    expect(store.getState().revision).toBe(steps.length);
  });
});
