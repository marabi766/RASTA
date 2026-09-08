'use client';

import type { ReactNode } from 'react';
import { CLIENT_ERROR_CODES, type ApiFailure } from '@/lib/api/errors';
import { ErrorState, NoAccessState } from './ui/primitives';

/**
 * Renders a failed read.
 *
 * The split matters more than it looks. `403` on a route whose roles exclude
 * the caller is not a fault — the platform behaved exactly as designed, and
 * showing a red "something went wrong" card teaches the reader to distrust a
 * correct system. Same for `404`, which several services return *instead of*
 * `403` so that a probe cannot confirm a record exists.
 *
 * Everything genuinely broken keeps the correlation id, because that id is the
 * only thing that turns a support conversation into a trace lookup
 * (docs/16 § 16.4).
 */
export function ApiErrorView({
  failure,
  onRetry,
  context,
}: {
  failure: ApiFailure;
  onRetry?: () => void;
  /** What the user was trying to see, for the heading. */
  context: string;
}): ReactNode {
  if (failure.code === 'FORBIDDEN' || failure.code === 'INSUFFICIENT_ROLE') {
    return (
      <NoAccessState
        title="این بخش برای نقش شما باز نیست"
        description={
          <>
            {failure.message} این یک خطا نیست: مجوزدهی در Gateway و در خود سرویس مستقلاً بررسی
            می‌شود و نقش فعلی شما در فهرست مجاز این مسیر نیست.
          </>
        }
      />
    );
  }

  if (
    failure.code === 'TENANT_MISMATCH' ||
    failure.code === CLIENT_ERROR_CODES.TENANT_NOT_IN_MEMBERSHIPS
  ) {
    return (
      <NoAccessState
        title="سازمان فعال با این داده هم‌خوان نیست"
        description={`${failure.message} سازمان فعال را از نوار بالا تغییر دهید.`}
      />
    );
  }

  return (
    <ErrorState
      title={titleFor(failure, context)}
      message={failure.message}
      correlationId={failure.correlationId}
      onRetry={failure.retryable ? onRetry : undefined}
    />
  );
}

function titleFor(failure: ApiFailure, context: string): string {
  switch (failure.code) {
    case 'NOT_FOUND':
      return `${context} یافت نشد`;
    case 'RATE_LIMIT_EXCEEDED':
      return 'تعداد درخواست از حد مجاز گذشت';
    case 'UPSTREAM_UNAVAILABLE':
    case 'UPSTREAM_TIMEOUT':
      return 'سرویس در دسترس نیست';
    case CLIENT_ERROR_CODES.MALFORMED_RESPONSE:
      return 'پاسخ سرویس با قرارداد هم‌خوان نبود';
    case CLIENT_ERROR_CODES.NETWORK_UNAVAILABLE:
      return 'ارتباط برقرار نشد';
    case 'UNAUTHENTICATED':
    case 'TOKEN_EXPIRED':
    case 'TOKEN_INVALID':
      return 'نشست شما معتبر نیست';
    default:
      return `${context} بارگذاری نشد`;
  }
}
