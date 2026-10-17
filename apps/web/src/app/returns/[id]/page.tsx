import { redirect } from 'next/navigation';

import { AppShell, Button, ButtonLink, PageHeader, TopBar } from '@/ui';
import { FLASH_PARAM } from '@/lib/form-fields';
import { RETURN_COMMANDS } from '@/lib/return-fields';
import { currentSession } from '@/server/current-session';
import { webServerEnv } from '@/server/env';
import { readFlash } from '@/server/flash';
import { fetchOrder } from '@/server/orders';
import { mintReturnSubmission } from '@/server/return-replay';
import {
  assessShipments,
  cancelNotInPortal,
  fetchReturn,
  fetchReturnShipments,
  returnCallerOf,
  returnCommandsFor,
} from '@/server/returns';
import { submissionBinding } from '@/server/submission';
import { PortalSidebar } from '@/app/PortalSidebar';

import type { OfferedReturnCommand } from '../ReturnCommands';
import { ReturnDetailScreen } from './ReturnDetailScreen';

/**
 * The `/returns/[id]` route — one return request (EXP-003, RUN-005).
 *
 * **No role check on the read.** marketplace-service lets the order's two
 * parties read it, and answers `404` to everyone else, exactly as for an id
 * that does not exist; the screen says the same for both. The order is read
 * after, only for its product names (the request carries line ids), and the
 * goods' side from inventory-service, which opens it to configured roles of
 * the shipment's two organizations — a refusal there hides nothing about the
 * request.
 *
 * Which forms are drawn is `returnCommandsFor`: a copy of the service's own
 * checks, from the roles **the access token** carries — and the withdrawal only
 * of a request not yet authorized (`PORTAL_CANCEL_FROM`); the buyer of an
 * authorized one is told, in fixed words, that the portal does not withdraw it.
 * Each form's stamp binds the request and the command
 * (`server/return-replay.ts`). UX only; the service decides again.
 */
export const dynamic = 'force-dynamic';

export default async function ReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const href = `/returns/${encodeURIComponent(id)}`;
  const session = await currentSession();
  if (!session) redirect(`/login?returnTo=${encodeURIComponent(href)}`);

  const flash = (await searchParams)[FLASH_PARAM];
  const notice = readFlash(
    session,
    typeof flash === 'string' ? flash : undefined,
    id,
    RETURN_COMMANDS,
  );

  const result = await fetchReturn(session, id);
  const [order, listed] =
    result.kind === 'OK'
      ? await Promise.all([
          fetchOrder(session, result.data.orderId),
          fetchReturnShipments(session, id),
        ])
      : [null, null];
  // What inventory lists is a claim; only shipments borne out by this request
  // are its goods (`isShipmentOfRequest`, PR 336 review 1, finding 1).
  const shipments = result.kind === 'OK' && listed ? assessShipments(result.data, listed) : null;
  const caller = returnCallerOf(session.accessToken);

  const productNames =
    order?.kind === 'OK'
      ? new Map(
          order.data.lines.flatMap((line) =>
            line.id === null ? [] : [[line.id, line.productName] as const],
          ),
        )
      : null;

  const offered: OfferedReturnCommand[] =
    result.kind === 'OK'
      ? returnCommandsFor(caller, result.data).map((command) => ({
          command,
          submission: mintReturnSubmission(session, { command, returnId: id }),
        }))
      : [];

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
      sidebar={<PortalSidebar session={session} currentHref="/returns" />}
    >
      <PageHeader
        title="جزئیات درخواست بازگشت"
        description="این درخواست کجاست، چه کالایی را بازمی‌گرداند و در این مرحله چه اقدامی از سوی شما لازم است."
      />
      <div className="mt-2">
        <ButtonLink href="/returns" tone="quiet">
          بازگشت به فهرست درخواست‌های بازگشت
        </ButtonLink>
      </div>
      <div className="mt-4">
        <ReturnDetailScreen
          result={result}
          productNames={productNames}
          shipments={shipments}
          cancelNotInPortal={result.kind === 'OK' && cancelNotInPortal(caller, result.data)}
          offered={offered}
          csrfToken={session.csrfToken}
          binding={submissionBinding(session)}
          sessionMaxAgeSeconds={webServerEnv().WEB_SESSION_MAX_AGE_SECONDS}
          notice={notice}
          pageHref={href}
        />
      </div>
    </AppShell>
  );
}
