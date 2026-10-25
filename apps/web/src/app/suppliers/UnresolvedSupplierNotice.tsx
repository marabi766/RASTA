import { Alert, Button } from '@/ui';
import { CSRF_FIELD } from '@/lib/form-fields';
import { UNCONFIRMED_WRITE_MESSAGE } from '@/lib/unconfirmed-write';
import {
  HELD_IN_PROGRESS_MESSAGE,
  PENDING_UNCHECKED_MESSAGE,
  RELEASE_STALE_MESSAGE,
} from '@/lib/supplier-commands';
import {
  RECONCILED_FIELD,
  RECONCILED_VALUE,
  RELEASE_FIELD,
  supplierWriteScope,
} from '@/server/supplier-unresolved';
import type { WebSession } from '@/server/session';
import {
  releaseToken,
  type UnresolvedRead,
  type UnresolvedRequest,
} from '@/server/unresolved-request';

import { reconcileSupplierWrite } from './supplier-actions';

/**
 * Shown on a supplier page (or on `/suppliers`, for the registration) for as
 * long as an earlier write there is unresolved (`server/supplier-unresolved.ts`).
 *
 * supplier-service has no idempotency ledger, so the request cannot be sent
 * again, and no new one is accepted either: the person re-reads the record
 * (the link is this page, drawn afresh) and then confirms. The warning and its
 * correlation id stay through validation errors, navigation and reloads.
 *
 * The confirmation names the held request it was drawn for (`releaseToken`): a
 * form left open in another tab after that request was reconciled cannot
 * release a newer one.
 */
const CONFIRM_ID = 'confirm-reconciled-supplier-write';

export function UnresolvedSupplierNotice({
  request,
  supplierId,
  csrfToken,
  releaseToken: held,
}: {
  request: UnresolvedRequest;
  /** The supplier the write was about; null for the registration. */
  supplierId: string | null;
  csrfToken: string;
  /** Signed name of `request`, bound to this login. */
  releaseToken: string;
}) {
  return (
    <Alert tone="warning">
      <div className="flex flex-col gap-3" data-testid="unresolved-supplier-write">
        <p>
          {UNCONFIRMED_WRITE_MESSAGE} کد پیگیری: {request.ref ?? request.key}
        </p>
        {request.inFlight ? <p>{HELD_IN_PROGRESS_MESSAGE}</p> : null}
        <p>
          تا زمانی که این درخواست روشن نشود، درخواست تازه‌ای برای این پرونده فرستاده نمی‌شود، چون
          این سرویس کلید تکرار ندارد و ارسال دوباره می‌تواند رکورد دوم بسازد.
        </p>
        <form
          action={reconcileSupplierWrite.bind(null, supplierId)}
          className="flex flex-col gap-2"
        >
          <input type="hidden" name={CSRF_FIELD} value={csrfToken} />
          <input type="hidden" name={RELEASE_FIELD} value={held} />
          <label htmlFor={CONFIRM_ID} className="flex items-start gap-2">
            <input
              id={CONFIRM_ID}
              type="checkbox"
              name={RECONCILED_FIELD}
              value={RECONCILED_VALUE}
              aria-labelledby={`${CONFIRM_ID}-text`}
              required
            />
            <span id={`${CONFIRM_ID}-text`}>
              پرونده را دوباره خواندم و بررسی کردم که این درخواست اعمال شده است یا نه.
            </span>
          </label>
          <div>
            <Button type="submit" tone="secondary">
              بررسی کردم؛ ارسال تازه مجاز شود
            </Button>
          </div>
        </form>
      </div>
    </Alert>
  );
}

/**
 * What a supplier page shows of its slot: the notice for a held write, the
 * "could not check" warning when the store cannot say (never "nothing held"),
 * and — back from a refused reconciliation — why nothing changed.
 */
export function SupplierPendingNotices({
  session,
  pending,
  supplierId,
  release,
}: {
  session: WebSession;
  pending: UnresolvedRead;
  supplierId: string | null;
  /** The `?release=` the last reconciliation came back with. */
  release: string | undefined;
}) {
  const refused = release === 'STALE' || release === 'IN_PROGRESS' || release === 'UNAVAILABLE';
  return (
    <>
      {refused ? (
        <Alert tone="warning">
          {release === 'IN_PROGRESS'
            ? HELD_IN_PROGRESS_MESSAGE
            : release === 'UNAVAILABLE'
              ? PENDING_UNCHECKED_MESSAGE
              : RELEASE_STALE_MESSAGE}
        </Alert>
      ) : null}
      {pending.kind === 'UNAVAILABLE' ? (
        <Alert tone="warning">{PENDING_UNCHECKED_MESSAGE}</Alert>
      ) : pending.kind === 'PENDING' ? (
        <UnresolvedSupplierNotice
          request={pending.request}
          supplierId={supplierId}
          csrfToken={session.csrfToken}
          releaseToken={releaseToken(session, supplierWriteScope(supplierId), pending.request)}
        />
      ) : null}
    </>
  );
}
