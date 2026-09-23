import { expect, test } from '@playwright/test';

import { SUBMISSION_FIELD } from '../src/lib/form-fields';
import { installLiveSession } from './live-session';

/**
 * `/usage` in a real browser.
 *
 * ## Two layers in one job
 *
 * The visitor checks remain fast and need only the portal. CI additionally
 * enables the live-stack scenario below after starting real PostgreSQL,
 * Redis, Kafka, Keycloak, identity-service, fleet-service and api-gateway.
 * That scenario does not stub an upstream: it proves that the sealed session,
 * CSRF field, per-render submission id, gateway hop and fleet write agree.
 *
 *   1. the route is closed to a visitor with no session — server-side, not by
 *      a hidden link;
 *   2. nothing is put in browser storage on the way (ADR-059's central claim,
 *      extended from `/login` to this route);
 *   3. the redirect carries the person back to where they were going.
 */

test.describe('the usage route', () => {
  test('sends a visitor with no session to the login page', async ({ page }) => {
    await page.goto('/usage');

    // Server-side: the page redirects before rendering anything, so there is
    // no moment where a form for a machine appears to somebody signed out.
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fusage|\/login\?returnTo=\/usage/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ورود به رستا');
  });

  test('works with javascript disabled, all the way to the login page', async ({ browser }) => {
    // The whole write path is built to survive a blocked bundle: a plain form
    // post to a server action. The guard in front of it has to survive it too.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    await page.goto('/usage');
    await expect(page.getByRole('link', { name: /ورود با حساب سازمانی/ })).toBeVisible();

    await context.close();
  });

  test('puts nothing in browser storage on this route either', async ({ page }) => {
    await page.goto('/usage');

    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));

    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
  });
});

test.describe('a usage write through the live stack', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true',
    'requires the CI live stack (or the equivalent local environment)',
  );

  test('creates one tenant-scoped record when the same rendered form is submitted repeatedly', async ({
    browser,
    request,
  }) => {
    test.setTimeout(60_000);

    const context = await browser.newContext({ locale: 'fa-IR', timezoneId: 'Asia/Tehran' });
    const session = await installLiveSession(context);
    const page = await context.newPage();

    await page.goto('/usage');
    await expect(page).toHaveURL('/usage');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('ثبت کارکرد');

    const [periodStart, periodEnd] = await page.evaluate(() => {
      const HOUR_IN_MS = 60 * 60 * 1000;
      const localInputValue = (instant: Date): string => {
        const pad = (value: number): string => String(value).padStart(2, '0');
        return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(
          instant.getDate(),
        )}T${pad(instant.getHours())}:${pad(instant.getMinutes())}`;
      };
      return [
        localInputValue(new Date(Date.now() - 2 * HOUR_IN_MS)),
        localInputValue(new Date(Date.now() - HOUR_IN_MS)),
      ] as const;
    });

    await page.locator('input[name="assetId"]').fill('AST-SEED-0001');
    await page.locator('input[name="periodStart"]').fill(periodStart);
    await page.locator('input[name="periodEnd"]').fill(periodEnd);
    await page.locator('input[name="hours"]').fill('1.50');
    await page.locator('textarea[name="notes"]').fill('ثبت مرورگری پشتهٔ زنده');

    const usageForm = page.locator('form').filter({
      has: page.getByRole('button', { name: 'ثبت کارکرد' }),
    });
    const submissionId = await usageForm
      .locator(`input[name="${SUBMISSION_FIELD}"]`)
      .inputValue();

    // Two simultaneous native-form payloads from one render exercise the
    // service's unique clientReference race. The ordinary click immediately
    // afterwards is a third replay and proves the user-visible redirect too.
    const replayStatuses = await usageForm.evaluate(async (element) => {
      const form = element as HTMLFormElement;
      const submit = async (): Promise<number> => {
        const response = await fetch(form.action, {
          method: 'POST',
          body: new FormData(form),
          credentials: 'same-origin',
          redirect: 'follow',
        });
        await response.arrayBuffer();
        return response.status;
      };
      return Promise.all([submit(), submit()]);
    });
    expect(replayStatuses).toEqual([200, 200]);

    await usageForm.getByRole('button', { name: 'ثبت کارکرد' }).click();
    await expect(page).toHaveURL(/\/usage\?created=USG_/);
    await expect(page.getByText(/کارکرد ثبت شد/)).toBeVisible();
    const createdId = new URL(page.url()).searchParams.get('created');
    expect(createdId).toMatch(/^USG_/);

    // Verification goes straight to fleet-service from the test runner. The
    // portal itself still talks only to the gateway; this black-box read asks
    // the owning service what its tenant-scoped database now contains.
    const fleetUrl = process.env.WEB_E2E_FLEET_URL;
    if (!fleetUrl) throw new Error('The live portal browser test requires WEB_E2E_FLEET_URL');
    const verification = await request.get(
      `${fleetUrl}/v1/usage-records?assetId=AST-SEED-0001&limit=100`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
    );
    expect(verification.status()).toBe(200);

    const body = (await verification.json()) as {
      items: Array<{
        id: string;
        organizationId: string;
        assetId: string;
        driverId: string | null;
        assignmentId: string | null;
        clientReference: string | null;
      }>;
    };
    const matching = body.items.filter((record) => record.clientReference === submissionId);
    expect(matching).toEqual([
      expect.objectContaining({
        id: createdId,
        organizationId: session.organizationId,
        assetId: 'AST-SEED-0001',
        driverId: 'DRV-SEED-0001',
        assignmentId: 'ASG-SEED-0001',
      }),
    ]);

    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));
    expect(stored).toEqual({ local: [], session: [] });

    await context.close();
  });
});
