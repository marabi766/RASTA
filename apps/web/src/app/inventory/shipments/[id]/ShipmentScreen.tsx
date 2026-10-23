import Link from 'next/link';

import {
  Alert,
  EmptyState,
  ErrorState,
  Identifier,
  IsolatedText,
  NoAccessState,
  Section,
  StatusBadge,
  TableScroll,
} from '@/ui';
import { formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import {
  INVENTORY_CONSIGNEE_NOTE,
  INVENTORY_DONE_MESSAGES,
  INVENTORY_READ_ONLY_NOTE,
  INVENTORY_SHIPMENT_FINISHED_NOTE,
  shipmentStatusLabel,
  type InventoryCommand,
} from '@/lib/inventory-commands';
import type { Binding } from '@/lib/unresolved-order';
import type { ReadResult, ShipmentSummary, ShipmentTracking } from '@/server/inventory';

import { InventoryCommands, type OfferedInventoryCommand } from '../../InventoryCommands';

/**
 * One shipment, its legs and its tracking history, with the dispatch and the
 * delivery for the origin warehouse's operators. A pure function of what the
 * server read, like `InventoryScreen`: every state is renderable in a test.
 *
 * Nothing here decides whether a move is allowed: `offered` is the page's copy
 * of the service's checks (`shipmentMovesFor`), and the words said where
 * nothing is offered (`canOperate`, `consigneeOnly`, the status) are fixed.
 * Tracking events are shown in the order the service gives (lifecycle order,
 * never by time).
 */
export interface ShipmentScreenProps {
  readonly shipment: ReadResult<ShipmentSummary>;
  readonly tracking: ReadResult<ShipmentTracking>;
  readonly offered: readonly OfferedInventoryCommand[];
  readonly canOperate: boolean;
  readonly consigneeOnly: boolean;
  readonly csrfToken: string;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  /** The command a signed flash confirms just happened, if any. */
  readonly notice?: InventoryCommand;
  readonly pageHref: string;
}

export function ShipmentScreen({
  shipment,
  tracking,
  offered,
  canOperate,
  consigneeOnly,
  csrfToken,
  binding,
  sessionMaxAgeSeconds,
  notice,
  pageHref,
}: ShipmentScreenProps) {
  if (shipment.kind === 'NOT_FOUND') {
    // One sentence for "does not exist" and "not yours": inventory-service
    // answers 404 for both, and this screen must not tell them apart.
    return (
      <EmptyState
        title="این محموله پیدا نشد"
        description="یا این محموله وجود ندارد، یا سازمان شما طرف آن نیست."
      />
    );
  }
  if (shipment.kind === 'FORBIDDEN') {
    return <NoAccessState description="محموله‌ها در اختیار نقش شما نیست." />;
  }
  if (shipment.kind === 'UNAVAILABLE' || shipment.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="این محموله خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={shipment.correlationId}
      />
    );
  }

  const data = shipment.data;
  return (
    <div className="flex flex-col gap-4">
      {notice ? <Alert tone="success">{INVENTORY_DONE_MESSAGES[notice]}</Alert> : null}

      <Section headingId="shipment-summary" title="وضعیت محموله">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm">
            محموله <Identifier>{data.id}</Identifier> · ایجاد در{' '}
            {formatJalaliDateLong(data.createdAt)}
          </p>
          <StatusBadge status={data.status} label={shipmentStatusLabel(data.status)} />
        </div>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-content-muted">انبار مبدا</dt>
            <dd>
              <Link
                href={`/inventory?warehouse=${encodeURIComponent(data.originWarehouseId)}`}
                className="underline"
              >
                <Identifier>{data.originWarehouseId}</Identifier>
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-content-muted">سازمان گیرنده</dt>
            <dd>
              <Identifier>{data.consigneeOrganizationId}</Identifier>
            </dd>
          </div>
          {data.orderReference ? (
            <div>
              <dt className="text-content-muted">مرجع سفارش</dt>
              <dd>
                <Identifier>{data.orderReference}</Identifier>
              </dd>
            </div>
          ) : null}
          {data.dispatchedAt ? (
            <div>
              <dt className="text-content-muted">زمان ارسال</dt>
              <dd>{formatJalaliDateLong(data.dispatchedAt)}</dd>
            </div>
          ) : null}
          {data.deliveredAt ? (
            <div>
              <dt className="text-content-muted">زمان تحویل</dt>
              <dd>{formatJalaliDateLong(data.deliveredAt)}</dd>
            </div>
          ) : null}
        </dl>
      </Section>

      <Section headingId="shipment-next" title="اقدام بعدی شما">
        <Next
          data={data}
          offered={offered}
          canOperate={canOperate}
          consigneeOnly={consigneeOnly}
          csrfToken={csrfToken}
          binding={binding}
          sessionMaxAgeSeconds={sessionMaxAgeSeconds}
          pageHref={pageHref}
        />
      </Section>

      <Section headingId="shipment-legs" title="مرحله‌های حمل">
        {data.legs.length === 0 ? (
          <EmptyState title="مرحله‌ای ثبت نشده" description="برای این محموله مرحله حملی نیست." />
        ) : (
          <TableScroll label="مرحله‌های حمل محموله">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">مرحله‌های حمل محموله</caption>
              <thead>
                <tr className="border-b border-border text-start text-content-muted">
                  <th scope="col" className="p-3 text-start font-medium">
                    مرحله
                  </th>
                  <th scope="col" className="p-3 text-start font-medium">
                    حمل‌کننده
                  </th>
                  <th scope="col" className="p-3 text-start font-medium">
                    شماره پیگیری
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.legs.map((leg) => (
                  <tr key={leg.sequence} className="border-b border-border">
                    <td className="p-3">{toPersianDigits(String(leg.sequence))}</td>
                    <td className="p-3">
                      <IsolatedText>{leg.carrierName}</IsolatedText>
                    </td>
                    <td className="p-3">
                      {leg.carrierReference ? <Identifier>{leg.carrierReference}</Identifier> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>

      <Section headingId="shipment-tracking" title="پیگیری محموله">
        <Tracking result={tracking} />
      </Section>
    </div>
  );
}

function Next({
  data,
  offered,
  canOperate,
  consigneeOnly,
  csrfToken,
  binding,
  sessionMaxAgeSeconds,
  pageHref,
}: {
  data: ShipmentSummary;
  offered: readonly OfferedInventoryCommand[];
  canOperate: boolean;
  consigneeOnly: boolean;
  csrfToken: string;
  binding: Binding;
  sessionMaxAgeSeconds: number;
  pageHref: string;
}) {
  // Said in place of the forms, never as well as them.
  let note: string | null = null;
  if (offered.length === 0) {
    if (consigneeOnly) note = INVENTORY_CONSIGNEE_NOTE;
    else if (!canOperate) note = INVENTORY_READ_ONLY_NOTE;
    else if (data.status === 'DELIVERED') note = INVENTORY_SHIPMENT_FINISHED_NOTE;
    else note = 'در این مرحله اقدامی از سوی شما لازم نیست.';
  }
  return (
    <>
      {note ? <p className="mb-3 text-sm text-content-muted">{note}</p> : null}
      <InventoryCommands
        scope={{ kind: 'SHIPMENT', shipmentId: data.id }}
        offered={offered}
        csrfToken={csrfToken}
        binding={binding}
        sessionMaxAgeSeconds={sessionMaxAgeSeconds}
        pageHref={pageHref}
      />
    </>
  );
}

function Tracking({ result }: { result: ReadResult<ShipmentTracking> }) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="پیگیری این محموله در اختیار شما نیست." />;
  }
  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="پیگیری یافت نشد" description="این محموله دیگر در دسترس نیست." />;
  }
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="پیگیری محموله خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }
  if (result.data.events.length === 0) {
    return <EmptyState title="رویدادی ثبت نشده" description="هنوز رویدادی برای محموله نیست." />;
  }
  return (
    <ol className="flex flex-col gap-2">
      {result.data.events.map((event) => (
        <li
          key={event.id}
          className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border bg-surface-raised p-3 text-sm"
        >
          <StatusBadge status={event.type} label={shipmentStatusLabel(event.type)} />
          <span className="text-content-muted">{formatJalaliDateLong(event.occurredAt)}</span>
        </li>
      ))}
    </ol>
  );
}
