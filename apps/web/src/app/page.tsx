import { formatJalaliDateLong, formatMoney } from '@/lib/format';
import { Identifier } from '@/ui/text/Identifier';

/**
 * The portal's entry route.
 *
 * It is still a placeholder and still says so on screen: the domain screens
 * belong to `EXP-002` through `EXP-004`, and a page that looked finished while
 * nothing behind it worked would be the kind of claim this repository does not
 * make.
 *
 * What it does do now is exercise the foundation in a browser rather than only
 * in a test — the tokens, the right-to-left document, the Persian typeface,
 * and each of the presentation rules of docs/16 § 16.3 and § 16.5: money as a
 * string turned into Persian digits, a UTC instant turned into a Jalali date,
 * and a Latin identifier isolated inside Persian text. If any of those is
 * wrong, it is wrong here, visibly, on the first page anyone opens.
 */
export default function HomePage() {
  // Fixed sample values, not live data. The API for these screens does not
  // exist yet, and a number that looked live would be a worse placeholder than
  // one that plainly is not.
  const sampleAmount = '10000000';
  const sampleInstant = '2026-09-18T21:30:00Z';

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold text-content">رستا</h1>
        <p className="text-base leading-relaxed text-content-muted">
          پایهٔ پورتال برپا شده است. صفحه‌های دامنه‌ای هنوز ساخته نشده‌اند و در داستان‌های بعدی
          می‌آیند.
        </p>
      </header>

      <section
        aria-labelledby="foundation-heading"
        className="flex flex-col gap-4 rounded-lg border border-border bg-surface-raised p-6 shadow-sm"
      >
        <h2 id="foundation-heading" className="text-lg font-semibold text-content">
          لایهٔ ارائهٔ فارسی
        </h2>

        <dl className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <dt className="text-sm text-content-subtle">مبلغ</dt>
            <dd className="text-xl text-content">{formatMoney(sampleAmount)}</dd>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="text-sm text-content-subtle">تاریخ</dt>
            <dd className="text-xl text-content">{formatJalaliDateLong(sampleInstant)}</dd>
          </div>

          <div className="flex flex-col gap-1">
            <dt className="text-sm text-content-subtle">شناسه</dt>
            <dd className="text-xl text-content">
              <Identifier>ORD-2026-0148</Identifier>
            </dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
