import { redirect } from 'next/navigation';

import { Alert, AppShell, Button, Identifier, PageHeader, Section, Sidebar, TopBar } from '@/ui';
import { PORTAL_NAV } from '@/app/nav';
import { currentSession } from '@/server/current-session';
import { newSubmissionId } from '@/server/submission';

import { UsageForm } from './UsageForm';

/**
 * The `/usage` route — recording machine usage (docs/16 § ۱۶٫۶).
 *
 * The page mints the submission id and hands the form the session's CSRF
 * token; both are server-side facts, and the form is a client component only
 * because it renders the result of its own action.
 *
 * **No role check here.** docs/16 § ۱۶٫۶ maps this page to OPERATOR and
 * DRIVER, and § ۱۶٫۱۱ says in the same breath that hiding a control is not a
 * security control. fleet-service decides who may record against which
 * machine — an operator is narrowed to the machine they are actually holding
 * — and a refusal is rendered as an outcome. Guarding the route here would
 * add a second, weaker copy of that rule and change nothing about what the
 * service allows.
 */
export const dynamic = 'force-dynamic';

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/usage');

  const params = await searchParams;
  const created = typeof params.created === 'string' ? params.created : null;

  return (
    <AppShell
      topBar={
        <TopBar organizationName={session.organizationId ?? 'بدون سازمان فعال'}>
          <form method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value={session.csrfToken} />
            <Button type="submit" tone="secondary">
              خروج
            </Button>
          </form>
        </TopBar>
      }
      sidebar={<Sidebar items={PORTAL_NAV} currentHref="/usage" />}
    >
      <PageHeader
        title="ثبت کارکرد"
        description="ساعت کارکرد یا کیلومتر پیموده‌شدهٔ یک ماشین را برای یک بازهٔ زمانی ثبت کنید."
      />

      {created ? (
        // After the redirect that follows a successful write, so a refresh
        // shows this rather than resubmitting the form.
        <Alert tone="success" className="mt-4">
          کارکرد ثبت شد. شمارهٔ رکورد: <Identifier>{created}</Identifier>
        </Alert>
      ) : null}

      <Section headingId="usage-form" title="بازهٔ کارکرد" className="mt-4">
        <UsageForm csrfToken={session.csrfToken} submissionId={newSubmissionId()} />
      </Section>
    </AppShell>
  );
}
