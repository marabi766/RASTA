'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Alert, Button } from '@/ui';
import type { AccountTags, Held, QuarantineSource } from '@/lib/unresolved-tenancy';

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
 * words. Then the warning is drawn **beside** the form, which stays mounted:
 * what it shows (another request's own uncertainty view, typed text) is not
 * thrown away, and the store refuses a fresh save while the hold lasts. An acknowledgement that could not be written lifts nothing, and the
 * person is told so in fixed words, with a next step that does not rest on a
 * list's silence (R2).
 */

export const QUARANTINE_TITLE = 'درخواستی پیشین روی این دستگاه نتیجه‌ی نامعلومی دارد';

export const QUARANTINE_TEXT =
  'پیش‌تر از همین مرورگر درخواستی از همین نوع فرستاده شده که پاسخش نرسیده است. نمی‌دانیم انجام شده یا نه، و نمی‌توان گفت برای کدام حساب یا سازمان بوده است؛ برای همین چیزی از آن نشان داده نمی‌شود و دوباره هم فرستاده نمی‌شود. اگر درخواست تازه‌ای بفرستید، ممکن است همان کار دو بار انجام شود. پیش از ادامه، فهرست‌های مربوط را بررسی کنید.';

export const QUARANTINE_CONFIRM = 'می‌دانم که درخواست تازه ممکن است همان کار را دوباره انجام دهد.';

export const QUARANTINE_CONTINUE = 'ادامه با درخواست تازه';

export const QUARANTINE_ACK_FAILED =
  'پذیرش شما در این مرورگر ذخیره نشد، پس فرم تازه باز نمی‌شود و چیزی هم فرستاده نشده است؛ شاید فضای ذخیره‌سازی مرورگر پر باشد. پیش از هر کار دیگر فهرست‌های مربوط را ببینید و به یاد داشته باشید که نبودن یک درخواست در فهرست به این معنا نیست که انجام نشده است. سپس صفحه را تازه کنید و دوباره بپذیرید.';

export function QuarantineGate({
  source,
  account,
  children,
}: {
  readonly source: QuarantineSource;
  readonly account: AccountTags;
  readonly children: ReactNode;
}) {
  // Primitive dependencies: a new array of the same tags is not a new person.
  const person = account.person;
  const legacy = account.legacy.join(' ');
  const [held, setHeld] = useState<readonly Held[]>([]);
  /** Held after the form was drawn: the warning goes beside it, never in its place. */
  const [beside, setBeside] = useState(false);
  const blocking = useRef(false);
  const [confirmed, setConfirmed] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirmId = useId();

  useEffect(() => {
    const read = () => source.held({ person, legacy: legacy === '' ? [] : legacy.split(' ') });
    const first = read();
    blocking.current = first.length > 0;
    setHeld(first);
    setBeside(false);
    return source.subscribe(() => {
      setHeld(read());
      if (!blocking.current) setBeside(true);
    });
  }, [source, person, legacy]);

  const acknowledge = () => {
    // Never "done" after a write that failed: the hold stays and the person is told.
    setFailed(source.acknowledge(person, held) === 'FAILED');
    setConfirmed(false);
    setHeld(source.held({ person, legacy: legacy === '' ? [] : legacy.split(' ') }));
  };

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

  if (held.length > 0 && !beside) return warning;
  // One shape either way, so the form keeps its place and its state.
  return (
    <>
      {held.length > 0 ? warning : null}
      {children}
    </>
  );
}
