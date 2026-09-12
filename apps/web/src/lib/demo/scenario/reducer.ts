import { subtractMoney } from '@rasta/contracts';
import { advanceClock } from './clock';
import { buildInitialScenarioState } from './initial-state';
import { deriveStage } from './invariants';
import type {
  ScenarioAction,
  ScenarioDispatchResult,
  ScenarioRejectionReason,
  ScenarioResetAction,
  ScenarioSnapshot,
} from './model';

/** Every action `applyAction` handles — everything but the reset, which `reduceScenario` short-circuits before it gets here. */
type NonResetAction = Exclude<ScenarioAction, ScenarioResetAction>;

/**
 * The one place every transition is decided.
 *
 * ## The contract this function holds itself to
 *
 * A rejected action returns the *same* `state` reference it was given —
 * never a clone, never a partial patch. That is what makes "a rejected
 * transition leaves the state byte-for-byte unchanged" a property of the
 * return value rather than something a caller has to remember to check.
 *
 * An applied action always advances `revision` by exactly one and recomputes
 * `stage` from `deriveStage` rather than trusting a handler to set it
 * correctly — the one exception is `SCENARIO_RESET`, which returns the exact
 * canonical snapshot (`revision: 0`) rather than "current + 1", because
 * "reset" means "as if nothing had happened", not "one more thing happened".
 */
export function reduceScenario(
  state: ScenarioSnapshot,
  action: ScenarioAction,
): ScenarioDispatchResult {
  if (action.type === 'SCENARIO_RESET') {
    return { state: buildInitialScenarioState(), outcome: 'APPLIED' };
  }

  let outcome: TransitionOutcome;
  try {
    outcome = applyAction(state, action);
  } catch (error) {
    if (error instanceof ScenarioRejection) {
      return { state, outcome: 'REJECTED', reason: error.reason, message: error.message };
    }
    throw error;
  }

  const nextClock = advanceClock(state.clock);
  const sequence = state.activityLog.length + 1;

  const next: ScenarioSnapshot = {
    ...state,
    ...outcome.patch,
    clock: nextClock,
    revision: state.revision + 1,
    activityLog: [
      ...state.activityLog,
      {
        sequence,
        occurredAt: nextClock,
        action: outcome.log.action,
        resourceType: outcome.log.resourceType,
        resourceId: outcome.log.resourceId,
        summary: outcome.log.summary,
      },
    ],
  };

  return { state: { ...next, stage: deriveStage(next) }, outcome: 'APPLIED' };
}

// ---------------------------------------------------------------------------
// Per-action transitions
// ---------------------------------------------------------------------------

interface TransitionOutcome {
  readonly patch: Partial<ScenarioSnapshot>;
  readonly log: { action: string; resourceType: string; resourceId: string; summary: string };
}

class ScenarioRejection extends Error {
  constructor(
    readonly reason: ScenarioRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'ScenarioRejection';
  }
}

function reject(reason: ScenarioRejectionReason, message: string): never {
  throw new ScenarioRejection(reason, message);
}

const AMOUNT_PATTERN = /^\d{1,30}$/;

function requireAmount(value: string, field: string): string {
  if (!AMOUNT_PATTERN.test(value)) {
    reject('MALFORMED_ACTION', `${field} is not a non-negative integer string`);
  }
  return value;
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) reject('MALFORMED_ACTION', `${field} must not be empty`);
  return value;
}

