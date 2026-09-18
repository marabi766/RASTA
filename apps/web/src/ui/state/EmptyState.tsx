import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../cn';

/**
 * The empty half of the three states docs/16 § 16.4 makes mandatory.
 *
 * The document's example is *«هنوز ماشین‌آلاتی ثبت نشده» + دکمه اقدام*, and the
 * action is the part that is usually missing. "No results" is a dead end; "no
 * results, and here is how to create the first one" is a screen that teaches
 * the product. So `action` is a prop a caller is expected to fill, and the
 * headline is required — a bare icon says nothing.
 *
 * Empty is not an error. It uses `role="status"` and the neutral surface, not
 * the warning colours: a new organisation with no assets yet has done nothing
 * wrong, and colouring that state like a problem is how a product makes people
 * anxious about nothing.
 */
export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** How to leave this state. A button, a link — but something. */
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong bg-surface-base px-6 py-12 text-center',
        className,
      )}
    >
      <span aria-hidden="true" className="text-content-subtle">
        {icon ?? <Inbox className="size-10" />}
      </span>
      <p className="text-base font-semibold text-content">{title}</p>
      {description ? (
        <p className="max-w-prose text-sm leading-relaxed text-content-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
