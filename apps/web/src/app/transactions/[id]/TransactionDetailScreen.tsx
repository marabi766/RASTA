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
} from '@/ui';
import { formatJalaliDateLong } from '@/lib/format';
import { transactionStatusLabel, transactionTypeLabel } from '@/lib/labels';
import { disputedThroughOrder, type DisputeCommand } from '@/lib/transaction-dispute-fields';
import type { DisputeSubmission } from '@/lib/unresolved-dispute';
import type { Binding } from '@/lib/unresolved-order';
import { formatOrderAmount } from '@/app/orders/OrdersScreen';
import type { ReadResult, Transaction } from '@/server/transactions';

import { ConsumedFlash } from '@/app/ConsumedFlash';

import { DisputeCommands } from './DisputeCommands';

/**
 * One transaction and its dispute (`/transactions/[id]`, EXP-003).
 *
 * Shows the dispute state exactly as economic-service returns it — `status`,
 * `disputedAt`, `disputeReason` — and nothing it does not: no deadline, no
 * outcome, no category. A transaction the caller is not party to arrives as
 * `NOT_FOUND`, the same answer as one that does not exist, and is rendered
 * identically.
 *
 * The forms are the commands `disputeCommandsFor` offered this viewer; this
 * screen never decides which. A `MARKETPLACE_ORDER` transaction is disputed
 * only through its order (Q-138): the screen links there instead.
 */

/** No bank behind any of it (CLAUDE.md, ADR-024) — said wherever money is shown. */
export const TRANSACTION_SIMULATION_NOTICE =
  'این تراکنش در حالت نمایشی است: پلتفرم به هیچ بانک یا درگاه واقعی متصل نیست و پولی جابه‌جا نمی‌شود.';

/**
 * What the person's own request did, in the past tense and nothing more. The
 * banner may outlive the moment (a slow reload inside the token's window), so
 * it claims nothing about the transaction **now** — that is the record below,
 * read fresh for this page (PR 319 review 1, finding 3).
 */
const NOTICE_MESSAGES: Readonly<Record<DisputeCommand, string>> = {
  DISPUTE:
    'اعتراض شما ثبت شد. وضعیت کنونی تراکنش همان است که در زیر، از سامانهٔ مالی، خوانده شده است.',
  RESOLVE_DISPUTE:
    'رسیدگی شما ثبت شد. وضعیت کنونی تراکنش همان است که در زیر، از سامانهٔ مالی، خوانده شده است.',
};

