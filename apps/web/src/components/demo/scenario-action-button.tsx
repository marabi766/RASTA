'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '../ui/primitives';

export interface ScenarioActivationResult {
  readonly outcome: 'APPLIED' | 'REJECTED';
  /** Persian, already translated from the reducer's rejection reason. */
  readonly message?: string;
}

/**
 * One scenario command, as a button — shared by every per-screen island so
 * the done/locked/active/rejected states look and behave the same
 * everywhere.
 *
 * Deliberately ignorant of the scenario engine's own types: it takes plain
 * strings and a callback, so this file never imports from
 * `lib/demo/scenario` and never needs a place on that module's
 * approved-importer allowlist (`fixture-integration.spec.ts`) — only the
 * panels that call it do.
 */
export function ScenarioActionButton({
  label,
  doneLabel,
  done,
  lockedReason,
  onActivate,
}: {
  label: string;
  doneLabel: string;
  done: boolean;
  /** Explains the prerequisite when the action cannot be taken yet; `null` when it can. */
  lockedReason: string | null;
  onActivate: () => ScenarioActivationResult;
}): ReactNode {
  const [rejection, setRejection] = useState<string | null>(null);

  if (done) {
    return (
      <span className="inline-flex min-h-[var(--tap)] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--ok)] bg-[var(--ok-soft)] px-4 text-sm font-semibold text-[var(--ok-tx)]">
        <span aria-hidden="true">✓</span>
        {doneLabel}
      </span>
    );
  }

  return (
    <div>
      <Button
        variant="secondary"
        disabled={lockedReason !== null}
        onClick={() => {
          const result = onActivate();
          setRejection(result.outcome === 'REJECTED' ? (result.message ?? null) : null);
        }}
      >
        {label}
      </Button>

      {lockedReason ? <p className="mt-1.5 text-xs text-[var(--tx3)]">{lockedReason}</p> : null}

      {rejection ? (
        <p role="alert" className="mt-1.5 text-xs font-semibold text-[var(--dgr-tx)]">
          {rejection}
        </p>
      ) : null}
    </div>
  );
}

/** The standing label every scenario action control must carry — distinct from the page-level fixture disclosure, because this one is about the *action*, not the page's data. */
export const SCENARIO_ACTION_DISCLOSURE =
  'سناریوی نمایشی — این کنش فقط داده‌های شبیه‌سازی‌شده را تغییر می‌دهد، نه Backend واقعی';
