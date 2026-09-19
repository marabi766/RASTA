import { formatJalaliDateLong, formatMoney } from '@/lib/format';
import {
  Alert,
  AppShell,
  EmptyState,
  ErrorState,
  Grid,
  Identifier,
  LoadingState,
  NoAccessState,
  PageHeader,
  Section,
  Sidebar,
  StatusBadge,
  TopBar,
} from '@/ui';

/**
 * The portal's entry route.
 *
 * It is still a placeholder and still says so on screen: the domain screens
 * belong to `EXP-002` through `EXP-004`, and a page that looked finished while
 * nothing behind it worked would be the kind of claim this repository does not
 * make.
 *
 * What it does is put the foundation in front of a browser rather than only in
 * front of a test — the shell, the tokens in both themes, the Persian typeface,
 * the status language of docs/16 § 16.5, and **all three mandatory states side
 * by side**. Those three are the ones that normally exist only in a design
 * file until the first screen needs them in a hurry; here they are built, seen
 * and snapshotted before any screen depends on them.
 */
const NAV = [
  { href: '/', label: 'خانه' },
  { href: '/assets', label: 'ماشین‌آلات' },
  { href: '/orders', label: 'سفارش‌ها' },
];

export default function HomePage() {
  // Fixed sample values, not live data. The API for these screens does not
  // exist yet, and a number that looked live would be a worse placeholder than
  // one that plainly is not.
  const sampleAmount = '10000000';
  const sampleInstant = '2026-09-18T21:30:00Z';

  return (
    <AppShell
      topBar={<TopBar organizationName="دهیاری نمونه" />}
      sidebar={<Sidebar items={NAV} currentHref="/" />}
    >
      <PageHeader
        title="رستا"
        description="پایهٔ پورتال برپا شده است. صفحه‌های دامنه‌ای در داستان‌های بعدی می‌آیند."
      />

      <Alert tone="info" title="این صفحه نمونه است">
        داده‌های زیر ثابت‌اند و از سرویسی نمی‌آیند. هدفشان این است که پایهٔ ظاهری و لایهٔ ارائهٔ
        فارسی در مرورگر دیده شود، نه فرض.
      </Alert>

      <Section headingId="presentation" title="لایهٔ ارائهٔ فارسی">
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
      </Section>

      <Section headingId="statuses" title="زبان بصری وضعیت">
        <div className="flex flex-wrap gap-2">
          <StatusBadge status="ACTIVE" />
          <StatusBadge status="PENDING_APPROVAL" />
          <StatusBadge status="REJECTED" />
          <StatusBadge status="IN_MAINTENANCE" />
          <StatusBadge status="DRAFT" />
        </div>
      </Section>

      <Section headingId="states" title="سه حالت اجباری">
        <Grid columns={2}>
          <LoadingState variant="list" rows={2} />
          <EmptyState
            title="هنوز ماشین‌آلاتی ثبت نشده"
            description="اولین دارایی را ثبت کنید تا اینجا دیده شود."
          />
          <ErrorState correlationId="req-sample-correlation" code="UPSTREAM_TIMEOUT" />
          <NoAccessState />
        </Grid>
      </Section>
    </AppShell>
  );
}
