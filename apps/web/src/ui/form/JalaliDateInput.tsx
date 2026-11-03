'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';

import { jalaliOfCalendarDay, jalaliOfWallClock } from '@/lib/format';

/**
 * A native date (or date-and-time) input that says which calendar it is in and
 * shows what it holds in Jalali.
 *
 * The browser's own control is Gregorian and Latin whatever the page is: the
 * demo run (2026-10-24, defect 7) showed «mm/dd/yyyy» on a screen where every
 * other date is Jalali. docs/16 § 16.3 asks for Jalali input; a full Jalali
 * picker is a separate follow-up, and until then this is the honest interim:
 *
 *  - a line under the control that **names the format** in Persian (always in
 *    the HTML, so it is there without JavaScript too);
 *  - once the page runs, the chosen day **in Jalali** beside it, the one the
 *    server will store (`jalaliOfCalendarDay` is pinned to the servers' own
 *    Tehran readings), announced politely when it changes.
 *
 * Nothing about the value changes: the input keeps its `name`, its
 * `defaultValue` and its native `YYYY-MM-DD` / `YYYY-MM-DDTHH:mm` value, so the
 * calendar-day and instant semantics of the actions are untouched, and an empty
 * or impossible value is still sent as it is and refused by the server.
 *
 * The echo reads the element, not React state: React 19 resets an uncontrolled
 * form after its action answers, which fires no `change`, so the echo also
 * listens for the form's `reset` and re-reads when the default changes.
 */
export type JalaliDateInputProps = Omit<ComponentPropsWithoutRef<'input'>, 'type'> & {
  type: 'date' | 'datetime-local';
};

const FORMAT_LINE: Record<JalaliDateInputProps['type'], string> = {
  date: 'تاریخ را میلادی و به قالب مرورگر وارد کنید؛ معادل شمسی آن در همین‌جا دیده می‌شود.',
  'datetime-local':
    'تاریخ را میلادی و به قالب مرورگر، ساعت را به وقت تهران وارد کنید؛ معادل شمسی آن در همین‌جا دیده می‌شود.',
};

function echoOf(type: JalaliDateInputProps['type'], value: string): string | null {
  return type === 'date' ? jalaliOfCalendarDay(value) : jalaliOfWallClock(value);
}

export function JalaliDateInput({ type, ...input }: JalaliDateInputProps): ReactNode {
  const ref = useRef<HTMLInputElement>(null);
  const base = useId();
  const formatId = `${base}-format`;
  const echoId = `${base}-jalali`;
  const [echo, setEcho] = useState<string | null>(null);
  const ready = useHydrated();
  const defaultValue = input.defaultValue;

  // `defaultValue` in the dependencies: a refused form comes back with its own
  // value in the DOM without an event the listeners would see.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => setEcho(echoOf(type, element.value));
    const afterReset = () => setTimeout(read, 0);
    read();
    element.addEventListener('input', read);
    element.addEventListener('change', read);
    element.form?.addEventListener('reset', afterReset);
    return () => {
      element.removeEventListener('input', read);
      element.removeEventListener('change', read);
      element.form?.removeEventListener('reset', afterReset);
    };
  }, [type, defaultValue]);

  const describedBy = [input['aria-describedby'], formatId, ready ? echoId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <input {...input} ref={ref} type={type} aria-describedby={describedBy} />
      <p id={formatId} className="text-xs text-content-subtle">
        {FORMAT_LINE[type]}
      </p>
      {ready ? (
        <output
          id={echoId}
          htmlFor={input.id}
          className="text-sm text-content"
          data-testid="jalali-echo"
        >
          {echo ? `معادل شمسی: ${echo}` : 'تاریخی انتخاب نشده است'}
        </output>
      ) : null}
    </>
  );
}

const subscribeNever = () => () => undefined;

/** False in the server's HTML and while hydrating, true once the client runs. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}
