import type { ReactNode } from 'react';

import { Alert, EmptyState, ErrorState, IsolatedText, Section, StatusBadge } from '@/ui';
import type { WindowState } from '@/lib/fleet-availability-fields';
import { blockerWording, type BlockerImposedBy } from '@/lib/availability-wording';
import { formatJalaliDateLong } from '@/lib/format';
import type { ReadResult } from '@/server/assets';
import {
  isRevocable,
  windowStateOf,
  type AvailabilityWindow,
  type AvailabilityWindows,
  type MachineAvailability,
} from '@/server/fleet-availability';

/**
 * A machine's availability on `/assets/[id]` (EXP-002, slice 7): whether it can
 * be dispatched, every reason it cannot with the service that owns each, the
 * declarations a fleet manager made about it — and, for the roles that may, the
 * forms to declare and to withdraw one.
 *
 * Pure, like the dossier next to it: every state is reachable in a test.
 *
 * ## One control, drawn around one kind of blocker
 *
 * A *declaration* is a window with an id and can be withdrawn; the control is
 * rendered beside each declaration still in force or not yet begun, through the
 * `revoke` slot. A block the platform imposes — an expired policy, a failed
 * inspection, a repair, a status that does not dispatch, an assignment — is not
 * a window, so this component has **no** control for it, whatever the role.
 * Declaring a machine available does not lift one (fleet-service says so on the
 * route), and the page says it too.
 *
 * ## "In force" is the server's judgement
 *
 * Each declaration's state is decided here from `now`, the clock of the server
 * that drew the page, and written into the markup. This component has no hooks
 * and is never a client component, so the visitor's clock cannot move a
 * declaration between states on their screen.
 */

export interface AssetAvailabilityProps {
  readonly availability: ReadResult<MachineAvailability | null>;
  readonly windows: ReadResult<AvailabilityWindows>;
  /** The machine's lifecycle status, to word an `ASSET_STATUS` blocker. */
  readonly assetStatus?: string;
  /** The server's clock when the page was drawn. */
  readonly now: Date;
  /** The form that declares availability, when this person may use it. */
  readonly declareForm?: ReactNode;
  /** The control that withdraws one declaration, when this person may use it. */
  readonly revoke?: (window: AvailabilityWindow) => ReactNode;
}

/** The badge each state wears, from the statuses `StatusBadge` already tabulates (docs/16 § 16.5). */
const STATE_BADGE: Readonly<Record<WindowState, { status: string; label: string }>> = {
  IN_FORCE: { status: 'ACTIVE', label: 'در اجرا' },
  SCHEDULED: { status: 'PENDING', label: 'هنوز آغاز نشده' },
  ENDED: { status: 'IDLE', label: 'پایان‌یافته' },
  REVOKED: { status: 'IDLE', label: 'باطل‌شده' },
};

const IMPOSED_BY_NOTE: Readonly<Record<BlockerImposedBy, string>> = {
  DECLARATION: 'اعلام ناوگان — در فهرست اعلام‌ها قابل ابطال است',
  PLATFORM: 'مانعی که سامانه اعمال می‌کند — از این صفحه برداشته نمی‌شود',
  ASSIGNMENT: 'تخصیص فعال — در بخش تخصیص‌ها پایان می‌یابد',
};

function Failure({
  result,
  what,
}: {
  result: Exclude<ReadResult<unknown>, { kind: 'OK' }>;
  what: string;
}) {
  switch (result.kind) {
    case 'FORBIDDEN':
      return <Alert tone="info">اجازهٔ دیدن {what} این دارایی به شما داده نشده است.</Alert>;
    case 'NOT_FOUND':
      return (
        <EmptyState
          title="این دارایی پیدا نشد"
          description="شناسه اشتباه است یا در سازمان فعال شما نیست."
        />
      );
    case 'UNAVAILABLE':
      return <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />;
    case 'MALFORMED':
      return <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />;
  }
}

