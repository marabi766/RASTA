'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import {
  verifyAuditChain,
  type AuditChainVerification,
  type AuditVerifyScope,
} from '@/lib/api/adapters/audit';
import { isoToUtcInputValue, utcInputValueToIso } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Button, Card, LoadingState, cx, type Tone } from '../ui/primitives';
import { ApiErrorView } from '../api-error';
import { Code } from '../ui/data-view';

interface VerifyForm {
  readonly from: string;
  readonly to: string;
  readonly scope: AuditVerifyScope;
  readonly organizationId: string;
}

/**
 * The four scenarios this form can reach in fixture mode.
 *
 * These are demo conveniences, not contract fields: a live backend accepts
 * any `(from, to, scope, organizationId)` and answers whichever of the four
 * outcomes actually happened to the real chain. What makes these four
 * reachable *in fixture mode specifically* is that `fixtures.ts` registers
 * an exact-query fixture for each one — see the comment above
 * `VERIFY_WINDOW` there. Typing a different range always reaches the default
 * (`VALID`) fixture, and the panel says so.
 */
const PRESETS: ReadonlyArray<{ key: string; label: string; value: VerifyForm }> = [
  {
    key: 'valid',
    label: 'زنجیرهٔ معتبر',
    value: {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-09-05T12:00:00.000Z',
      scope: 'ORGANIZATION',
      organizationId: 'org_demo_dehyari_alef',
    },
  },
  {
    key: 'divergent',
    label: 'زنجیرهٔ واگرا',
    value: {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-09-05T12:00:00.000Z',
      scope: 'ORGANIZATION',
      organizationId: 'org_demo_dehyari_beh',
    },
  },
  {
    key: 'empty',
    label: 'بازهٔ خالی',
    value: {
      from: '2019-01-01T00:00:00.000Z',
      to: '2019-01-02T00:00:00.000Z',
      scope: 'ORGANIZATION',
      organizationId: 'org_demo_dehyari_alef',
    },
  },
  {
    key: 'legacy',
    label: 'بازهٔ پیش از AUD-003',
    value: {
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-06-01T00:00:00.000Z',
      scope: 'ORGANIZATION',
      organizationId: 'org_demo_dehyari_alef',
    },
  },
];

const STATUS_PRESENTATION: Record<
  AuditChainVerification['status'],
  { label: string; tone: Tone; explanation: string }
> = {
  VALID: {
    label: 'معتبر',
    tone: 'success',
    explanation:
      'هر رکورد این بازه بازمحاسبه شد و هر پیوند میان آن‌ها برقرار بود. این یعنی زنجیره دست‌کاری‌نشده است — نه اینکه غیرقابل دست‌کاری باشد؛ مکانیزم «مشهودسازی دست‌کاری» است، نه امضای دیجیتال و نه اثبات در برابر دسترسی ادمین پایگاه داده.',
  },
  DIVERGENT: {
    label: 'واگرا',
    tone: 'danger',
    explanation:
      'دست‌کم یک رکورد بازمحاسبه نشد یا یک پیوند برقرار نبود. نخستین واگرایی زیر آمده است.',
  },
  EMPTY: {
    label: 'بدون رکورد',
    tone: 'neutral',
    explanation:
      'هیچ رکوردی در این بازه نبود. این نه معتبر است و نه خراب — چیزی برای بررسی وجود نداشت.',
  },
  UNVERIFIABLE_LEGACY: {
    label: 'غیرقابل‌تأیید (پیش از AUD-003)',
    tone: 'warning',
    explanation:
      'این بازه دست‌کم یک رکورد پیش از وجود زنجیرهٔ Hash دارد که هرگز عقب‌نگر تکمیل نمی‌شود، پس این بازه معتبر اعلام نمی‌شود — بخش زنجیره‌دار آن بررسی و گزارش شده، اما کل بازه را نمی‌توان تأیید کرد.',
  },
};

const DIVERGENCE_REASON_LABELS: Record<string, string> = {
  RECORD_HASH_MISMATCH: 'محتوای رکورد با پیوند ذخیره‌شدهٔ آن هم‌خوان نیست',
  PREVIOUS_HASH_MISMATCH: 'رکورد به رکورد پیش از خودش اشاره نمی‌کند',
  MISSING_CHAIN_LINK: 'رکوردی در محدودهٔ زنجیره، پیوند ندارد',
  CHAIN_TAIL_MISSING: 'دنبالهٔ زنجیره حذف شده است',
  CHAIN_HEAD_MISMATCH: 'سرِ زنجیره با رکوردهای موجود هم‌خوان نیست',
  CHAIN_LENGTH_MISMATCH: 'تعداد رکوردهای بررسی‌شده با طول ثبت‌شدهٔ زنجیره یکی نیست',
};

function defaultForm(): VerifyForm {
  return PRESETS[0].value;
}

/**
 * `GET /v1/audit-events/verify` — hash-chain verification.
 *
 * Renders exactly the four outcomes the service can answer and nothing else.
 * `VALID` is worded as tamper-*evident*, never tamper-*proof* — ADR-053's own
 * comment on this endpoint says the mechanism "is not a signature and not
 * protection against a database superuser", and a screen that said more than
 * the service itself claims would be the dishonest half of an honest API.
 */
