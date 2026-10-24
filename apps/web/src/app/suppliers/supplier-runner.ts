import { redirect } from 'next/navigation';

import { BASELINE_FIELD, FLASH_PARAM } from '@/lib/form-fields';
import {
  STALE_MESSAGE,
  type ParsedSupplierForm,
  type RegisterBody,
  type RegisterField,
  type RegisterFormValues,
  type SupplierCommand,
  type SupplierNotice,
} from '@/lib/supplier-commands';
import { verifyCsrf } from '@/server/csrf';
import { currentSession, missingSessionReason } from '@/server/current-session';
import { mintFlash } from '@/server/flash';
import type { WebSession } from '@/server/session';
import { isBoundSubmissionId, SUBMISSION_FIELD } from '@/server/submission';
import {
  openSupplierBaseline,
  provenUnwritten,
  registerSupplier,
  type SupplierBaseline,
  type WrittenSupplier,
} from '@/server/supplier-commands';
import {
  supplierWriteScope,
  SUPPLIER_WRITE_PURPOSE,
  SUPPLIER_WRITE_RETRY,
} from '@/server/supplier-unresolved';
import {
  readUnresolved,
  requestDigest,
  reserveUnresolved,
  settleUnresolved,
  type SettleOutcome,
} from '@/server/unresolved-request';
import type { WriteResult } from '@/server/write';

import type { SupplierFormState } from './supplier-form-state';

/**
 * The one path every supplier command takes.
 *
 * Same order as every write in this portal (ADR-059 § 3, § 5): session, CSRF,
 * the submission id, what the command was drawn from, the form, and only then
 * the gateway. Each refusal is decided before the next step runs, so a refused
 * post never reaches it — which `supplier-actions.spec.ts` asserts for each
 * command.
 *
 * Not a `'use server'` module: that directive turns every export into a
 * network-callable action, and this is a helper the actions share.
 *
 * ## Which supplier
 *
 * The supplier is the page's own, bound to the action by the form
 * (`action.bind(null, supplierId)`), and the signed baseline must name the same
 * one — and, for a decision, carries the qualification. So a form whose hidden
 * fields were rewritten has nothing to name another supplier or qualification
 * with.
 *
 * ## Why a second press is not a second write
 *
 * There is no Idempotency-Key. What stops it is supplier-service's own state:
 * the second registration is `409`, the second submission, decision, suspension
 * or reinstatement is `422`. This runner sends the `422` rules that mean "the
 * record is no longer as the page drew it" to a fresh read of the supplier with a
 * sentence saying nothing was written this time (`stale`).
 *
 * That state cannot help once the first write was rejected by someone else in
 * between: a retry would then be a second qualification (Codex review of PR 366,
 * round 3). So the request is **reserved on the server before it is sent**
 * (`reserveUnresolved`: one atomic step per supplier, or per registration), and
 * kept when the answer is ambiguous — a lost response to the browser loses
 * nothing, because nothing lives in the response (round 4). Nothing new is sent
 * for that slot until the person says, on the page, that they re-read the record
 * (`reconcileSupplierWrite`), and the request is never sent again (no key). The
 * hold is checked before the form is read, so an invalid resubmission cannot
 * replace the warning; the pages read the same record, so navigation and a
 * remount keep it. The store unreachable is not "no hold": nothing is sent.
 */

export interface SupplierCommandSpec<V, B, F extends string> {
  readonly command: SupplierCommand;
  readonly notice: SupplierNotice;
  readonly valuesOf: (form: FormData) => V;
  readonly parse: (values: V) => ParsedSupplierForm<B, F>;
  readonly send: (
    session: WebSession,
    baseline: SupplierBaseline,
    body: B,
  ) => Promise<WriteResult<WrittenSupplier, F>>;
}

const supplierPath = (supplierId: string, flash: string): string =>
  `/suppliers/${encodeURIComponent(supplierId)}?${FLASH_PARAM}=${flash}`;

type Gated =
  | { readonly ok: true; readonly session: WebSession; readonly submissionId: string }
  | { readonly ok: false; readonly state: SupplierFormState<never, never> };

async function gate(form: FormData): Promise<Gated> {
  const session = await currentSession();
  if (!session) {
    return { ok: false, state: { kind: 'REFUSED', reason: await missingSessionReason() } };
  }

  const csrf = verifyCsrf(session, form);
  if (!csrf.ok) return { ok: false, state: { kind: 'REFUSED', reason: 'CSRF' } };

  const submissionId = form.get(SUBMISSION_FIELD);
  // Bound to this session: a well-formed id this server never issued, another
  // person's id, and an id from an earlier login are all refused here.
  if (!isBoundSubmissionId(submissionId, session)) {
    return { ok: false, state: { kind: 'REFUSED', reason: 'SUBMISSION' } };
  }
  return { ok: true, session, submissionId };
}