function Composed({
  machine,
  assetStatus,
}: {
  machine: MachineAvailability | null;
  assetStatus: string | undefined;
}) {
  if (machine === null) {
    return (
      <Alert tone="info" title="وضعیت اعزام هنوز در ناوگان نیامده است">
        ناوگان این دارایی را هنوز نشناخته است؛ معمولاً چند لحظه پس از ثبت یا فعال‌سازی دارایی همگام
        می‌شود. صفحه را کمی بعد تازه کنید.
      </Alert>
    );
  }

  if (machine.available) {
    return (
      <Alert tone="success" title="برای اعزام آزاد است">
        هیچ مانعی در ناوگان برای اعزام این دارایی ثبت نشده است.
      </Alert>
    );
  }

  return (
    <Alert tone="danger" title="هم‌اکنون قابل اعزام نیست">
      <ul className="flex flex-col gap-2" data-testid="availability-blockers">
        {machine.blockers.map((blocker, index) => {
          const wording = blockerWording(blocker, assetStatus);
          return (
            <li
              key={`${blocker.code}-${blocker.cause ?? ''}-${index}`}
              data-blocker={blocker.code}
              data-imposed-by={wording.imposedBy}
              className="flex flex-col gap-0.5"
            >
              <span>{wording.title}</span>
              <span className="text-sm text-content-muted">
                {IMPOSED_BY_NOTE[wording.imposedBy]} · مالک این واقعیت: {wording.owner}
              </span>
            </li>
          );
        })}
      </ul>
    </Alert>
  );
}

function Windows({
  windows,
  now,
  revoke,
}: {
  windows: AvailabilityWindows;
  now: Date;
  revoke?: (window: AvailabilityWindow) => ReactNode;
}) {
  if (windows.items.length === 0) {
    return (
      <EmptyState
        title="اعلامی ثبت نشده"
        description="اعلام «غیرقابل‌استفاده» برای مدتی، دارایی را از فهرست اعزام کنار می‌گذارد؛ اعلام «قابل‌استفاده» مانعی را که سامانه اعمال کرده برنمی‌دارد."
      />
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-4" data-testid="availability-windows">
        {windows.items.map((window) => {
          const state = windowStateOf(window, now);
          const badge = STATE_BADGE[state];
          return (
            <li
              key={window.id}
              data-window-id={window.id}
              data-state={state}
              data-declares={window.available ? 'available' : 'unavailable'}
              className="flex flex-col gap-3 rounded-lg border border-border p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={badge.status} label={badge.label} />
                <span className="font-medium text-content">
                  {window.available ? 'قابل‌استفاده اعلام شده' : 'غیرقابل‌استفاده اعلام شده'}
                </span>
              </div>
              <dl className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs text-content-subtle">دوره</dt>
                  <dd className="text-sm text-content">
                    از {formatJalaliDateLong(window.fromAt)}{' '}
                    {window.toAt ? `تا ${formatJalaliDateLong(window.toAt)}` : 'تا ابطال'}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs text-content-subtle">دلیل</dt>
                  <dd className="text-sm text-content">
                    <IsolatedText>{window.reason}</IsolatedText>
                  </dd>
                </div>
                {window.revokedAt ? (
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-xs text-content-subtle">ابطال در</dt>
                    <dd className="text-sm text-content">
                      {formatJalaliDateLong(window.revokedAt)}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {revoke && isRevocable(state) ? revoke(window) : null}
            </li>
          );
        })}
      </ul>
      {windows.hasMore ? (
        <p className="text-sm text-content-muted">
          اعلام‌های قدیمی‌تر در این فهرست نیامده‌اند؛ فقط تازه‌ترین‌ها نشان داده می‌شوند.
        </p>
      ) : null}
    </>
  );
}

export function AssetAvailability({
  availability,
  windows,
  assetStatus,
  now,
  declareForm,
  revoke,
}: AssetAvailabilityProps) {
  return (
    <Section
      headingId="availability"
      title="آمادگی اعزام در ناوگان"
      description="موانعی که سامانه اعمال می‌کند (بیمه، معاینه، تعمیر، وضعیت دارایی) با رفع علتشان برداشته می‌شوند و از این‌جا قابل ابطال نیستند؛ فقط اعلام‌های ناوگان ابطال می‌شوند."
    >
      {availability.kind === 'OK' ? (
        <Composed machine={availability.data} assetStatus={assetStatus} />
      ) : (
        <Failure result={availability} what="آمادگی اعزام" />
      )}

      <h3 className="mt-6 text-base font-medium text-content">اعلام‌های ناوگان</h3>
      {windows.kind === 'OK' ? (
        <Windows windows={windows.data} now={now} revoke={revoke} />
      ) : (
        <Failure result={windows} what="اعلام‌های" />
      )}
      {declareForm}
    </Section>
  );
}
