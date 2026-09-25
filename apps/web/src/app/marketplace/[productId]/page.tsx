import { redirect } from 'next/navigation';
import { AppShell, Button, Sidebar, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchOffers, fetchProduct, OFFER_SORTS } from '@/server/marketplace';
import { PORTAL_NAV } from '@/app/nav';
import { OffersScreen } from './OffersScreen';

/**
 * The `/marketplace/[productId]` route — مقایسه پیشنهادها (docs/16 §
 * ۱۶٫۶, role `PROCUREMENT_USER`).
 *
 * The id is whatever was in the URL and is treated as such, matching
 * `/assets/[id]`: encoded into the gateway path rather than interpolated,
 * and never used for a decision here.
 */
export const dynamic = 'force-dynamic';

function sortOf(value: string | string[] | undefined): (typeof OFFER_SORTS)[number] | undefined {
  const raw = typeof value === 'string' ? value.trim() : undefined;
  return raw && (OFFER_SORTS as readonly string[]).includes(raw)
    ? (raw as (typeof OFFER_SORTS)[number])
    : undefined;
}

export default async function ProductOffersPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { productId } = await params;

  const session = await currentSession();
  if (!session) {
    redirect(`/login?returnTo=${encodeURIComponent(`/marketplace/${productId}`)}`);
  }

  const search = await searchParams;
  const sort = sortOf(search.sort);

  const [product, offers] = await Promise.all([
    fetchProduct(session, productId),
    fetchOffers(session, productId, sort),
  ]);

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
      <OffersScreen product={product} offers={offers} productId={productId} sort={sort} />
    </AppShell>
  );
}
