import { expect, test, type APIRequestContext } from '@playwright/test';

import { installLiveSession } from './live-session';

/**
 * `/maintenance` in a real browser.
 *
 * ## Two layers in one job
 *
 * The visitor checks below need only the portal: that the route is not
 * reachable with no session, and that nothing in the URL can make it show a
 * form, a confirmation, or a machine's identity to a stranger.
 *
 * The live-stack block at the end signs in as an organization administrator
 * through the real Keycloak, reports a breakdown through the form, and asks
 * maintenance-service itself — not the portal — what it now holds. It runs on
 * the desktop project only: the phone project runs the read-only scenarios
 * (`playwright.config.ts`), and a write that creates a record belongs once,
 * not once per viewport.
 */

test.describe('the maintenance route', () => {
  test('sends a visitor with no session to the login page', async ({ page }) => {
    await page.goto('/maintenance');

    // Server-side, before anything renders: there is no moment where the
    // report form appears to somebody signed out.
    await expect(page).toHaveURL(
      /\/login\?returnTo=%2Fmaintenance|\/login\?returnTo=\/maintenance/,
    );
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ورود به رستا');
    await expect(page.getByRole('button', { name: 'ثبت درخواست' })).toHaveCount(0);
  });

  test('does not let a prefilled machine id conjure the form', async ({ page }) => {
    // `?assetId=` prefills the form for somebody who arrived from a dossier.
    // It is attacker-controllable, and it must not become a way to render the
    // form, or echo an id back, for somebody with no session.
    await page.goto('/maintenance?assetId=AST_01J00000000000000000000000#report-request');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel(/شناسهٔ ماشین/)).toHaveCount(0);
    expect(await page.content()).not.toContain('AST_01J00000000000000000000000');
  });

  test('keeps a request detail closed, and its confirmation with it', async ({ page }) => {
    await page.goto('/maintenance/MRQ_1?created=1&flash=forged');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/درخواست ثبت شد/)).toHaveCount(0);
  });

  test('stays closed with javascript disabled', async ({ browser }) => {
    // The form is a plain post to a server action, so it survives a blocked
    // bundle by design. The guard in front of it has to survive it too.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    await page.goto('/maintenance');
    await expect(page.getByRole('link', { name: /ورود با حساب سازمانی/ })).toBeVisible();
    await expect(page.locator('form[action*="maintenance"]')).toHaveCount(0);

    await context.close();
  });

  test('leaks nothing into browser storage on the way', async ({ page }) => {
    await page.goto('/maintenance');

    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));

    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Through the live stack
// ---------------------------------------------------------------------------

/**
 * The browser suite's **own** machine, seeded for it and for nothing else
 * (`AST-SEED-E2E-0001`, ORG-DEH-0001, in the asset and maintenance seeds): no
 * schedule, no request, no usage. It used to report against `AST-SEED-0001`,
 * which other scenarios read, and cleaned up by cancelling *every* open
 * corrective request on it — work this suite never created, and a result that
 * depended on what earlier runs had left.
 */
const MACHINE = 'AST-SEED-E2E-0001';

/** What every request this suite files starts with, so its own can be told from anyone else's. */
const TITLE_PREFIX = 'آزمون مرورگر';
/**
 * This run's own marker, the same in every worker and retry of one Playwright
 * invocation (`playwright.config.ts`) and different in any other run — so two
 * runs against one stack never see each other's requests as their own. The
 * fallback is for a spec started some other way.
 */
const RUN = process.env.WEB_E2E_RUN_ID ?? `${Date.now().toString(36)}${process.pid}`;
/** Where a run's id begins its title: the time it started, in base 36, eight characters. */
const RUN_TIME_CHARS = 8;
/** An open request this old, under the suite's prefix, belongs to a run that is long gone. */
const STALE_AFTER_MS = 30 * 60 * 1000;
const titled = (what: string): string => `${TITLE_PREFIX} ${RUN} - ${what}`;

const BREAKDOWN_TITLE = titled('نشتی روغن هیدرولیک');

function maintenanceUrl(path: string): string {
  const base = process.env.WEB_E2E_MAINTENANCE_URL;
  if (!base) throw new Error('The live portal browser test requires WEB_E2E_MAINTENANCE_URL');
  return `${base}${path}`;
}

