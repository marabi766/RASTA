import type { ApiError } from '@rasta/contracts';
import { AlertOctagon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../cn';
import { Identifier } from '../text/Identifier';

/**
 * The error half of the three states docs/16 § 16.4 makes mandatory.
 *
 * The document is exact about what it must carry: *«پیام قابل فهم + دکمه تلاش
 * دوباره + correlationId برای پشتیبانی»*, and the third is the one that is
 * always dropped. Without it a support conversation starts with "it said
 * something went wrong" and nobody can find the request in a log. With it,
 * one string takes an engineer straight to the trace. So `correlationId` is a
 * required prop, not an optional nicety.
 *
 * It comes from `ApiError` in `@rasta/contracts` — the same shape every Rasta
 * service returns — so the portal reads the field the platform actually sends
 * rather than a name someone chose here.
 *
 * Two things are deliberately **not** shown: the error `code` and any server
 * detail. A code means nothing to the person reading it, and a stack or a
 * database message is exactly the sort of thing that must not reach a screen
 * (ADR-035). The code is still on the element as a data attribute, where a
 * test or a support tool can read it and a user cannot be confused by it.
 */
export function ErrorState({
  correlationId,
  title = 'انجام نشد',
  description = 'درخواست به نتیجه نرسید. لطفاً دوباره تلاش کنید.',
  code,
  onRetry,
  retryLabel = 'تلاش دوباره',
  className,
}: {
  /** From the failed response. docs/16 § 16.4 requires it on screen. */
  correlationId: string;
  title?: ReactNode;
  description?: ReactNode;
  /** The platform error code, for support tooling rather than for the user. */
  code?: ApiError['code'];
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      data-error-code={code}
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-danger bg-danger-surface px-6 py-10 text-center',
        className,
      )}
    >
      <AlertOctagon aria-hidden="true" className="size-10 text-danger" />
      <p className="text-base font-semibold text-danger-text">{title}</p>
      <p className="max-w-prose text-sm leading-relaxed text-danger-text">{description}</p>

      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-text hover:bg-accent-hover"
        >
          {retryLabel}
        </button>
      ) : null}

      <p className="mt-2 text-xs text-danger-text">
        کد پیگیری برای پشتیبانی: <Identifier>{correlationId}</Identifier>
      </p>
    </div>
  );
}