export function AuditVerifyPanel(): ReactNode {
  const [form, setForm] = useState<VerifyForm>(defaultForm);
  const [submitted, setSubmitted] = useState<VerifyForm>(defaultForm);

  const resource = useApiResource(
    (client, signal) =>
      verifyAuditChain(
        client,
        { from: submitted.from, to: submitted.to },
        {
          scope: submitted.scope,
          organizationId:
            submitted.scope === 'PLATFORM' ? undefined : submitted.organizationId || undefined,
        },
        signal,
      ),
    [submitted],
  );

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(form);
  };

  return (
    <section aria-labelledby="audit-verify-heading" className="mb-8">
      <h2 id="audit-verify-heading" className="mb-1 text-lg font-bold text-[var(--tx)]">
        تأیید زنجیرهٔ Hash
      </h2>
      <p className="mb-3 text-sm text-[var(--tx2)]">
        این بررسی نشان می‌دهد آیا رکوردهای این بازه، از زمان ثبت، دست‌کاری شده‌اند یا نه. سازوکار
        «مشهودساز دست‌کاری» است، نه امضای رمزنگاری‌شده و نه لنگر خارجی تغییرناپذیر.
      </p>

      <Card className="mb-4">
        <div className="mb-3 flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset.key}
              type="button"
              variant="secondary"
              onClick={() => setForm(preset.value)}
            >
              {preset.label}
            </Button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-xs font-semibold text-[var(--tx2)]">
            <span className="mb-1 block">از (UTC) *</span>
            <input
              type="datetime-local"
              required
              value={isoToUtcInputValue(form.from)}
              onChange={(event) =>
                setForm((current) => ({ ...current, from: utcInputValueToIso(event.target.value) }))
              }
              className={INPUT_CLASS}
            />
          </label>
          <label className="block text-xs font-semibold text-[var(--tx2)]">
            <span className="mb-1 block">تا (UTC) *</span>
            <input
              type="datetime-local"
              required
              value={isoToUtcInputValue(form.to)}
              onChange={(event) =>
                setForm((current) => ({ ...current, to: utcInputValueToIso(event.target.value) }))
              }
              className={INPUT_CLASS}
            />
          </label>
          <label className="block text-xs font-semibold text-[var(--tx2)]">
            <span className="mb-1 block">محدوده</span>
            <select
              value={form.scope}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  scope: event.target.value as AuditVerifyScope,
                }))
              }
              className={INPUT_CLASS}
            >
              <option value="ORGANIZATION">یک سازمان</option>
              <option value="PLATFORM">پلتفرم (فقط SYSTEM_ADMIN)</option>
            </select>
          </label>
          <label className="block text-xs font-semibold text-[var(--tx2)]">
            <span className="mb-1 block">شناسهٔ سازمان</span>
            <input
              value={form.organizationId}
              disabled={form.scope === 'PLATFORM'}
              onChange={(event) =>
                setForm((current) => ({ ...current, organizationId: event.target.value }))
              }
              title={form.scope === 'PLATFORM' ? 'با محدودهٔ پلتفرم ترکیب نمی‌شود' : undefined}
              className={INPUT_CLASS}
            />
          </label>

          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit">بررسی زنجیره</Button>
          </div>
        </form>
      </Card>

      {resource.state.status === 'loading' ? (
        <LoadingState rows={1} label="در حال بررسی زنجیرهٔ Hash" />
      ) : null}

      {resource.state.status === 'error' ? (
        <ApiErrorView
          failure={resource.state.failure}
          onRetry={resource.reload}
          context="بررسی زنجیره"
        />
      ) : null}

      {resource.state.status === 'success' ? (
        <VerificationResult result={resource.state.data} />
      ) : null}
    </section>
  );
}

function VerificationResult({ result }: { result: AuditChainVerification }): ReactNode {
  const presentation = STATUS_PRESENTATION[result.status];

  return (
    <Card className={cx(result.status === 'DIVERGENT' ? 'border-[var(--dgr)]' : undefined)}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={presentation.tone}>{presentation.label}</Badge>
        <Code>{result.status}</Code>
        <span className="text-xs text-[var(--tx3)]">
          محدوده: {result.scope === 'PLATFORM' ? 'پلتفرم' : <Code>{result.organizationId}</Code>}
        </span>
      </div>

      <p className="mt-3 text-sm text-[var(--tx2)]">{presentation.explanation}</p>

      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Stat term="در بازه" value={result.recordsInRange} />
        <Stat term="بررسی‌شده" value={result.recordsVerified} />
        <Stat term="بدون زنجیره" value={result.unchainedRecords} />
      </dl>

      {result.firstDivergence ? (
        <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--dgr)] bg-[var(--dgr-soft)] p-3 text-sm">
          <p className="font-bold text-[var(--dgr-tx)]">نخستین واگرایی</p>
          <p className="mt-1 text-[var(--tx)]">
            {DIVERGENCE_REASON_LABELS[result.firstDivergence.reason] ??
              result.firstDivergence.reason}
          </p>
          <p className="mt-2 text-xs text-[var(--tx3)]">
            رکورد <Code>{result.firstDivergence.auditEventId}</Code> — ماه{' '}
            <Code>{result.firstDivergence.month}</Code>
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function Stat({ term, value }: { term: string; value: number }): ReactNode {
  return (
    <div>
      <dt className="text-xs text-[var(--tx3)]">{term}</dt>
      <dd className="mt-0.5 font-bold text-[var(--tx)]">{value}</dd>
    </div>
  );
}

const INPUT_CLASS =
  'min-h-[var(--tap)] w-full rounded-[var(--radius-md)] border border-[var(--control-border)] bg-[var(--surf)] px-3 text-sm text-[var(--tx)]';
