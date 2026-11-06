import type { ReactNode } from 'react';

import {
  Alert,
  EmptyState,
  ErrorState,
  Identifier,
  IsolatedText,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { DEMAND_NOTICE_TEXT, type DemandNotice } from '@/lib/demand-commands';
import { formatJalaliDateTime, toPersianDigits } from '@/lib/format';
import { aggregationStatusLabel, demandStatusLabel, shortfallPolicyLabel } from '@/lib/labels';
import type { AggregationRecord, DemandRecord, ReadResult } from '@/server/demands';

/**
 * One demand (`/procurement/demands/[id]`): its status and what it carries, and
 * the aggregation window it joined, read-only.
 *
 * Another organization's demand answers 404 from the service — and the read
 * module answers it so too for any record that does not name this session's
 * organization — and is shown in the same words as an id that does not exist.
 */

export interface DemandDetailScreenProps {
  readonly result: ReadResult<DemandRecord>;
  /** The aggregation `result` names; null when the demand itself was not read. */
  readonly aggregation: ReadResult<AggregationRecord> | null;
  /** From a flash the server signed for this session and this demand only. */
  readonly notice?: DemandNotice;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-content-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const count = (value: number): string => toPersianDigits(String(value));

export function DemandDetailScreen({ result, aggregation, notice }: DemandDetailScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="نیازهای این سازمان برای نقش شما در دسترس نیست." />;
  }
  if (result.kind === 'NOT_FOUND') {
    return (
      <EmptyState
        title="این نیاز پیدا نشد"
        description="شناسه اشتباه است یا نیاز در سازمان فعال شما نیست."
      />
    );
  }
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="نیاز خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const demand = result.data;
  return (
    <div className="flex flex-col gap-4">
      {notice ? <Alert tone="success">{DEMAND_NOTICE_TEXT[notice]}</Alert> : null}
      <Section headingId="demand" title="نیاز">
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label="وضعیت">
            <StatusBadge status={demand.status} label={demandStatusLabel(demand.status)} />
          </Fact>
          <Fact label="شناسه">
            <Identifier>{demand.id}</Identifier>
          </Fact>
          <Fact label="کالا">
            <Identifier>{demand.productId}</Identifier>
          </Fact>
          <Fact label="مقدار">{count(demand.quantity)}</Fact>
          <Fact label="ثبت در">{formatJalaliDateTime(demand.submittedAt)}</Fact>
          <Fact label="نسخه">{count(demand.version)}</Fact>
          <Fact label="یادداشت">
            {demand.note === null ? 'ندارد' : <IsolatedText>{demand.note}</IsolatedText>}
          </Fact>
          {demand.withdrawnAt === null ? null : (
            <Fact label="پس گرفته در">{formatJalaliDateTime(demand.withdrawnAt)}</Fact>
          )}
          {demand.withdrawReason === null ? null : (
            <Fact label="دلیل پس گرفتن">
              <IsolatedText>{demand.withdrawReason}</IsolatedText>
            </Fact>
          )}
        </dl>
      </Section>
      <AggregationSection result={aggregation} />
    </div>
  );
}

function AggregationSection({ result }: { result: ReadResult<AggregationRecord> | null }) {
  if (result === null) return null;
  if (result.kind !== 'OK') {
    return (
      <Section headingId="aggregation" title="پنجره تجمیع">
        {result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED' ? (
          <ErrorState
            description="پنجره تجمیع این نیاز خوانده نشد. کمی بعد دوباره تلاش کنید."
            correlationId={result.correlationId}
          />
        ) : (
          <EmptyState
            title="پنجره تجمیع نمایش داده نمی‌شود"
            description="پنجره تجمیع این نیاز برای نقش شما در این سازمان خواندنی نیست."
          />
        )}
      </Section>
    );
  }

  const window = result.data;
  return (
    <Section
      headingId="aggregation"
      title="پنجره تجمیع"
      description="نیازهای هم‌کالای سازمان در این پنجره جمع می‌شوند؛ پایان پنجره کار سامانه است، نه این صفحه."
    >
      <dl className="grid gap-4 sm:grid-cols-2">
        <Fact label="وضعیت">
          <StatusBadge status={window.status} label={aggregationStatusLabel(window.status)} />
        </Fact>
        <Fact label="شناسه">
          <Identifier>{window.id}</Identifier>
        </Fact>
        <Fact label="باز شده در">{formatJalaliDateTime(window.openedAt)}</Fact>
        <Fact label="پایان پنجره (نیاز از این لحظه به بعد نمی‌پیوندد)">
          {formatJalaliDateTime(window.closesAt)}
        </Fact>
        <Fact label="جمع مقدار نیازهای زنده">{count(window.totalQuantity)}</Fact>
        <Fact label="شمار نیازهای زنده">{count(window.demandCount)}</Fact>
        <Fact label="آستانه">{count(window.setting.minQuantity)}</Fact>
        <Fact label="اگر به آستانه نرسد">
          {shortfallPolicyLabel(window.setting.shortfallPolicy)}
        </Fact>
        <Fact label="طول پنجره (ساعت)">{count(window.setting.windowHours)}</Fact>
        <Fact label="شمار تمدیدها">{count(window.extensionCount)}</Fact>
        {window.closedAt === null ? null : (
          <Fact label="پایان یافته در">{formatJalaliDateTime(window.closedAt)}</Fact>
        )}
        {window.cancelledAt === null ? null : (
          <Fact label="لغو شده در">{formatJalaliDateTime(window.cancelledAt)}</Fact>
        )}
        {window.cancelReason === null ? null : (
          <Fact label="دلیل لغو">
            <IsolatedText>{window.cancelReason}</IsolatedText>
          </Fact>
        )}
        {window.rfqId === null ? null : (
          <Fact label="استعلام">
            <Identifier>{window.rfqId}</Identifier>
          </Fact>
        )}
      </dl>
    </Section>
  );
}
