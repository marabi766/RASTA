import { redirect } from 'next/navigation';
import { AppShell, Button, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchDemoMode } from '@/server/demo-mode';
import { tokenWriteRoles } from '@/server/realm-roles';
import { canPlaceOrder } from '@/server/place-order';
import { webServerEnv } from '@/server/env';
import { mintSubmissionId, submissionBinding } from '@/server/submission';
import { fetchOffers, fetchProduct, OFFER_SORTS } from '@/server/marketplace';
import { PortalSidebar } from '@/app/PortalSidebar';
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

  // A Route Guard as UX, not as security: offered on the access token's own
  // roles (`tokenWriteRoles`), the set marketplace-service decides on — not
  // `/v1/users/me`, which runs ahead of the token until it is refreshed. A token
  // whose roles cannot be read shows no form, and the service decides again.
  const roles = tokenWriteRoles(session.accessToken);
  const canOrder = roles !== null && canPlaceOrder(roles);

  const demoMode = await fetchDemoMode(session);

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
      sidebar={<PortalSidebar session={session} currentHref="/marketplace" />}
    >
      <OffersScreen
        product={product}
        offers={offers}
        productId={productId}
        sort={sort}
        demoMode={demoMode}
        ordering={
          canOrder
            ? {
                csrfToken: session.csrfToken,
                mintSubmissionId: () => mintSubmissionId(session),
                organizationId: session.organizationId,
                binding: submissionBinding(session),
                sessionMaxAgeSeconds: webServerEnv().WEB_SESSION_MAX_AGE_SECONDS,
              }
            : undefined
        }
      />
    </AppShell>
  );
}