interface RequestRecord {
  id: string;
  organizationId: string;
  assetId: string;
  type: string;
  status: string;
  severity: string | null;
  title: string;
}

/** The open corrective requests on this suite's machine, asked of the owning service. */
async function openCorrective(
  request: APIRequestContext,
  accessToken: string,
): Promise<RequestRecord[]> {
  const response = await request.get(
    maintenanceUrl(
      `/v1/maintenance-requests?assetId=${MACHINE}&type=CORRECTIVE&openOnly=true&limit=100`,
    ),
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: RequestRecord[] }).items;
}

/** Ids this test read back after creating them through the form. */
const created = new Set<string>();

async function cancel(request: APIRequestContext, accessToken: string, id: string): Promise<void> {
  const cancelled = await request.post(maintenanceUrl(`/v1/maintenance-requests/${id}/cancel`), {
    headers: { authorization: `Bearer ${accessToken}` },
    data: { reason: 'پاک‌سازی آزمون مرورگر' },
  });
  expect(cancelled.status()).toBe(200);
}

/**
 * Cancels what this suite filed and nothing else: the ids it saw created, and
 * any open request on its own machine whose title carries `marker`. The marker
 * is how a request the form committed but the test never saw (the attempt failed
 * after the service answered) is still found — by what the test wrote into it,
 * not by "everything open".
 */
async function cancelOwn(
  request: APIRequestContext,
  accessToken: string,
  marker: string,
): Promise<void> {
  const open = await openCorrective(request, accessToken);
  const own = open.filter((record) => created.has(record.id) || record.title.startsWith(marker));
  for (const record of own) await cancel(request, accessToken, record.id);
  created.clear();
}

/**
 * Requests filed by a run that started more than `STALE_AFTER_MS` ago and never
 * cleaned up (a killed job, a local run interrupted). Told apart by the start
 * time every title carries, so a run in progress somewhere else is not mistaken
 * for one that is long gone; a title that does not parse is left alone.
 */
async function cancelStale(request: APIRequestContext, accessToken: string): Promise<void> {
  const open = await openCorrective(request, accessToken);
  for (const record of open) {
    if (!record.title.startsWith(`${TITLE_PREFIX} `)) continue;
    const startedAt = parseInt(
      record.title.slice(TITLE_PREFIX.length + 1, TITLE_PREFIX.length + 1 + RUN_TIME_CHARS),
      36,
    );
    if (Number.isFinite(startedAt) && Date.now() - startedAt > STALE_AFTER_MS) {
      await cancel(request, accessToken, record.id);
    }
  }
}

