import { redirect } from 'next/navigation';
import { AppShell, Button, TopBar } from '@/ui';
import { currentSession } from '@/server/current-session';
import { fetchDemoMode } from '@/server/demo-mode';
import { canPlaceOrder } from '@/server/place-order';
import { webServerEnv } from '@/server/env';
import { mintSubmissionId, submissionBinding } from '@/server/submission';
import { fetchOfferSuppliers } from '@/server/offer-suppliers';
import { fetchOffers, fetchProduct, OFFER_SORTS } from '@/server/marketplace';
import { PortalSidebar } from '@/app/PortalSidebar';
import { OffersScreen } from './OffersScreen';
import {
  actingOrganizationId,
  actingOrganizationLabel,
  actingScope,
  sessionWriteRoles,
} from '@/server/session-organization';
import { pageContext, pageParams } from '@/server/page-context';

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

  const search = await pageParams(session, searchParams);
  const sort = sortOf(search.sort);

  const [product, offers] = await Promise.all([
    fetchProduct(session, productId),
    fetchOffers(session, productId, sort),
  ]);

  // A Route Guard as UX, not as security: offered on the access token's own
  // roles (`sessionWriteRoles`), the set marketplace-service decides on — not
  // `/v1/users/me`, which runs ahead of the token until it is refreshed. A token
  // whose roles cannot be read shows no form, and the service decides again.
  const roles = sessionWriteRoles(session);
  const canOrder = roles !== null && canPlaceOrder(roles);

  const demoMode = await fetchDemoMode(session);

  // Names and qualification for the table (task 305); a failed read leaves them unknown.
  const suppliers = await fetchOfferSuppliers(
    session,
    offers.kind === 'OK' ? offers.data.items.map((offer) => offer.supplierOrganizationId) : [],
  );

  return (
    <AppShell
      key={actingScope(session)}
      topBar={
        <TopBar organizationName={actingOrganizationLabel(session)}>
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
        context={pageContext(session)}
        product={product}
        offers={offers}
        suppliers={suppliers}
        productId={productId}
        sort={sort}
        demoMode={demoMode}
        ordering={
          canOrder
            ? {
                csrfToken: session.csrfToken,
                mintSubmissionId: () => mintSubmissionId(session),
                organizationId: actingOrganizationId(session),
                binding: submissionBinding(session),
                sessionMaxAgeSeconds: webServerEnv().WEB_SESSION_MAX_AGE_SECONDS,
              }
            : undefined
        }
      />
    </AppShell>
  );
}