export interface TransactionDetailScreenProps {
  readonly result: ReadResult<Transaction>;
  /** The commands to draw a form for — computed by the page, for this viewer. */
  readonly commands: readonly DisputeCommand[];
  readonly csrfToken: string;
  /**
   * One fresh submission id per form — each its own idempotency key — with
   * its signed replay deadline for this transaction (`server/dispute-replay.ts`).
   */
  readonly mintSubmission: (transactionId: string) => DisputeSubmission;
  /** Whose login this page is for (`submissionBinding`): one-way tags. */
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  /** The command this session's own request just completed, from a verified flash token. */
  readonly notice?: DisputeCommand;
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-border py-2">
      <dt className="text-content-muted">{term}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

export function TransactionDetailScreen({
  result,
  commands,
  csrfToken,
  mintSubmission,
  binding,
  sessionMaxAgeSeconds,
  notice,
}: TransactionDetailScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="این تراکنش در اختیار شما نیست." />;
  }
  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="تراکنشی یافت نشد" description="چنین تراکنشی برای شما وجود ندارد." />;
  }
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="این تراکنش خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const t = result.data;
  const money = (minor: string) => formatOrderAmount(minor, t.currency);
  const throughOrder = disputedThroughOrder(t);
  const submissions: Partial<Record<DisputeCommand, DisputeSubmission>> = {};
  for (const command of commands) submissions[command] = mintSubmission(t.id);

  return (
    <div className="flex flex-col gap-4">
      {notice ? (
        <>
          <Alert tone="success">{NOTICE_MESSAGES[notice]}</Alert>
          <ConsumedFlash />
        </>
      ) : null}
      <Alert tone="info" title="حالت نمایشی">
        {TRANSACTION_SIMULATION_NOTICE}
      </Alert>

      <Section headingId="transaction" title="تراکنش">
        <dl className="text-sm">
          <Row term="وضعیت">
            <StatusBadge status={t.status} label={transactionStatusLabel(t.status)} />
          </Row>
          <Row term="نوع">{transactionTypeLabel(t.transactionType)}</Row>
          <Row term="مبلغ کل">{money(t.grossAmountMinor)}</Row>
          <Row term="کارمزد">{money(t.commissionAmountMinor)}</Row>
          <Row term="مبلغ خالص">{money(t.netAmountMinor)}</Row>
          <Row term="زمان رخداد">{formatJalaliDateLong(t.occurredAt)}</Row>
          <Row term="زمان ثبت">{formatJalaliDateLong(t.createdAt)}</Row>
          {t.settledAt ? <Row term="زمان تسویه">{formatJalaliDateLong(t.settledAt)}</Row> : null}
          {t.failureReason !== null ? (
            <Row term="دلیل ثبت‌شده برای لغو، بازگشت وجه یا ناموفقی">
              <IsolatedText>{t.failureReason}</IsolatedText>
            </Row>
          ) : null}
        </dl>
      </Section>

      <Section headingId="parties" title="طرف‌ها و شناسه‌ها">
        <dl className="text-sm">
          <Row term="شناسهٔ تراکنش">
            <Identifier>{t.id}</Identifier>
          </Row>
          <Row term="پرداخت‌کننده">
            <Identifier>{t.organizationId}</Identifier>
          </Row>
          <Row term="دریافت‌کننده">
            {t.counterpartyOrganizationId === null ? (
              'ثبت نشده'
            ) : (
              <Identifier>{t.counterpartyOrganizationId}</Identifier>
            )}
          </Row>
          {t.sourceType !== null || t.sourceReference !== null ? (
            <Row term="مرجع">
              <Identifier>
                {[t.sourceType, t.sourceReference].filter(Boolean).join(' / ')}
              </Identifier>
            </Row>
          ) : null}
          {t.settlement !== null ? (
            <Row term="تسویه">
              <Link
                href={`/settlements/${encodeURIComponent(t.settlement.id)}`}
                className="underline"
              >
                <Identifier>{t.settlement.id}</Identifier>
              </Link>
            </Row>
          ) : null}
        </dl>
      </Section>

      <Section headingId="dispute" title="اعتراض">
        <DisputeState transaction={t} />
        {throughOrder ? (
          <div className="mt-4 flex flex-col gap-2 text-sm">
            <p>
              این تراکنش از یک سفارش بازارگاه است. اعتراض به آن فقط از صفحهٔ همان سفارش ثبت و رسیدگی
              می‌شود؛ آنجا نتیجه و مسئولیت هم ثبت می‌شود.
            </p>
            <p>
              <Link href={throughOrder.href} className="underline">
                {throughOrder.orderId ? 'رفتن به صفحهٔ سفارش' : 'رفتن به فهرست سفارش‌ها'}
              </Link>
              {throughOrder.orderId ? null : (
                <span className="text-content-muted">
                  {' '}
                  (شناسهٔ سفارش در اطلاعات این تراکنش نیامده است؛ سفارش را در فهرست پیدا کنید.)
                </span>
              )}
            </p>
          </div>
        ) : (
          <DisputeCommands
            transactionId={t.id}
            commands={commands}
            csrfToken={csrfToken}
            submissions={submissions}
            binding={binding}
            sessionMaxAgeSeconds={sessionMaxAgeSeconds}
          />
        )}
      </Section>
    </div>
  );
}

/**
 * The dispute, as the record says it is.
 *
 * `disputeReason` holds whatever the last dispute act stored: the reason while
 * the transaction is `DISPUTED`, and — because `resolveDispute` overwrites it —
 * the resolution once it has been resolved. Outside `DISPUTED` the screen
 * cannot tell which it is, and says so instead of guessing.
 */
function DisputeState({ transaction: t }: { transaction: Transaction }) {
  if (t.status === 'DISPUTED') {
    return (
      <div className="flex flex-col gap-3">
        <Alert tone="warning">
          برای این تراکنش اعتراض ثبت شده و تسویهٔ آن متوقف است. هیچ مهلت یا سازوکار خودکاری این توقف
          را برنمی‌دارد؛ فقط رسیدگی صریح یا بازگشت وجه.
        </Alert>
        <dl className="text-sm">
          {t.disputedAt !== null ? (
            <Row term="زمان ثبت اعتراض">{formatJalaliDateLong(t.disputedAt)}</Row>
          ) : null}
          <Row term="دلیل اعتراض">
            {t.disputeReason === null ? 'ثبت نشده' : <IsolatedText>{t.disputeReason}</IsolatedText>}
          </Row>
        </dl>
      </div>
    );
  }

  if (t.disputedAt !== null) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm">
          برای این تراکنش در {formatJalaliDateLong(t.disputedAt)} اعتراض ثبت شده بود و اکنون در
          وضعیت «{transactionStatusLabel(t.status)}» است.
        </p>
        {t.disputeReason !== null ? (
          <dl className="text-sm">
            <Row term="آخرین متن ثبت‌شده برای اعتراض">
              <IsolatedText>{t.disputeReason}</IsolatedText>
            </Row>
          </dl>
        ) : null}
        <p className="text-sm text-content-muted">
          این متن یا دلیل اعتراض است یا، اگر به اعتراض رسیدگی شده باشد، شرح تصمیم؛ سامانه هر دو را
          در یک جا نگه می‌دارد و این صفحه نمی‌تواند بگوید کدام است.
        </p>
      </div>
    );
  }

  return <p className="text-sm">برای این تراکنش اعتراضی ثبت نشده است.</p>;
}
