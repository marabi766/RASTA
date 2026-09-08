'use client';

import type { ReactNode } from 'react';
import { ErrorState } from '@/components/ui/primitives';

/**
 * The last line of defence.
 *
 * Reaching here means a bug in this application rather than a refusal from the
 * platform — every API failure is an `ApiFailure` and is rendered where it
 * happened. `error.digest` is Next's server-side identifier for the thrown
 * error; the message itself is deliberately not printed, because an exception
 * string can carry a URL, a header value or an internal path (S-09).
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): ReactNode {
  return (
    <ErrorState
      title="خطای پیش‌بینی‌نشده در رابط کاربری"
      message="این صفحه به‌درستی بارگذاری نشد. اگر تکرار شد، شناسهٔ زیر را به پشتیبانی بدهید."
      correlationId={error.digest ?? null}
      onRetry={reset}
      retryLabel="بارگذاری دوباره"
    />
  );
}
