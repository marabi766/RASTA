import Link from 'next/link';

import {
  Alert,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { formatJalaliDateLong, formatJalaliDateTime, toPersianDigits } from '@/lib/format';
import {
  RETURN_DONE_MESSAGES,
  returnDispositionLabel,
  returnShipmentStatusLabel,
  returnStatusLabel,
  type ReturnCommand,
} from '@/lib/return-fields';
import type { Binding } from '@/lib/unresolved-order';
import type { ReadResult } from '@/server/assets';
import type { ReturnRequest, ReturnShipment } from '@/server/returns';

import { ReturnCommands, type OfferedReturnCommand } from '../ReturnCommands';

/**
 * One return request (EXP-003, `/returns/[id]`): where it is, what it asks
 * for, what **this viewer** may do with it now, and — when inventory-service
 * shows it to this person — where the goods are.
 *
 * Read-only for every party marketplace-service lets read; a third
 * organization is told exactly what an id that does not exist is told. The
 * forms are the ones `server/returns.ts` says the service would accept. No
 * refund is offered and none is claimed: a return moves no money (Q-76).
 */

export interface ReturnDetailScreenProps {
  readonly result: ReadResult<ReturnRequest>;
  /** Each order line's product name, from the order, when it could be read. */
  readonly productNames: ReadonlyMap<string, string> | null;
  /** inventory-service's account of the goods; null when the request itself was not read. */
  readonly shipments: ReadResult<readonly ReturnShipment[]> | null;
  readonly offered: readonly OfferedReturnCommand[];
  readonly csrfToken: string;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  /** The command a signed flash confirms just happened, if any. */
  readonly notice?: ReturnCommand;
  readonly pageHref: string;
}

interface Step {
  readonly label: string;
  readonly at: string;
}

/** What happened to the request, in the order it happened (its own timestamps). */
function historyOf(request: ReturnRequest): Step[] {
  const steps: Step[] = [{ label: 'درخواست بازگشت ثبت شد', at: request.requestedAt }];
  if (request.authorizedAt) {
    steps.push({ label: 'تأمین‌کننده بازگشت را پذیرفت', at: request.authorizedAt });
  }
  if (request.rejectedAt) {
    steps.push({ label: 'تأمین‌کننده درخواست را رد کرد', at: request.rejectedAt });
  }
  if (request.cancelledAt) {
    steps.push({ label: 'خریدار درخواست را لغو کرد', at: request.cancelledAt });
  }
  return steps;
}

function History({ request }: { request: ReturnRequest }) {
  return (
    <ol aria-label="سابقهٔ درخواست بازگشت" className="flex flex-col gap-2">
      {historyOf(request).map((step) => (
        <li key={step.label} className="border-s-2 border-border ps-3 text-sm">
          <span className="font-medium">{step.label}</span>
          <span className="text-content-muted"> — {formatJalaliDateTime(step.at)}</span>
        </li>
      ))}
    </ol>
  );
}

function nameOf(names: ReadonlyMap<string, string> | null, orderLineId: string, productId: string) {
  return names?.get(orderLineId) ?? productId;
}

function Lines({
  request,
  productNames,
}: {
  request: ReturnRequest;
  productNames: ReadonlyMap<string, string> | null;
}) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">ردیف‌های درخواست بازگشت</caption>
      <thead>
        <tr className="text-content-muted">
          <th scope="col" className="py-2 text-start font-normal">
            کالا یا خدمت
          </th>
          <th scope="col" className="py-2 text-start font-normal">
            تعداد بازگشتی
          </th>
        </tr>
      </thead>
      <tbody>
        {request.lines.map((line) => (
          <tr key={line.orderLineId} className="border-t border-border">
            <td className="py-2">{nameOf(productNames, line.orderLineId, line.productId)}</td>
            <td className="py-2">{toPersianDigits(String(line.quantity))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Shipment({
  shipment,
  productNames,
}: {
  shipment: ReturnShipment;
  productNames: ReadonlyMap<string, string> | null;
}) {
  const steps: Step[] = [{ label: 'کالا در راه بازگشت ثبت شد', at: shipment.createdAt }];
  if (shipment.receivedAt) steps.push({ label: 'کالا دریافت شد', at: shipment.receivedAt });
  if (shipment.inspectedAt) steps.push({ label: 'کالا بازرسی شد', at: shipment.inspectedAt });
  if (shipment.resolvedAt) {
    steps.push({ label: 'تکلیف کالای دریافت‌شده تعیین شد', at: shipment.resolvedAt });
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          محمولهٔ بازگشت <Identifier>{shipment.id}</Identifier>
        </p>
        <StatusBadge status={shipment.status} label={returnShipmentStatusLabel(shipment.status)} />
      </div>
      <ol aria-label="مراحل محمولهٔ بازگشت" className="flex flex-col gap-2">
        {steps.map((step) => (
          <li key={step.label} className="border-s-2 border-border ps-3 text-sm">
            <span className="font-medium">{step.label}</span>
            <span className="text-content-muted"> — {formatJalaliDateTime(step.at)}</span>
          </li>
        ))}
      </ol>
      {shipment.carrierName ? (
        <p className="text-sm">
          حمل‌کننده: {shipment.carrierName}
          {shipment.carrierReference ? (
            <>
              {' '}
              · کد رهگیری: <Identifier>{shipment.carrierReference}</Identifier>
            </>
          ) : null}
        </p>
      ) : null}
      <table className="w-full text-sm">
        <caption className="sr-only">ردیف‌های محمولهٔ بازگشت</caption>
        <thead>
          <tr className="text-content-muted">
            <th scope="col" className="py-2 text-start font-normal">
              کالا یا خدمت
            </th>
            <th scope="col" className="py-2 text-start font-normal">
              فرستاده‌شده
            </th>
            <th scope="col" className="py-2 text-start font-normal">
              دریافت‌شده
            </th>
          </tr>
        </thead>
        <tbody>
          {shipment.lines.map((line) => (
            <tr key={line.orderLineId} className="border-t border-border">
              <td className="py-2">{nameOf(productNames, line.orderLineId, line.productId)}</td>
              <td className="py-2">{toPersianDigits(String(line.expectedQuantity))}</td>
              <td className="py-2">
                {line.receivedQuantity === null
                  ? 'هنوز دریافت نشده'
                  : toPersianDigits(String(line.receivedQuantity))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shipment.inspectionNote ? (
        <p className="text-sm">یادداشت بازرسی: {shipment.inspectionNote}</p>
      ) : null}
      {shipment.dispositions.length > 0 ? (
        <div className="text-sm">
          <p className="font-medium">تعیین تکلیف:</p>
          <ul className="mt-1 flex flex-col gap-1">
            {shipment.dispositions.map((disposition) => (
              <li key={`${disposition.orderLineId}-${disposition.disposition}`}>
                {nameOf(productNames, disposition.orderLineId, disposition.orderLineId)}:{' '}
                {toPersianDigits(String(disposition.quantity))} واحد —{' '}
                {returnDispositionLabel(disposition.disposition)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-content-muted">
            تعیین تکلیف فقط ثبت سرنوشت کالاست؛ نه کالایی به موجودی افزوده می‌شود و نه بازپرداختی
            انجام می‌شود.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Goods({
  shipments,
  productNames,
}: {
  shipments: ReadResult<readonly ReturnShipment[]>;
  productNames: ReadonlyMap<string, string> | null;
}) {
  if (shipments.kind === 'FORBIDDEN' || shipments.kind === 'NOT_FOUND') {
    // inventory-service opens a return shipment only to configured roles of
    // its two organizations; this is about the goods' side, not the request.
    return (
      <p className="text-sm text-content-muted">
        وضعیت جابه‌جایی کالا به نقش شما نشان داده نمی‌شود.
      </p>
    );
  }
  if (shipments.kind === 'UNAVAILABLE' || shipments.kind === 'MALFORMED') {
    return (
      <Alert tone="warning">
        وضعیت جابه‌جایی کالا اکنون خوانده نشد؛ کمی بعد دوباره ببینید. کد پیگیری:{' '}
        {shipments.correlationId}
      </Alert>
    );
  }
  if (shipments.data.length === 0) {
    return (
      <p className="text-sm text-content-muted">هنوز محموله‌ای برای این بازگشت ثبت نشده است.</p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {shipments.data.map((shipment) => (
        <Shipment key={shipment.id} shipment={shipment} productNames={productNames} />
      ))}
    </div>
  );
}

export function ReturnDetailScreen({
  result,
  productNames,
  shipments,
  offered,
  csrfToken,
  binding,
  sessionMaxAgeSeconds,
  notice,
  pageHref,
}: ReturnDetailScreenProps) {
  if (result.kind === 'NOT_FOUND') {
    // One sentence for "does not exist" and "not yours": marketplace-service
    // answers 404 for both, and this screen must not tell them apart.
    return (
      <EmptyState
        title="این درخواست بازگشت پیدا نشد"
        description="یا این درخواست وجود ندارد، یا سازمان شما طرف آن نیست."
      />
    );
  }
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="درخواست‌های بازگشت در اختیار نقش شما نیست." />;
  }
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="این درخواست بازگشت خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const request = result.data;
  return (
    <div className="flex flex-col gap-4">
      {notice ? <Alert tone="success">{RETURN_DONE_MESSAGES[notice]}</Alert> : null}

      <Section headingId="return-summary" title="وضعیت درخواست بازگشت">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm">
            درخواست <Identifier>{request.id}</Identifier> · ثبت در{' '}
            {formatJalaliDateLong(request.requestedAt)}
          </p>
          <StatusBadge status={request.status} label={returnStatusLabel(request.status)} />
        </div>
        <p className="mt-2 text-sm">
          سفارش:{' '}
          <Link href={`/orders/${encodeURIComponent(request.orderId)}`} className="underline">
            <Identifier>{request.orderId}</Identifier>
          </Link>
        </p>
        <p className="mt-2 text-sm text-content-muted">
          درخواست بازگشت بازپرداخت نیست: هیچ وضعیتی از آن وجهی جابه‌جا نمی‌کند و بازپرداخت از این
          صفحه ممکن نیست.
        </p>
        <div className="mt-4">
          <History request={request} />
        </div>
      </Section>

      <Section headingId="return-next" title="اقدام بعدی شما">
        <ReturnCommands
          scope={{ kind: 'RETURN', returnId: request.id }}
          offered={offered}
          csrfToken={csrfToken}
          binding={binding}
          sessionMaxAgeSeconds={sessionMaxAgeSeconds}
          pageHref={pageHref}
          emptyNote="در این مرحله اقدامی از سوی شما لازم نیست."
        />
      </Section>

      <Section headingId="return-reason" title="دلیل بازگشت">
        <p className="whitespace-pre-line text-sm">{request.reason}</p>
      </Section>

      <Section headingId="return-lines" title="کالای درخواستی برای بازگشت">
        <Lines request={request} productNames={productNames} />
      </Section>

      <Section headingId="return-goods" title="جابه‌جایی و بازرسی کالا">
        {shipments ? <Goods shipments={shipments} productNames={productNames} /> : null}
      </Section>
    </div>
  );
}
