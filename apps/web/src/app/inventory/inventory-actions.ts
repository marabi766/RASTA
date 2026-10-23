'use server';

import { redirect } from 'next/navigation';

import { FLASH_PARAM, REPLAY_FIELD } from '@/lib/form-fields';
import {
  hasFields,
  inventoryFormValues,
  parseInventoryForm,
  valuesOfBody,
  type InventoryBody,
  type InventoryCommand,
  type InventoryFormValues,
  type InventoryScope,
} from '@/lib/inventory-commands';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { verifyCsrf } from '@/server/csrf';
import { mintFlash } from '@/server/flash';
import { verifyInventoryStamp, type VerifiedInventoryStamp } from '@/server/inventory-replay';
import {
  inventoryRequestOf,
  issueInventoryCommand,
  type InventoryWriteResult,
} from '@/server/inventory-commands';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';

import { afterRetry, type InventoryFormState } from './inventory-form-state';

/**
 * The server action behind every inventory form on `/inventory` (a warehouse,
 * a receipt, an adjustment, a new shipment) and `/inventory/shipments/[id]`
 * (its dispatch and its delivery).
 *
 * The order of every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * submission id, the signed replay stamp (`server/inventory-replay.ts`), the
 * form, then the gateway — each gate returning before the next runs. The slot
 * is bound, not posted; a shipment move's whole body is the version from the
 * verified stamp.
 *
 * **Whether the command is allowed is not decided here.** inventory-service
 * decides — roles, tenant, state — and its refusal is said in fixed words; the
 * page only chose what to draw.
 *
 * Once a command is unconfirmed, no answer to a retry but a successful one
 * (which redirects) may claim the first request did not commit.
 */

type Attempt = (
  session: WebSession,
  stamp: VerifiedInventoryStamp,
  submissionId: string,
  form: FormData,
) => Promise<InventoryFormState>;

async function gated(
  scope: InventoryScope,
  form: FormData,
  attempt: Attempt,
): Promise<InventoryFormState> {
  const session = await currentSession();
  if (!session) return { kind: 'REFUSED', reason: await missingSessionReason() };

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { kind: 'REFUSED', reason: 'CSRF' };

  const submissionId = form.get(SUBMISSION_FIELD);
  if (!isBoundSubmissionId(submissionId, session)) return { kind: 'REFUSED', reason: 'SUBMISSION' };

  // On every send under this key — the first and each retry — against the
  // deadline and the binding signed when the form was drawn.
  const stamp = verifyInventoryStamp(session, form.get(REPLAY_FIELD), scope, submissionId);
  if (!stamp) return { kind: 'REFUSED', reason: 'REPLAY' };
  return attempt(session, stamp, submissionId, form);
}

function targetOf(scope: InventoryScope): string | null {
  switch (scope.kind) {
    case 'WAREHOUSES':
      return null;
    case 'WAREHOUSE':
      return scope.warehouseId;
    case 'SHIPMENT':
      return scope.shipmentId;
  }
}

/** Where a confirmed command lands: the warehouse it touched, or the shipment. */
function landing(
  scope: InventoryScope,
  command: InventoryCommand,
  answeredId: string,
): { readonly path: string; readonly subject: string } {
  switch (command) {
    case 'CREATE_WAREHOUSE':
      return {
        path: `/inventory?warehouse=${encodeURIComponent(answeredId)}`,
        subject: answeredId,
      };
    case 'RECEIVE_STOCK':
    case 'ADJUST_STOCK': {
      const warehouseId = scope.kind === 'WAREHOUSE' ? scope.warehouseId : answeredId;
      return {
        path: `/inventory?warehouse=${encodeURIComponent(warehouseId)}`,
        subject: warehouseId,
      };
    }
    case 'CREATE_SHIPMENT':
      return {
        path: `/inventory/shipments/${encodeURIComponent(answeredId)}`,
        subject: answeredId,
      };
    case 'DISPATCH_SHIPMENT':
    case 'DELIVER_SHIPMENT': {
      const shipmentId = scope.kind === 'SHIPMENT' ? scope.shipmentId : answeredId;
      return {
        path: `/inventory/shipments/${encodeURIComponent(shipmentId)}`,
        subject: shipmentId,
      };
    }
  }
}

function outcome(
  result: InventoryWriteResult,
  sent: Extract<InventoryFormState, { kind: 'UNCONFIRMED' }>,
  values: InventoryFormValues | null,
  onDone: (answeredId: string) => never,
): InventoryFormState {
  switch (result.kind) {
    case 'CREATED':
      return onDone(result.data.id);
    case 'INVALID':
      return {
        kind: 'INVALID',
        command: sent.command,
        submissionId: sent.submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND' };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing changed". What is
      // kept for the retry is what was sent, so the retry is the same request.
      return { ...sent, correlationId: result.correlationId };
  }
}

/** Runs the one inventory command of slot `scope` that the form's stamp names. */
export async function submitInventoryCommand(
  scope: InventoryScope,
  previous: InventoryFormState,
  form: FormData,
): Promise<InventoryFormState> {
  const state = await gated(scope, form, async (session, stamp, submissionId, sent) => {
    const { command } = stamp;
    let body: InventoryBody | null = null;
    let typed: InventoryFormValues | null = null;
    if (hasFields(command)) {
      typed = inventoryFormValues(sent);
      const parsed = parseInventoryForm(command, typed);
      if (!parsed.ok) {
        return {
          kind: 'INVALID',
          command,
          submissionId,
          values: typed,
          fieldErrors: parsed.fieldErrors,
          message: parsed.message,
        };
      }
      body = parsed.body;
    }

    const request = inventoryRequestOf(command, targetOf(scope), body, stamp.expectedVersion);
    if (!request) return { kind: 'REFUSED', reason: 'COMMAND' };

    const result = await issueInventoryCommand(session, command, request, body, submissionId);
    return outcome(
      result,
      {
        kind: 'UNCONFIRMED',
        command,
        correlationId: null,
        submissionId,
        body,
        replay: { token: stamp.token, until: stamp.until },
      },
      // A refusal names the field of the body as sent (legs renumbered from 0), so the
      // form is drawn again from that body.
      body ? valuesOfBody(command, body) : null,
      (answeredId) => {
        const { path, subject } = landing(scope, command, answeredId);
        const flash = mintFlash(session, subject, command);
        return redirect(`${path}${path.includes('?') ? '&' : '?'}${FLASH_PARAM}=${flash}`);
      },
    );
  });
  return previous.kind === 'UNCONFIRMED' ? afterRetry(previous, state) : state;
}
