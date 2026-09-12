'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ScenarioProvider, useScenario } from '@/lib/demo/scenario';

/**
 * Native buttons rather than the shared `Button` primitive: this control
 * needs to move focus itself (to the confirm button on entering
 * `confirming`, back to the trigger on cancel), and `Button` in
 * `ui/primitives.tsx` is a plain function component that does not forward a
 * `ref`. Styled to match it exactly rather than introducing a second look.
 */
const BUTTON_CLASS =
  'inline-flex min-h-[var(--tap)] items-center justify-center gap-2 rounded-[var(--radius-md)] px-4 text-sm font-semibold transition-colors duration-150';
const SECONDARY_CLASS =
  'border border-[var(--control-border)] bg-[var(--surf)] text-[var(--tx)] hover:bg-[var(--sunken)]';
const QUIET_CLASS = 'text-[var(--pri-tx)] hover:bg-[var(--pri-soft)]';

type Phase = 'idle' | 'confirming' | 'done';

/**
 * Reset, with a confirmation step — never a single click away.
 *
 * ## Focus and announcement
 *
 * Entering `confirming` moves focus to the confirm button, so a keyboard
 * user who just pressed the trigger does not have to hunt for where the
 * dialog landed. Cancelling returns focus to the trigger. Confirming calls
 * `reset()` and moves focus to the success status — the same `aria-live`
 * pattern `DemoModeBanner` uses (`role="note" aria-live="polite"`), so a
 * screen-reader user is told the reset happened without anything being
 * visually startling.
 *
 * This is a plain three-state toggle, not a modal: nothing here traps focus
 * or dims the rest of the page, because the whole interaction is three short
 * sentences in the presentation toolbar, not a separate surface.
 */
function ScenarioResetControlInner(): ReactNode {
  const { reset } = useScenario();
  const [phase, setPhase] = useState<Phase>('idle');

  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  // Tracks the phase this render moved *from*, so focus is only stolen on a
  // genuine transition (cancel → idle) and never on the initial mount, which
  // also starts at `idle`.
  const previousPhase = useRef<Phase>('idle');

  useEffect(() => {
    if (phase === 'confirming') confirmRef.current?.focus();
    if (phase === 'done') statusRef.current?.focus();
    if (phase === 'idle' && previousPhase.current === 'confirming') triggerRef.current?.focus();
    previousPhase.current = phase;
  }, [phase]);

  useEffect(() => {
    if (phase !== 'done') return;
    const timer = setTimeout(() => setPhase('idle'), 4000);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === 'idle') {
    return (
      <button
        ref={triggerRef}
        type="button"
        className={`${BUTTON_CLASS} ${SECONDARY_CLASS}`}
        onClick={() => setPhase('confirming')}
      >
        بازنشانی سناریوی نمایشی
      </button>
    );
  }

  if (phase === 'confirming') {
    return (
      <div
        role="group"
        aria-label="تأیید بازنشانی سناریو"
        className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-[var(--warn)] bg-[var(--warn-soft)] px-3 py-2"
      >
        <span className="text-sm font-semibold text-[var(--warn-tx)]">
          تمام پیشرفت این سناریو از بین می‌رود. مطمئنید؟
        </span>
        <button
          ref={confirmRef}
          type="button"
          className={`${BUTTON_CLASS} ${SECONDARY_CLASS}`}
          onClick={() => {
            reset();
            setPhase('done');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setPhase('idle');
          }}
        >
          بازنشانی
        </button>
        <button
          type="button"
          className={`${BUTTON_CLASS} ${QUIET_CLASS}`}
          onClick={() => setPhase('idle')}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setPhase('idle');
          }}
        >
          انصراف
        </button>
      </div>
    );
  }

  return (
    <p
      ref={statusRef}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      className="rounded-[var(--radius-md)] border border-[var(--ok)] bg-[var(--ok-soft)] px-3 py-2 text-sm font-semibold text-[var(--ok-tx)]"
    >
      سناریوی نمایشی بازنشانی شد.
    </p>
  );
}

export default function ScenarioResetControl(): ReactNode {
  return (
    <ScenarioProvider>
      <ScenarioResetControlInner />
    </ScenarioProvider>
  );
}
