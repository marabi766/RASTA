import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../cn';
import { Identifier } from '../text/Identifier';

/**
 * What a user sees where they are not permitted to look.
 *
 * It is a separate component from `ErrorState` because it is a separate fact.
 * A failed request may succeed on the next try; a refusal will not, and
 * offering a retry button teaches people to hammer an endpoint that is going
 * to keep saying no. So there is no retry here.
 *
 * What it says is also deliberately thin. docs/16 § 16.11 and the platform's
 * security rules are clear that a refusal must not describe what is behind it:
 * telling someone that "دارایی ۱۲۴ متعلق به سازمان دیگری است" confirms that
 * asset 124 exists and which organisation holds it, which is the enumeration
 * attack the object-level authorization rule exists to prevent. The message
 * names the action the user cannot take and stops there.
 *
 * The correlation id is optional here. A refusal is an expected outcome rather
 * than a fault, but if the user believes it is wrong, support still needs the
 * thread to pull.
 */
export function NoAccessState({
  title = 'دسترسی ندارید',
  description = 'برای دیدن این بخش، دسترسی لازم به حساب شما داده نشده است. اگر فکر می‌کنید اشتباهی رخ داده، با مدیر سازمانتان تماس بگیرید.',
  correlationId,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  correlationId?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-border bg-surface-sunken px-6 py-10 text-center',
        className,
      )}
    >
      <ShieldAlert aria-hidden="true" className="size-10 text-content-subtle" />
      <p className="text-base font-semibold text-content">{title}</p>
      <p className="max-w-prose text-sm leading-relaxed text-content-muted">{description}</p>
      {correlationId ? (
        <p className="mt-2 text-xs text-content-subtle">
          کد پیگیری: <Identifier>{correlationId}</Identifier>
        </p>
      ) : null}
    </div>
  );
}