/**
 * The warning of a write that is still unresolved for this slot, as the state a
 * form shows — or null when nothing is held. Nothing is sent while it exists,
 * and the store that cannot answer is not "nothing held".
 */
async function heldState(
  session: WebSession,
  supplierId: string | null,
): Promise<SupplierFormState<never, never> | null> {
  const held = await readUnresolved(session, supplierWriteScope(supplierId));
  switch (held.kind) {
    case 'NONE':
      return null;
    case 'UNAVAILABLE':
      return { kind: 'NOT_CHECKED' };
    case 'PENDING':
      return held.request.inFlight
        ? { kind: 'BUSY' }
        : { kind: 'UNCONFIRMED', correlationId: held.request.ref ?? held.request.key };
  }
}

/** What the dispatch showed, as the store records it. */
function outcomeOf(result: WriteResult<WrittenSupplier, string>): SettleOutcome {
  switch (result.kind) {
    case 'CREATED':
      return 'CONFIRMED';
    case 'INVALID':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
      return 'REFUSED';
    case 'UNAVAILABLE':
      // Connection refused and the like: no byte left this portal.
      if (result.neverSent) return 'NEVER_SENT';
      return provenUnwritten(result.status, result.code) ? 'REFUSED' : 'UNRESOLVED';
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      return 'UNRESOLVED';
  }
}

type Sent<F extends string> =
  | { readonly sent: false; readonly state: SupplierFormState<never, never> }
  | { readonly sent: true; readonly result: WriteResult<WrittenSupplier, F> };

/**
 * Reserves the slot, sends, and settles — in that order, so that a response
 * lost on the way back to the browser still leaves the record: it is on the
 * server before a byte goes out and stays unless the outcome is known.
 */
async function sendReserved<F extends string>(
  session: WebSession,
  supplierId: string | null,
  submissionId: string,
  body: unknown,
  send: () => Promise<WriteResult<WrittenSupplier, F>>,
): Promise<Sent<F>> {
  const reserved = await reserveUnresolved(session, supplierWriteScope(supplierId), {
    key: submissionId,
    digest: requestDigest(session, SUPPLIER_WRITE_PURPOSE, body),
    ref: null,
    issuedAt: Date.now(),
    deadline: null,
    windowMs: null,
    retry: SUPPLIER_WRITE_RETRY,
  });
  switch (reserved.kind) {
    case 'UNAVAILABLE':
      return { sent: false, state: { kind: 'NOT_CHECKED' } };
    case 'CAPACITY':
      return { sent: false, state: { kind: 'CAPACITY' } };
    case 'HELD':
    case 'EXPIRED':
      return {
        sent: false,
        state:
          reserved.kind === 'HELD' && reserved.reason === 'IN_PROGRESS'
            ? { kind: 'BUSY' }
            : {
                kind: 'UNCONFIRMED',
                correlationId: reserved.request.ref ?? reserved.request.key,
              },
      };
    case 'RESERVED':
      break;
  }
  const { attempt } = reserved;

  let result: WriteResult<WrittenSupplier, F>;
  try {
    result = await send();
  } catch (error) {
    // Anything unexpected after the request may have gone out: unresolved.
    await settleUnresolved(attempt, 'UNRESOLVED');
    throw error;
  }
  await settleUnresolved(attempt, outcomeOf(result));
  return { sent: true, result };
}

/** Everything a failed write can still say, once success (a redirect) is out of the way. */
function failure<V, F extends string>(
  result: Exclude<WriteResult<WrittenSupplier, F>, { kind: 'CREATED' }>,
  submissionId: string,
  values: V,
): SupplierFormState<V, F> {
  switch (result.kind) {
    case 'INVALID':
      return {
        kind: 'INVALID',
        submissionId,
        values,
        fieldErrors: result.fieldErrors,
        message: result.message,
      };
    case 'FORBIDDEN':
      return { kind: 'FORBIDDEN', correlationId: result.correlationId };
    case 'NOT_FOUND':
      return { kind: 'NOT_FOUND', correlationId: result.correlationId };
    case 'UNAVAILABLE':
      // "Nothing changed" only where the answer proves it (Codex review of
      // PR 366, finding 3): a 500 can follow a commit whose answer failed to
      // read back, and a 503 can be an upstream reset after the commit. A
      // connection that never opened proves it too (`neverSent`).
      if (result.neverSent) {
        return { kind: 'FAILED', status: result.status, correlationId: result.correlationId };
      }
      return provenUnwritten(result.status, result.code)
        ? { kind: 'FAILED', status: result.status, correlationId: result.correlationId }
        : { kind: 'UNCONFIRMED', correlationId: result.correlationId };
    case 'IN_PROGRESS':
    case 'UNKNOWN_OUTCOME':
      // Sent, maybe committed, not confirmed: never "nothing was changed". The
      // portal does not send it again for the person.
      return { kind: 'UNCONFIRMED', correlationId: result.correlationId };
  }
}

