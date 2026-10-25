'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';

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
 */

export const QUARANTINE_TITLE = 'درخواستی پیشین روی این دستگاه نتیجه‌ی نامعلومی دارد';

export const QUARANTINE_TEXT =
  'پیش‌تر از همین مرورگر درخواستی از همین نوع فرستاده شده که پاسخش نرسیده است. نمی‌دانیم انجام شده یا نه، و نمی‌توان گفت برای کدام حساب یا سازمان بوده است؛ برای همین چیزی از آن نشان داده نمی‌شود و دوباره هم فرستاده نمی‌شود. اگر درخواست تازه‌ای بفرستید، ممکن است همان کار دو بار انجام شود. پیش از ادامه، فهرست‌های مربوط را بررسی کنید.';

export const QUARANTINE_CONFIRM = 'می‌دانم که درخواست تازه ممکن است همان کار را دوباره انجام دهد.';

export const QUARANTINE_CONTINUE = 'ادامه با درخواست تازه';

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
  const [confirmed, setConfirmed] = useState(false);
  const confirmId = useId();

  useEffect(() => {
    setHeld(source.held({ person, legacy: legacy === '' ? [] : legacy.split(' ') }));
  }, [source, person, legacy]);

  if (held.length === 0) return <>{children}</>;

  const acknowledge = () => {
    source.acknowledge(person, held);
    setConfirmed(false);
    setHeld(source.held({ person, legacy: legacy === '' ? [] : legacy.split(' ') }));
  };

  return (
    <Alert tone="warning" title={QUARANTINE_TITLE}>
      <div className="flex flex-col gap-3">
        <p>{QUARANTINE_TEXT}</p>
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
}
