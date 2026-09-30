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
    await page.goto('/maintenance/MRQ_1?created=1');

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
 * ORG-DEH-0001's loader. It is ACTIVE, and the seed gives it one open
 * `PREVENTIVE` request, so a `CORRECTIVE` one is a different kind of work the
 * service's duplicate rule does not touch.
 */
const MACHINE = 'AST-SEED-0001';
const BREAKDOWN_TITLE = 'نشتی روغن هیدرولیک در آزمون مرورگر';

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

/**
 * This machine's open corrective requests, asked of the owning service. The
 * test does not trust the state it finds: a first attempt that failed after the
 * service had committed would otherwise make Playwright's retry meet the
 * duplicate rule and fail for a reason that has nothing to do with the code.
 */
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

async function cancelAll(request: APIRequestContext, accessToken: string): Promise<void> {
  for (const open of await openCorrective(request, accessToken)) {
    const cancelled = await request.post(
      maintenanceUrl(`/v1/maintenance-requests/${open.id}/cancel`),
      {
        headers: { authorization: `Bearer ${accessToken}` },
        data: { reason: 'پاک‌سازی آزمون مرورگر' },
      },
    );
    expect(cancelled.status()).toBe(200);
  }
}

test.describe('reporting maintenance through the live stack', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true',
    'requires the CI live stack (or the equivalent local environment)',
  );

  // One machine, and a duplicate rule about it: two tests in parallel would
  // cancel each other's request under each other's feet. Serial keeps them in
  // one worker, in order.
  test.describe.configure({ mode: 'serial' });

  let accessToken = '';

  test.beforeEach(async ({ context, request }) => {
    const session = await installLiveSession(context, 'orgAdmin');
    accessToken = session.accessToken;
    await cancelAll(request, accessToken);
  });

  test.afterEach(async ({ request }) => {
    // Leaves the seeded database as found, so a re-run (or a retry) starts from
    // the same place.
    if (accessToken) await cancelAll(request, accessToken);
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

    await expect(page).toHaveURL(/\/maintenance\/MNT[-_][^?]+\?created=1/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(BREAKDOWN_TITLE);
    const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');

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
    await again.locator('input[name="title"]').fill('گزارش دوم برای همان خرابی');
    await again.getByRole('button', { name: 'ثبت درخواست' }).click();

    await expect(page.getByText(/همین حالا یک درخواست باز از همین نوع دارد/)).toBeVisible();
    await expect(page).not.toHaveURL(/created=1/);
    expect(await openCorrective(request, accessToken)).toHaveLength(1);
  });

  test('a breakdown without a severity is refused at the form and reaches no service', async ({
    page,
    request,
  }) => {
    await page.goto(`/maintenance?assetId=${MACHINE}#report-request`);
    const form = page.locator('form').filter({
      has: page.getByRole('button', { name: 'ثبت درخواست' }),
    });
    await form.locator('input[name="title"]').fill('خرابی بدون شدت');
    await form.getByRole('button', { name: 'ثبت درخواست' }).click();

    await expect(page.getByText('برای خرابی، شدت را مشخص کنید')).toBeVisible();
    await expect(page).not.toHaveURL(/created=1/);
    expect(await openCorrective(request, accessToken)).toHaveLength(0);
  });
});
