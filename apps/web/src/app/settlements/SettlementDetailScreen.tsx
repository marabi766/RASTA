import { Alert, EmptyState, ErrorState, Identifier, NoAccessState, Section } from '@/ui';
import { formatJalaliDateLong } from '@/lib/format';
import { SETTLEMENT_SIMULATION_NOTICE } from '@/lib/settlement-fields';
import { formatOrderAmount } from '@/app/orders/OrdersScreen';
import type { ReadResult, Settlement } from '@/server/settlements';

/**
 * One settlement (`/settlements/[id]`).
 *
 * A settlement the caller was not party to arrives as `NOT_FOUND`, the same
 * answer as one that does not exist (economic-service: "404, never 403"), and
 * is rendered identically — the screen has no way to tell the two apart and
 * does not try.
 */

export interface SettlementDetailScreenProps {
  readonly result: ReadResult<Settlement>;
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-border py-2">
      <dt className="text-content-muted">{term}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

export function SettlementDetailScreen({ result }: SettlementDetailScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="این تسویه در اختیار شما نیست." />;
  }
  if (result.kind === 'NOT_FOUND') {
    return (
      <EmptyState title="تسویه‌ای یافت نشد" description="چنین تسویه‌ای برای شما وجود ندارد." />
    );
  }
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="این تسویه خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const s = result.data;
  const money = (minor: string) => formatOrderAmount(minor, s.currency);

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" title="حالت نمایشی">
        {SETTLEMENT_SIMULATION_NOTICE}
      </Alert>
      <Section headingId="settlement" title="مبلغ‌ها">
        <dl className="text-sm">
          <Row term="مبلغ کل">{money(s.grossAmountMinor)}</Row>
          <Row term="کارمزد">{money(s.commissionAmountMinor)}</Row>
          <Row term="مبلغ خالص">{money(s.netAmountMinor)}</Row>
        </dl>
      </Section>
      <Section headingId="parties" title="طرف‌ها و شناسه‌ها">
        <dl className="text-sm">
          <Row term="پرداخت‌کننده">
            <Identifier>{s.payerOrganizationId}</Identifier>
          </Row>
          <Row term="دریافت‌کننده">
            <Identifier>{s.payeeOrganizationId}</Identifier>
          </Row>
          <Row term="تراکنش">
            <Identifier>{s.transactionId}</Identifier>
          </Row>
          <Row term="سند دفتر کل">
            <Identifier>{s.journalId}</Identifier>
          </Row>
          <Row term="زمان تسویه">{formatJalaliDateLong(s.settledAt)}</Row>
        </dl>
      </Section>
    </div>
  );
}
