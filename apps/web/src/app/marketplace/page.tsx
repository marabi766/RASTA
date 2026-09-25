import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { OFFER_SORTS, searchProducts, type ProductSearchQuery } from '@/server/marketplace';
import { PORTAL_NAV } from '@/app/nav';
import { MarketplaceScreen } from './MarketplaceScreen';

/**
 * The `/marketplace` route — جست‌وجوی کالا و خدمت (docs/16 § ۱۶٫۶, role
 * `PROCUREMENT_USER`).
 *
 * Read-only, matching `docs/16`'s page map: search and compare, never list-
 * your-own-offers or publish — those are `SUPPLIER` actions with no screen
 * here. **No role check here** either, for the same reason every other read
 * screen in this portal has none: hiding a control is not a security control
 * (`docs/16 § ۱۶٫۱۱`).
 */
export const dynamic = 'force-dynamic';

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sortOf(value: string | string[] | undefined): (typeof OFFER_SORTS)[number] | undefined {
  const raw = one(value);
  return raw && (OFFER_SORTS as readonly string[]).includes(raw)
    ? (raw as (typeof OFFER_SORTS)[number])
    : undefined;
}

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await currentSession();
  if (!session) redirect('/login?returnTo=/marketplace');

  const params = await searchParams;
  const query: ProductSearchQuery = {
    q: one(params.q),
    category: one(params.category),
    sort: sortOf(params.sort),
  };

  const result = await searchProducts(session, query);

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
      sidebar={<Sidebar items={PORTAL_NAV} currentHref="/marketplace" />}
    >
      <MarketplaceScreen result={result} query={query} />
    </AppShell>
  );
}
