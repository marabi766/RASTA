import { buildInitialScenarioState } from './initial-state';
import type { ScenarioAction, ScenarioSnapshot } from './model';
import { reduceScenario } from './reducer';
import {
  projectAuditEventsPage,
  projectDocumentsPage,
  projectMaintenanceRequestDetail,
  projectOrder,
  projectOrdersPage,
  projectWallet,
} from './read-model';

/**
 * Pure, synthetic `base` objects — not `fixtures.ts` — so this file proves
 * the projectors work without needing the real dataset, and so a future
 * rewrite of `fixtures.ts` cannot break this suite for reasons unrelated to
 * the read-model itself.
 */
const BASE_MAINTENANCE = {
  id: 'mrq_1',
  status: 'IN_PROGRESS',
  title: 'سرویس دوره‌ای',
  reportedAt: '2026-01-01T00:00:00.000Z',
  approvedAt: null,
  approvedBy: null,
  totalCostMinor: '0',
};

const BASE_ORDER = {
  id: 'ord_1',
  status: 'CREATED',
  totalAmountMinor: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const BASE_ORDERS_PAGE = { items: [BASE_ORDER], nextCursor: null };
const BASE_WALLET = {
  id: 'wal_1',
  ledgerBalanceMinor: '1000',
  pendingBalanceMinor: '200',
  availableBalanceMinor: '800',
};
const BASE_DOCUMENTS_PAGE = { items: [{ id: 'doc_existing' }], nextCursor: null };
const BASE_AUDIT_PAGE = { items: [{ id: 'aev_existing' }], nextCursor: null, hasMore: false };

function withDispatched(...actions: ScenarioAction[]): ScenarioSnapshot {
  let state = buildInitialScenarioState();
  for (const action of actions) {
    const result = reduceScenario(state, action);
    expect(result.outcome).toBe('APPLIED');
    state = result.state;
  }
  return state;
}

describe('read-model: the untouched scenario changes nothing', () => {
  const initial = buildInitialScenarioState();

  it('passes the maintenance base through unchanged', () => {
    expect(projectMaintenanceRequestDetail(BASE_MAINTENANCE, initial)).toBe(BASE_MAINTENANCE);
  });

  it('passes the order base through unchanged', () => {
    expect(projectOrder(BASE_ORDER, initial)).toBe(BASE_ORDER);
  });

  it('passes the orders page through with every item unchanged', () => {
    expect(projectOrdersPage(BASE_ORDERS_PAGE, initial)).toEqual(BASE_ORDERS_PAGE);
  });

  it('passes the documents page through unchanged', () => {
    expect(projectDocumentsPage(BASE_DOCUMENTS_PAGE, initial)).toBe(BASE_DOCUMENTS_PAGE);
  });

  it('passes the audit-events page through unchanged', () => {
    expect(projectAuditEventsPage(BASE_AUDIT_PAGE, initial)).toBe(BASE_AUDIT_PAGE);
  });

  it('still overrides the wallet balances, since the initial wallet already carries a hold', () => {
    // Unlike the others, the wallet's numbers are always the scenario's own —
    // there is no "untouched" wallet reading, the same way the real screen
    // never has a wallet with no state at all.
    const projected = projectWallet(BASE_WALLET, initial);
    expect(projected.ledgerBalanceMinor).toBe(initial.wallet.ledgerBalanceMinor);
    expect(projected.pendingBalanceMinor).toBe(initial.wallet.pendingBalanceMinor);
  });
});

describe('read-model: reflects the scenario once something happened', () => {
  it('reflects an approved estimate on the maintenance detail', () => {
    const state = withDispatched(
      {
        type: 'MAINTENANCE_REQUEST_CREATED',
        maintenanceRequestId: buildInitialScenarioState().maintenance.id,
        assetId: buildInitialScenarioState().assetId,
        organizationId: buildInitialScenarioState().organizationId,
        title: 'تعویض روغن',
      },
      {
        type: 'MAINTENANCE_ESTIMATE_APPROVED',
        maintenanceRequestId: buildInitialScenarioState().maintenance.id,
        estimateAmountMinor: '123',
      },
    );

    const projected = projectMaintenanceRequestDetail(BASE_MAINTENANCE, state);
    expect(projected.status).toBe('APPROVED');
    expect(projected.approvedAt).toBe(state.maintenance.approvedAt);
    expect(projected.totalCostMinor).toBe('123');
    // Fields the scenario never touches stay exactly as the base had them.
    expect(projected.id).toBe(BASE_MAINTENANCE.id);
  });

  it('reflects a placed order in both the list and the detail projector', () => {
    const initial = buildInitialScenarioState();
    const state = withDispatched(
      {
        type: 'MAINTENANCE_REQUEST_CREATED',
        maintenanceRequestId: initial.maintenance.id,
        assetId: initial.assetId,
        organizationId: initial.organizationId,
        title: 'x',
      },
      {
        type: 'MAINTENANCE_ESTIMATE_APPROVED',
        maintenanceRequestId: initial.maintenance.id,
        estimateAmountMinor: '1',
      },
      {
        type: 'SUPPLIER_OFFER_SELECTED',
        maintenanceRequestId: initial.maintenance.id,
        supplierOrganizationId: initial.supplierOrganizationId,
        offerId: 'ofr_1',
        unitPriceMinor: '1',
      },
      { type: 'ORDER_PLACED', orderId: initial.order.id, offerId: 'ofr_1', totalAmountMinor: '1' },
    );

    const base = {
      id: initial.order.id,
      status: 'CREATED',
      totalAmountMinor: null,
      createdAt: 'x',
    };
    const detail = projectOrder(base, state);
    // `PENDING` is a real `ORDER_STATUSES` member (`lib/api/adapters/marketplace.ts`)
    // for a placed order awaiting its funds hold; the literal `'CREATED'` the base
    // object carries here is a stale placeholder the projector always overwrites.
    expect(detail.status).toBe('PENDING');
    expect(detail.totalAmountMinor).toBe('1');

    const page = projectOrdersPage({ items: [base], nextCursor: null }, state);
    expect((page.items as Array<Record<string, unknown>>)[0]?.totalAmountMinor).toBe('1');
  });

  it('never mutates the base object it was given', () => {
    const state = withDispatched({ type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' });
    const before = JSON.stringify(BASE_MAINTENANCE);
    projectMaintenanceRequestDetail(BASE_MAINTENANCE, state);
    expect(JSON.stringify(BASE_MAINTENANCE)).toBe(before);
  });

  it('prepends a scenario document ahead of the existing ones, with a matching schema shape', () => {
    const initial = buildInitialScenarioState();
    const state = withDispatched(
      {
        type: 'MAINTENANCE_REQUEST_CREATED',
        maintenanceRequestId: initial.maintenance.id,
        assetId: initial.assetId,
        organizationId: initial.organizationId,
        title: 'x',
      },
      {
        type: 'MAINTENANCE_ESTIMATE_APPROVED',
        maintenanceRequestId: initial.maintenance.id,
        estimateAmountMinor: '1',
      },
      {
        type: 'SUPPLIER_OFFER_SELECTED',
        maintenanceRequestId: initial.maintenance.id,
        supplierOrganizationId: initial.supplierOrganizationId,
        offerId: 'ofr_1',
        unitPriceMinor: '1',
      },
      { type: 'ORDER_PLACED', orderId: initial.order.id, offerId: 'ofr_1', totalAmountMinor: '1' },
      { type: 'PAYMENT_CAPTURED', orderId: initial.order.id, amountMinor: '1' },
      {
        type: 'DOCUMENT_ATTACHED',
        documentId: 'doc_new',
        ownerResourceType: 'Order',
        ownerResourceId: initial.order.id,
        filename: 'x.pdf',
      },
    );

    const page = projectDocumentsPage(BASE_DOCUMENTS_PAGE, state);
    const items = page.items as Array<Record<string, unknown>>;
    expect(items[0]?.id).toBe('doc_new');
    expect(items[0]?.scanState).toBe('PENDING');
    expect(items.at(-1)?.id).toBe('doc_existing');
  });

  it('projects one audit-events record per activity-log entry, newest first', () => {
    const state = withDispatched(
      { type: 'PERSONA_SELECTED', persona: 'FLEET_MANAGER' },
      { type: 'PERSONA_SELECTED', persona: 'ORGANIZATION_ADMIN' },
    );

    const page = projectAuditEventsPage(BASE_AUDIT_PAGE, state);
    const items = page.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3); // two scenario events + the one existing record
    expect(items[0]?.sequenceNo).toBe('2');
    expect(items[1]?.sequenceNo).toBe('1');
    expect(items[2]?.id).toBe('aev_existing');
    expect(items[0]?.integrity).toBe('UNCHAINED');
  });
});
