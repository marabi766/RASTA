'use client';

import { Fragment, useEffect, useId, useState, type ReactNode } from 'react';

import { Alert, Button } from '@/ui';
import type { AccountTags, Binding, Held, QuarantineSource } from '@/lib/unresolved-tenancy';

/**
 * What a form of one kind shows while a record this person cannot be shown
 * holds that kind on this device (`lib/unresolved-tenancy.ts`; PR 405 review
 * 2, F1): an earlier request whose outcome is unknown, from an organization
 * this person's token no longer lists, from another person, or one that no
 * longer reads. Nobody can be told whose it was, so nothing of it is shown —
 * the copy is fixed — and nothing re-sends it.
 *
 * The form is replaced until the person accepts, explicitly, that a fresh
 * request may do the same thing twice. That acceptance covers exactly the
 * records this warning was drawn for (`acknowledge`): it lifts the hold for
 * this person only, removes nothing and sends nothing. The store refuses to
 * save a fresh submission while a record is held (`mayStartFresh`), so a press
 * that beats this check still sends nothing.
 *
 * The gate reads again when a record of its kind is newly held — a late answer
 * kept aside after the person set its request aside and started another (PR
 * 405 review 3, R1) — so that outcome is shown at once, in the same fixed
 * words. An acknowledgement that could not be written lifts nothing, and the
 * person is told so in fixed words, with a next step that does not rest on a
 * list's silence (R2).
 *
 * ## Admission (review 4, R4)
 *
 * The form is **admitted** once the gate has read the holds and found none —
 * at mount, or right after an acknowledgement, from a fresh read (a record
 * that changed, an acknowledgement that failed or did not read back, a new
 * generation or a memory hold read then keeps it out). From then on a later
 * hold draws the warning **beside** the form, which stays mounted, however
 * many holds came and went before: what it shows — another request's own
 * uncertainty view, typed text — is never thrown away, and the store refuses a
 * fresh save while the hold lasts. Admission is the same person's, in the same
 * organization, from the same login: another identity starts over, and its
 * form is drawn anew (keyed by identity), never with the first one's state.
 */

export const QUARANTINE_TITLE = 'درخواستی پیشین روی این دستگاه نتیجه‌ی نامعلومی دارد';

export const QUARANTINE_TEXT =
  'پیش‌تر از همین مرورگر درخواستی از همین نوع فرستاده شده که پاسخش نرسیده است. نمی‌دانیم انجام شده یا نه، و نمی‌توان گفت برای کدام حساب یا سازمان بوده است؛ برای همین چیزی از آن نشان داده نمی‌شود و دوباره هم فرستاده نمی‌شود. اگر درخواست تازه‌ای بفرستید، ممکن است همان کار دو بار انجام شود. پیش از ادامه، فهرست‌های مربوط را بررسی کنید.';

export const QUARANTINE_CONFIRM = 'می‌دانم که درخواست تازه ممکن است همان کار را دوباره انجام دهد.';

export const QUARANTINE_CONTINUE = 'ادامه با درخواست تازه';

export const QUARANTINE_ACK_FAILED =
  'پذیرش شما در این مرورگر ذخیره نشد، پس فرم تازه باز نمی‌شود و چیزی هم فرستاده نشده است؛ شاید فضای ذخیره‌سازی مرورگر پر باشد. پیش از هر کار دیگر فهرست‌های مربوط را ببینید و به یاد داشته باشید که نبودن یک درخواست در فهرست به این معنا نیست که انجام نشده است. سپس صفحه را تازه کنید و دوباره بپذیرید.';

/** Who the gate admits for: a person, and — where the page knows them — their organization and login. */
export type GateAccount = AccountTags & Partial<Pick<Binding, 'owner' | 'session'>>;