export async function runRegister(
  command: Pick<
    SupplierCommandSpec<RegisterFormValues, RegisterBody, RegisterField>,
    'valuesOf' | 'parse'
  >,
  form: FormData,
): Promise<SupplierFormState<RegisterFormValues, RegisterField>> {
  const gated = await gate(form);
  if (!gated.ok) return gated.state;

  const held = await heldState(gated.session, null);
  if (held) return held;

  const values = command.valuesOf(form);
  const parsed = command.parse(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId: gated.submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const sent = await sendReserved(gated.session, null, gated.submissionId, parsed.body, () =>
    registerSupplier(gated.session, parsed.body),
  );
  if (!sent.sent) return sent.state;
  const { result } = sent;
  if (result.kind === 'CREATED') {
    redirect(supplierPath(result.data.id, mintFlash(gated.session, result.data.id, 'registered')));
  }
  return failure(result, gated.submissionId, values);
}

export async function runOnSupplier<V, B, F extends string>(
  command: SupplierCommandSpec<V, B, F>,
  /** The page's own supplier, bound by the form — never a field of it. */
  supplierId: string,
  form: FormData,
): Promise<SupplierFormState<V, F>> {
  const gated = await gate(form);
  if (!gated.ok) return gated.state;
  const { session, submissionId } = gated;

  // The supplier and qualification come from here and from nowhere else.
  const baseline = openSupplierBaseline(session, form.get(BASELINE_FIELD), command.command);
  if (!baseline) return { kind: 'REFUSED', reason: 'BASELINE' };

  // A baseline is valid for **its** supplier, and this form belongs to the page's.
  if (baseline.supplierId !== supplierId) return { kind: 'REFUSED', reason: 'BASELINE' };

  // A decision names the qualification it decides, and no other command does.
  const decides =
    command.command === 'APPROVE_QUALIFICATION' || command.command === 'REJECT_QUALIFICATION';
  if (decides !== (baseline.qualificationId !== null)) {
    return { kind: 'REFUSED', reason: 'BASELINE' };
  }
  // A reinstatement names the open episode it lifts; a suspension may name the
  // newest one or none; nothing else names any.
  if (
    command.command === 'REINSTATE'
      ? baseline.suspensionId === null
      : command.command !== 'SUSPEND' && baseline.suspensionId !== null
  ) {
    return { kind: 'REFUSED', reason: 'BASELINE' };
  }

  // An earlier write on this supplier is unresolved: nothing new goes out, and
  // nothing the person typed here replaces its warning.
  const held = await heldState(session, supplierId);
  if (held) return held;

  const values = command.valuesOf(form);
  const parsed = command.parse(values);
  if (!parsed.ok) {
    return {
      kind: 'INVALID',
      submissionId,
      values,
      fieldErrors: parsed.fieldErrors,
      message: null,
    };
  }

  const sent = await sendReserved(
    session,
    supplierId,
    submissionId,
    {
      command: command.command,
      supplierId,
      qualificationId: baseline.qualificationId,
      body: parsed.body,
    },
    () => command.send(session, baseline, parsed.body),
  );
  if (!sent.sent) return sent.state;
  const { result } = sent;

  if (result.kind === 'CREATED') {
    // Redirect, not state: a refreshed page must not resubmit, and the page the
    // person lands on reads the supplier again, so it shows what the command did.
    redirect(
      supplierPath(baseline.supplierId, mintFlash(session, baseline.supplierId, command.notice)),
    );
  }

  if (result.kind === 'INVALID' && result.message === STALE_MESSAGE) {
    // The same stale page would be refused again, so the typed values are not
    // offered back for another try: the person sees the record as it is.
    redirect(supplierPath(baseline.supplierId, mintFlash(session, baseline.supplierId, 'stale')));
  }
  return failure(result, submissionId, values);
}
