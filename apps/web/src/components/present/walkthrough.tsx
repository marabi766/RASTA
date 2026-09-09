'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { PREVIEW_DISCLOSURE, capabilityByKey } from '@/lib/capabilities';
import { formatInteger } from '@/lib/format';
import { CapabilityBadge } from '../capability';
import { Button, Card, cx } from '../ui/primitives';
import { WALKTHROUGH } from './steps';

/**
 * The guided walkthrough.
 *
 * A presentation mode, not a second application: every step links into the same
 * screens the rail links to, and no business logic is forked to serve it. The
 * step list is the only thing that is new, and each step carries the two
 * sentences a presenter actually needs — what to show, and the point of showing
 * it.
 *
 * ## Why a step's status comes from the manifest
 *
 * `capabilityKey` rather than a copied badge. If a capability's status changes,
 * the walkthrough changes with it; a tour that told the audience something was
 * live after the manifest stopped saying so would be the worst possible place
 * for that inconsistency to appear.
 *
 * Keyboard: `←`/`→` move between steps, matching the arrow direction a reader
 * sees in RTL; `f` toggles presentation mode and `Escape` leaves it. The
 * listener is on the document, because a presenter should not have to click the
 * panel first to make the arrow keys work — and it ignores events coming from a
 * text field, so typing somewhere never moves the tour.
 */

export function Walkthrough(): ReactNode {
  const [index, setIndex] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  // Index is clamped by `go`, but reading it defensively keeps a future edit to
  // the step list from turning a bad index into a blank screen mid-presentation.
  const step = WALKTHROUGH[index] ?? WALKTHROUGH[0];
  if (!step) throw new Error('The walkthrough has no steps.');

  const capability = step.capabilityKey ? capabilityByKey(step.capabilityKey) : undefined;
  const target = step.href ?? capability?.href;

  const go = useCallback((delta: number) => {
    setIndex((current) => Math.min(WALKTHROUGH.length - 1, Math.max(0, current + delta)));
  }, []);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((current) => !current);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;

      // In RTL the "next" arrow points to the start of the line, so the left
      // arrow advances. Mirroring this is the whole reason it is written out.
      if (event.key === 'ArrowLeft') go(1);
      else if (event.key === 'ArrowRight') go(-1);
      else if (event.key === 'Escape') setFullscreen(false);
      else if (event.key.toLowerCase() === 'f') toggleFullscreen();
      else return;

      event.preventDefault();
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go, toggleFullscreen]);

  const body = (
    <div
      // A labelled group so anyone navigating by landmark can find the tour.
      // The keyboard shortcuts live on the document, not here.
      role="group"
      aria-label="روایت هدایت‌شده"
      className={cx(
        'flex flex-col gap-6',
        fullscreen && 'fixed inset-0 z-50 overflow-y-auto bg-[var(--bg)] p-6 sm:p-10 lg:p-16',
      )}
    >
      <StepProgress index={index} onSelect={setIndex} />

      <Card className="flex-1">
        <p className="text-xs font-semibold text-[var(--tx3)]">
          {/* Two separate spans rather than one string joined by a middot. A
              neutral character sitting between two numbers in an RTL paragraph
              is reordered by the bidi algorithm — «گام ۱ از ۸ · ۲ دقیقه»
              rendered as «گام ۱ از ۲ ۰۸ دقیقه». Splitting the runs removes the
              ambiguity rather than papering over it with an embedding mark. */}
          <span>
            گام {formatInteger(index + 1)} از {formatInteger(WALKTHROUGH.length)}
          </span>
          <span className="mx-2 text-[var(--bd2)]" aria-hidden="true">
            |
          </span>
          <span>زمان پیشنهادی: {formatInteger(step.minutes)} دقیقه</span>
        </p>

        <h2
          className={cx(
            'mt-2 font-extrabold text-[var(--tx)]',
            fullscreen ? 'text-3xl' : 'text-2xl',
          )}
        >
          {step.title}
        </h2>

        <div className="mt-5 space-y-4">
          <div>
            <p className="text-xs font-bold text-[var(--tx3)]">چه چیزی نشان دهید</p>
            <p className={cx('mt-1 text-[var(--tx)]', fullscreen ? 'text-lg' : 'text-base')}>
              {step.action}
            </p>
          </div>
          <div>
            <p className="text-xs font-bold text-[var(--tx3)]">نکتهٔ اصلی</p>
            <p
              className={cx(
                'mt-1 leading-relaxed text-[var(--tx2)]',
                fullscreen ? 'text-lg' : 'text-base',
              )}
            >
              {step.point}
            </p>
          </div>
        </div>

        {capability ? (
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-[var(--bd)] pt-4">
            <CapabilityBadge state={capability.state} />
            <span className="text-xs text-[var(--tx3)]">
              وضعیت این قابلیت از همان Manifest خوانده می‌شود که ناوبری و داشبورد از آن می‌خوانند.
            </span>
          </div>
        ) : null}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => go(-1)} disabled={index === 0}>
            گام پیشین
          </Button>
          <Button onClick={() => go(1)} disabled={index === WALKTHROUGH.length - 1}>
            گام بعدی
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          {target ? (
            <Link
              href={target}
              className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm font-semibold text-[var(--tx)] hover:bg-[var(--sunken)]"
            >
              رفتن به این صفحه
            </Link>
          ) : null}
          <Button variant="secondary" onClick={toggleFullscreen}>
            {fullscreen ? 'خروج از حالت ارائه (Esc)' : 'حالت ارائه'}
          </Button>
        </div>
      </div>

      <p className="text-xs text-[var(--tx3)]">
        اگر سرویسی در دسترس نباشد، صفحهٔ مقصد وضعیت را صادقانه اعلام می‌کند و همین روایت سرِ جایش
        می‌ماند. {PREVIEW_DISCLOSURE} تنها روی صفحه‌هایی ظاهر می‌شود که عملیاتی نیستند.
      </p>
    </div>
  );

  return body;
}

function StepProgress({
  index,
  onSelect,
}: {
  index: number;
  onSelect: (next: number) => void;
}): ReactNode {
  return (
    <nav aria-label="گام‌های روایت">
      <ol className="flex flex-wrap gap-2">
        {WALKTHROUGH.map((step, position) => {
          const state = position === index ? 'current' : position < index ? 'done' : 'todo';

          return (
            <li key={step.id}>
              <button
                type="button"
                onClick={() => onSelect(position)}
                aria-current={state === 'current' ? 'step' : undefined}
                className={cx(
                  'min-h-[var(--tap)] rounded-[var(--radius-md)] border px-3 text-xs font-semibold',
                  state === 'current' && 'border-[var(--pri)] bg-[var(--pri)] text-white',
                  state === 'done' &&
                    'border-[var(--pri)] bg-[var(--pri-soft)] text-[var(--pri-tx)]',
                  state === 'todo' && 'border-[var(--control-border)] text-[var(--tx2)]',
                )}
              >
                {/* The number is not decoration: it is how a presenter says
                    "back to three" out loud without hunting for the title. */}
                {formatInteger(position + 1)}. {step.title}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Whether a keystroke belongs to somebody typing.
 *
 * Without this, a single-letter shortcut would fire while the reader is filling
 * in a search box — the classic failure of a global hotkey.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