export function QuarantineGate({
  source,
  account,
  children,
}: {
  readonly source: QuarantineSource;
  readonly account: GateAccount;
  readonly children: ReactNode;
}) {
  // Primitive dependencies: a new array of the same tags is not a new person.
  const person = account.person;
  const legacy = account.legacy.join(' ');
  const identity = [person, account.owner ?? '', account.session ?? '', legacy].join('|');
  const [held, setHeld] = useState<readonly Held[]>([]);
  /** Null until the holds are read; then, for whom they were read and whether the form is admitted. */
  const [admitted, setAdmitted] = useState<{
    readonly identity: string;
    readonly yes: boolean;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirmId = useId();

  useEffect(() => {
    const read = () => source.held({ person, legacy: legacy === '' ? [] : legacy.split(' ') });
    const first = read();
    setHeld(first);
    setAdmitted({ identity, yes: first.length === 0 });
    setConfirmed(false);
    setFailed(false);
    // A later hold changes what is held, never whether the form is admitted.
    return source.subscribe(() => setHeld(read()));
  }, [source, person, legacy, identity]);

  const acknowledge = () => {
    // Never "done" after a write that failed: the hold stays and the person is told.
    setFailed(source.acknowledge(person, held) === 'FAILED');
    setConfirmed(false);
    // Admitted only on what is held now, read again after the acknowledgement.
    const now = source.held({ person, legacy: legacy === '' ? [] : legacy.split(' ') });
    setHeld(now);
    if (now.length === 0) setAdmitted({ identity, yes: true });
  };

  // Not read yet for this identity: the form as the server draws it — fresh, keyed by
  // identity, so nothing of another identity's is kept — until the read decides.
  const read = admitted !== null && admitted.identity === identity;

  const warning = (
    <Alert tone="warning" title={QUARANTINE_TITLE}>
      <div className="flex flex-col gap-3">
        <p>{QUARANTINE_TEXT}</p>
        {failed ? <Alert tone="danger">{QUARANTINE_ACK_FAILED}</Alert> : null}
        <label htmlFor={confirmId} className="flex items-start gap-2">
          <input
            id={confirmId}
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            aria-labelledby={`${confirmId}-text`}
          />
          <span id={`${confirmId}-text`}>{QUARANTINE_CONFIRM}</span>
        </label>
        <div>
          <Button type="button" tone="secondary" disabled={!confirmed} onClick={acknowledge}>
            {QUARANTINE_CONTINUE}
          </Button>
        </div>
      </div>
    </Alert>
  );

  if (read && !admitted.yes) return held.length > 0 ? warning : null;
  // One shape before the read and while admitted, so the form keeps its place and its state.
  return (
    <>
      {read && held.length > 0 ? warning : null}
      <Fragment key={identity}>{children}</Fragment>
    </>
  );
}

/** A form's own unresolved submission, as its starting state. */
export interface RestoredStart<S> {
  readonly submissionId: string;
  readonly state: S;
}

/**
 * The one way a fenced form is drawn (all seven kinds): behind its kind's
 * gate, and — **every time it mounts** — starting from what storage keeps of
 * its own submission (`restore`), never from an idle state over a key whose
 * outcome is unknown. A mounted form keeps its state across later holds
 * (`QuarantineGate`); a form drawn anew — a reload, another identity, the gate
 * admitting it after a hold present at mount — restores. A store that keeps
 * markers only (bid, tender owner command) restores its view-only marker.
 *
 * `restore` is read at mount only, per `scope`: afterwards the form's own state
 * is the truth, and a record written by its own send must not redraw it.
 */
export function UnresolvedForm<S>({
  source,
  account,
  scope,
  restore,
  children,
}: {
  readonly source: QuarantineSource;
  readonly account: GateAccount;
  /** What the slot is: a new scope is a new form. */
  readonly scope: string;
  readonly restore: () => RestoredStart<S> | null;
  readonly children: (restored: S | null) => ReactNode;
}) {
  return (
    <QuarantineGate source={source} account={account}>
      <Restoring key={scope} restore={restore}>
        {children}
      </Restoring>
    </QuarantineGate>
  );
}

function Restoring<S>({
  restore,
  children,
}: {
  readonly restore: () => RestoredStart<S> | null;
  readonly children: (restored: S | null) => ReactNode;
}) {
  const [found, setFound] = useState<RestoredStart<S> | null>(null);

  // Read once per mount: the first paint is the server's, so this runs after it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setFound(restore()), []);

  // Before the read, the form as the server draws it; a kept submission redraws it
  // from its own state (the submit path refuses a first send under a kept key meanwhile).
  return (
    <Fragment key={found ? found.submissionId : ''}>
      {children(found ? found.state : null)}
    </Fragment>
  );
}