function applyAction(state: ScenarioSnapshot, action: NonResetAction): TransitionOutcome {
  switch (action.type) {
    case 'PERSONA_SELECTED':
      return {
        patch: { persona: action.persona },
        log: {
          action: 'persona.selected',
          resourceType: 'Organization',
          resourceId: state.organizationId,
          summary: `شخصیت ارائه به «${action.persona}» تغییر کرد.`,
        },
      };

    case 'MAINTENANCE_REQUEST_CREATED': {
      requireNonEmpty(action.title, 'title');
      if (action.organizationId !== state.organizationId) {
        reject(
          'CROSS_ORGANIZATION_REFERENCE',
          'organizationId does not match the scenario organization',
        );
      }
      if (action.assetId !== state.assetId) {
        reject('UNKNOWN_REFERENCE', 'assetId does not match the scenario asset');
      }
      if (action.maintenanceRequestId !== state.maintenance.id) {
        reject(
          'UNKNOWN_REFERENCE',
          'maintenanceRequestId does not match the scenario maintenance request',
        );
      }
      if (state.maintenance.status !== 'NONE') {
        reject('INVALID_TRANSITION', 'a maintenance request already exists for this scenario');
      }

      return {
        patch: {
          maintenance: {
            ...state.maintenance,
            status: 'REQUESTED',
            title: action.title,
            requestedAt: advanceClock(state.clock),
          },
        },
        log: {
          action: 'maintenance.requested',
          resourceType: 'MaintenanceRequest',
          resourceId: state.maintenance.id,
          summary: `درخواست تعمیر «${action.title}» ثبت شد.`,
        },
      };
    }

    case 'MAINTENANCE_ESTIMATE_APPROVED': {
      requireAmount(action.estimateAmountMinor, 'estimateAmountMinor');
      if (action.maintenanceRequestId !== state.maintenance.id) {
        reject(
          'UNKNOWN_REFERENCE',
          'maintenanceRequestId does not match the scenario maintenance request',
        );
      }
      if (state.maintenance.status !== 'REQUESTED') {
        reject(
          'INVALID_TRANSITION',
          'the estimate cannot be approved before a request exists, or is approved already',
        );
      }

      return {
        patch: {
          maintenance: {
            ...state.maintenance,
            status: 'ESTIMATE_APPROVED',
            estimateAmountMinor: action.estimateAmountMinor,
            approvedAt: advanceClock(state.clock),
          },
        },
        log: {
          action: 'maintenance.estimate_approved',
          resourceType: 'MaintenanceRequest',
          resourceId: state.maintenance.id,
          summary: 'برآورد هزینهٔ تعمیر تأیید شد.',
        },
      };
    }

    case 'SUPPLIER_OFFER_SELECTED': {
      requireNonEmpty(action.offerId, 'offerId');
      requireAmount(action.unitPriceMinor, 'unitPriceMinor');
      if (action.maintenanceRequestId !== state.maintenance.id) {
        reject(
          'UNKNOWN_REFERENCE',
          'maintenanceRequestId does not match the scenario maintenance request',
        );
      }
      if (action.supplierOrganizationId !== state.supplierOrganizationId) {
        reject(
          'CROSS_ORGANIZATION_REFERENCE',
          'supplierOrganizationId does not match the scenario supplier',
        );
      }
      if (state.maintenance.status !== 'ESTIMATE_APPROVED') {
        reject('INVALID_TRANSITION', 'an offer cannot be selected before the estimate is approved');
      }
      if (state.offerSelection !== null) {
        reject('INVALID_TRANSITION', 'an offer has already been selected for this scenario');
      }

      return {
        patch: {
          offerSelection: {
            maintenanceRequestId: action.maintenanceRequestId,
            supplierOrganizationId: action.supplierOrganizationId,
            offerId: action.offerId,
            unitPriceMinor: action.unitPriceMinor,
            selectedAt: advanceClock(state.clock),
          },
        },
        log: {
          action: 'supplier.offer_selected',
          resourceType: 'Offer',
          resourceId: action.offerId,
          summary: 'پیشنهاد تأمین‌کننده انتخاب شد.',
        },
      };
    }

    case 'ORDER_PLACED': {
      requireAmount(action.totalAmountMinor, 'totalAmountMinor');
      if (!state.offerSelection) {
        reject('UNKNOWN_REFERENCE', 'no offer has been selected yet');
      }
      if (action.offerId !== state.offerSelection.offerId) {
        reject('UNKNOWN_REFERENCE', 'offerId does not match the selected offer');
      }
      if (action.orderId !== state.order.id) {
        reject('UNKNOWN_REFERENCE', 'orderId does not match the scenario order');
      }
      if (state.order.status !== 'NONE') {
        reject('INVALID_TRANSITION', 'an order already exists for this scenario');
      }

      return {
        patch: {
          order: {
            ...state.order,
            status: 'PLACED',
            offerId: action.offerId,
            totalAmountMinor: action.totalAmountMinor,
            placedAt: advanceClock(state.clock),
          },
        },
        log: {
          action: 'order.placed',
          resourceType: 'Order',
          resourceId: state.order.id,
          summary: 'سفارش ثبت شد.',
        },
      };
    }

    case 'PAYMENT_CAPTURED': {
      requireAmount(action.amountMinor, 'amountMinor');
      if (action.orderId !== state.order.id) {
        reject('UNKNOWN_REFERENCE', 'orderId does not match the scenario order');
      }
      if (state.order.status !== 'PLACED') {
        reject(
          'INVALID_TRANSITION',
          'payment cannot be captured before an order is placed, or is captured already',
        );
      }
      if (action.amountMinor !== state.order.totalAmountMinor) {
        reject('INVALID_TRANSITION', 'the captured amount does not match the order total');
      }

      const currency = 'IRR' as const;
      let nextLedger: string;
      let nextPending: string;
      try {
        nextLedger = subtractMoney(
          { amountMinor: state.wallet.ledgerBalanceMinor, currency },
          { amountMinor: action.amountMinor, currency },
        ).amountMinor;
        nextPending = subtractMoney(
          { amountMinor: state.wallet.pendingBalanceMinor, currency },
          { amountMinor: action.amountMinor, currency },
        ).amountMinor;
      } catch {
        reject(
          'INSUFFICIENT_WALLET_BALANCE',
          'capturing this payment would make the wallet negative',
        );
      }
      // `available = ledger − pending`, recomputed rather than adjusted
      // incrementally — the same rule `economic-service` enforces with a
      // database constraint (ADR-034).
      const available = subtractMoney(
        { amountMinor: nextLedger, currency },
        { amountMinor: nextPending, currency },
      ).amountMinor;

      return {
        patch: {
          order: {
            ...state.order,
            status: 'PAYMENT_CAPTURED',
            paymentCapturedAt: advanceClock(state.clock),
          },
          wallet: {
            ...state.wallet,
            ledgerBalanceMinor: nextLedger,
            pendingBalanceMinor: nextPending,
            availableBalanceMinor: available,
          },
        },
        log: {
          action: 'payment.captured',
          resourceType: 'Order',
          resourceId: state.order.id,
          summary: 'پرداخت سفارش نهایی شد.',
        },
      };
    }

    case 'DOCUMENT_ATTACHED': {
      requireNonEmpty(action.documentId, 'documentId');
      requireNonEmpty(action.ownerResourceType, 'ownerResourceType');
      requireNonEmpty(action.filename, 'filename');
      if (state.order.status !== 'PAYMENT_CAPTURED') {
        reject('INVALID_TRANSITION', 'a document cannot be attached before payment is captured');
      }
      if (state.documents.some((document) => document.id === action.documentId)) {
        reject('INVALID_TRANSITION', 'a document with this id is already attached');
      }
      const knownOwners = new Set([state.order.id, state.maintenance.id]);
      if (!knownOwners.has(action.ownerResourceId)) {
        reject('UNKNOWN_REFERENCE', 'ownerResourceId is not one of the scenario-owned entities');
      }

      return {
        patch: {
          documents: [
            ...state.documents,
            {
              id: action.documentId,
              ownerResourceType: action.ownerResourceType,
              ownerResourceId: action.ownerResourceId,
              filename: action.filename,
              scanState: 'PENDING',
              attachedAt: advanceClock(state.clock),
              scannedAt: null,
            },
          ],
        },
        log: {
          action: 'document.attached',
          resourceType: 'Document',
          resourceId: action.documentId,
          summary: `سند «${action.filename}» پیوست شد.`,
        },
      };
    }

    case 'DOCUMENT_SCAN_COMPLETED': {
      const document = state.documents.find((entry) => entry.id === action.documentId);
      if (!document) reject('UNKNOWN_REFERENCE', 'no such document is attached');
      if (document.scanState !== 'PENDING') {
        reject('INVALID_TRANSITION', 'this document has already completed a scan');
      }
      if (action.scanState === 'PENDING' || action.scanState === 'NOT_SCANNED') {
        reject('MALFORMED_ACTION', 'a completed scan cannot resolve to PENDING or NOT_SCANNED');
      }

      const scannedAt = advanceClock(state.clock);
      return {
        patch: {
          documents: state.documents.map((entry) =>
            entry.id === action.documentId
              ? { ...entry, scanState: action.scanState, scannedAt }
              : entry,
          ),
        },
        log: {
          action: 'document.scan_completed',
          resourceType: 'Document',
          resourceId: action.documentId,
          summary: `اسکن سند به نتیجهٔ «${action.scanState}» رسید.`,
        },
      };
    }

    case 'AUDIT_RECORD_APPENDED': {
      requireNonEmpty(action.action, 'action');
      requireNonEmpty(action.resourceType, 'resourceType');
      requireNonEmpty(action.summary, 'summary');
      const owned = new Set<string>([
        state.organizationId,
        state.assetId,
        state.supplierOrganizationId,
        state.maintenance.id,
        state.order.id,
        state.wallet.id,
        ...state.documents.map((document) => document.id),
        ...(state.offerSelection ? [state.offerSelection.offerId] : []),
      ]);
      if (!owned.has(action.resourceId)) {
        reject('UNKNOWN_REFERENCE', 'resourceId is not one of the scenario-owned entities');
      }

      return {
        patch: {},
        log: {
          action: action.action,
          resourceType: action.resourceType,
          resourceId: action.resourceId,
          summary: action.summary,
        },
      };
    }

    default: {
      const exhaustive: never = action;
      reject('UNKNOWN_ACTION', `unknown action: ${JSON.stringify(exhaustive)}`);
    }
  }
}