test.describe('reporting maintenance through the live stack', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true',
    'requires the CI live stack (or the equivalent local environment)',
  );

  // One machine, and a duplicate rule about it: two tests in parallel would meet
  // each other's open request. Serial keeps them in one worker, in order.
  test.describe.configure({ mode: 'serial' });

  let accessToken = '';

  test.beforeEach(async ({ context, request }) => {
    const session = await installLiveSession(context, 'orgAdmin');
    accessToken = session.accessToken;
    // What an earlier attempt of *this run* left (a crashed worker, a failed
    // teardown) — and only that — plus what a run long gone left. Another run's
    // live requests are never touched: they carry its id, and a run that started
    // minutes ago is not long gone.
    await cancelOwn(request, accessToken, `${TITLE_PREFIX} ${RUN}`);
    await cancelStale(request, accessToken);
  });

  test.afterEach(async ({ request }) => {
    // Only what this test filed.
    if (accessToken) await cancelOwn(request, accessToken, `${TITLE_PREFIX} ${RUN}`);
  });

  test('a breakdown reported in the form is held by maintenance-service, and a second one is refused by it', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);

    await page.goto(`/maintenance?assetId=${MACHINE}#report-request`);
    const form = page.locator('form').filter({
      has: page.getByRole('button', { name: 'ثبت درخواست' }),
    });
    await expect(form.locator('input[name="assetId"]')).toHaveValue(MACHINE);

    await form.locator('select[name="severity"]').selectOption('HIGH');
    await form.locator('input[name="title"]').fill(BREAKDOWN_TITLE);
    await form.getByRole('button', { name: 'ثبت درخواست' }).click();

    // The confirmation is a signed flash (or, before it, a flag): this test is about
    // the request existing, not about how the page was told to say so.
    await expect(page).toHaveURL(/\/maintenance\/MNT[-_][^?/]+/);
    await expect(page.getByText('درخواست ثبت شد')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(BREAKDOWN_TITLE);
    const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
    created.add(id);

    // Asked of the owning service, with the same token: the portal is not the
    // witness of its own write.
    const read = await request.get(maintenanceUrl(`/v1/maintenance-requests/${id}`), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(read.status()).toBe(200);
    expect((await read.json()) as RequestRecord).toEqual(
      expect.objectContaining({
        id,
        organizationId: 'ORG-DEH-0001',
        assetId: MACHINE,
        type: 'CORRECTIVE',
        status: 'OPEN',
        severity: 'HIGH',
        title: BREAKDOWN_TITLE,
      }),
    );

    // The service's own rule, not the portal's: a second open breakdown on the
    // same machine. The refusal comes back through the gateway and lands in the
    // form in Persian, and nothing new is created.
    await page.goto(`/maintenance?assetId=${MACHINE}#report-request`);
    const again = page.locator('form').filter({
      has: page.getByRole('button', { name: 'ثبت درخواست' }),
    });
    await again.locator('select[name="severity"]').selectOption('LOW');
    await again.locator('input[name="title"]').fill(titled('گزارش دوم برای همان خرابی'));
    await again.getByRole('button', { name: 'ثبت درخواست' }).click();

    await expect(page.getByText(/همین حالا یک درخواست باز از همین نوع دارد/)).toBeVisible();
    await expect(page).not.toHaveURL(/created=1|flash=/);
    expect(await openCorrective(request, accessToken)).toHaveLength(1);
  });

  test('a request this suite filed is cancelled from its page, and maintenance-service holds the cancellation', async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);

    // The request is filed straight at the owning service: this test is about
    // the command on the detail page, and the report form has its own test.
    const title = titled('درخواست برای لغو');
    const filed = await request.post(maintenanceUrl('/v1/maintenance-requests'), {
      headers: { authorization: `Bearer ${accessToken}` },
      data: { assetId: MACHINE, type: 'CORRECTIVE', severity: 'LOW', title },
    });
    expect(filed.status()).toBe(201);
    const { id } = (await filed.json()) as RequestRecord;
    created.add(id);

    await page.goto(`/maintenance/${encodeURIComponent(id)}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);

    // An organization admin is offered the three commands; the one used here is
    // closed until asked for.
    await page.getByText('لغو این درخواست').click();
    const form = page.locator('form').filter({
      has: page.getByRole('button', { name: 'لغو درخواست' }),
    });
    await form.locator('textarea[name="reason"]').fill('لغو در آزمون مرورگر');
    await form.getByRole('button', { name: 'لغو درخواست' }).click();

    // A signed flash on the page the redirect lands on, which reads the request
    // again; the query carries no notice a person could have typed.
    await expect(page).toHaveURL(new RegExp(`/maintenance/${encodeURIComponent(id)}\\?flash=`));
    await expect(page.getByText('درخواست لغو شد.')).toBeVisible();

    // Asked of the owning service, with the same token: the portal is not the
    // witness of its own write.
    const read = await request.get(maintenanceUrl(`/v1/maintenance-requests/${id}`), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(read.status()).toBe(200);
    expect((await read.json()) as RequestRecord).toEqual(
      expect.objectContaining({ id, organizationId: 'ORG-DEH-0001', status: 'CANCELLED' }),
    );
    expect(await openCorrective(request, accessToken)).toHaveLength(0);
  });

  test('a breakdown without a severity is refused at the form and reaches no service', async ({
    page,
    request,
  }) => {
    await page.goto(`/maintenance?assetId=${MACHINE}#report-request`);
    const form = page.locator('form').filter({
      has: page.getByRole('button', { name: 'ثبت درخواست' }),
    });
    await form.locator('input[name="title"]').fill(titled('خرابی بدون شدت'));
    await form.getByRole('button', { name: 'ثبت درخواست' }).click();

    await expect(page.getByText('برای خرابی، شدت را مشخص کنید')).toBeVisible();
    await expect(page).not.toHaveURL(/created=1|flash=/);
    expect(await openCorrective(request, accessToken)).toHaveLength(0);
  });
});
