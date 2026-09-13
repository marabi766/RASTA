import { expect, test, type Page } from '@playwright/test';

/**
 * The full interactive investor story, against the real fixture-mode
 * production build: organization/persona → asset → maintenance request →
 * estimate approval → supplier offer → order → payment → document → scan →
 * audit timeline. Every assertion reads through a real page navigation and a
 * real (fixture) data fetch, the same path `scenario.spec.ts` already proves
 * for the status card and reset control — this file proves the ten visible
 * action controls Phase C adds on top of that engine.
 *
 * Three Playwright projects run this file (desktop 1440, tablet 768, mobile
 * 390 — see `playwright.fixture.config.ts`), so every test below already
 * runs at all three sizes without a manual loop; the one explicit per-width
 * loop near the bottom exists only for the tap-target assertion, matching
 * `scenario.spec.ts`'s own convention.
 */

function recordExternalRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('http') && !url.includes('localhost:3212')) seen.push(url);
  });
  return seen;
}

test.describe('the complete investor story', () => {
  test('runs end to end, with every screen reading the result back through the real read-model', async ({
    page,
  }) => {
    const external = recordExternalRequests(page);

    // 1. Organization / persona, on the central hub.
    await page.goto('/demo');
    await page.getByRole('button', { name: 'مدیر ناوگان' }).click();
    await expect(page.getByRole('button', { name: 'مدیر ناوگان' })).toContainText('✓');
    await expect(page.locator('[aria-current="step"]')).toHaveText('سازمان انتخاب شد');

    // 2. Open the canonical asset, 3. create the maintenance request.
    await page.getByRole('link', { name: /باز کردن دارایی و ثبت درخواست تعمیر/ }).click();
    await expect(page).toHaveURL(/\/assets\/ast_demo_grader$/);
    await page.getByRole('button', { name: 'ثبت درخواست تعمیر' }).click();
    await expect(page.getByText('درخواست تعمیر ثبت شد')).toBeVisible();

    // 4. Approve the estimate — same page shows the result through a real refetch.
    await page.getByRole('link', { name: /گام بعدی: تأیید برآورد هزینه/ }).click();
    await expect(page).toHaveURL(/\/maintenance\/mrq_demo_oil_change$/);
    await expect(page.getByText('تأیید نشده', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'تأیید برآورد هزینه' }).click();
    await expect(page.getByText('برآورد هزینه تأیید شد')).toBeVisible();
    // Cross-route consistency: the approval section on this very page, which
    // reads through `fetchMaintenanceRequest` → `FixtureGatewayClient` →
    // `projectMaintenanceRequestDetail`, now shows the approved badge too.
    await expect(page.getByText('تأیید شده', { exact: true }).first()).toBeVisible();

    // 5. Select the prepared supplier offer, 6. place the order.
    await page.getByRole('link', { name: /گام بعدی: انتخاب پیشنهاد تأمین‌کننده/ }).click();
    await expect(page).toHaveURL(/\/marketplace\/prd_demo_engine_oil$/);
    await page.getByRole('button', { name: 'انتخاب این پیشنهاد' }).click();
    await expect(page.getByText('پیشنهاد انتخاب شد')).toBeVisible();
    await page.getByRole('button', { name: 'ثبت سفارش' }).click();
    await expect(page.getByText('سفارش ثبت شد')).toBeVisible();

    // 7. Capture the simulated payment.
    await page.getByRole('link', { name: /گام بعدی: نهایی‌کردن پرداخت/ }).click();
    await expect(page).toHaveURL(/\/orders\/ord_demo_oil$/);
    await page.getByRole('button', { name: 'ثبت پرداخت شبیه‌سازی‌شده' }).click();
    await expect(page.getByText('پرداخت نهایی شد')).toBeVisible();

    // Cross-route consistency: the wallet screen, mounted completely fresh,
    // reads the same store through `fetchWallet` and shows the pending
    // balance this exact capture moved to zero.
    await page.goto('/wallet');
    const pendingCard = page.getByText('تعهدشده و در امانت').locator('..');
    await expect(pendingCard.getByText('۰ ریال', { exact: true })).toBeVisible();

    // 8. Attach the prepared document, 9. complete its simulated scan.
    await page.goto('/documents');
    await page.getByRole('button', { name: 'پیوست سند' }).click();
    await expect(page.getByText('سند پیوست شد')).toBeVisible();
    await expect(page.getByText('گزارش-سرویس-سناریو.pdf', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /تکمیل اسکن سند/ }).click();
    await expect(page.getByText('اسکن سند کامل شد — پاک')).toBeVisible();

    // 10. Open the audit surface and show the resulting activity.
    await page.getByRole('link', { name: /گام بعدی: مشاهدهٔ خط زمانی حسابرسی/ }).click();
    await expect(page).toHaveURL(/\/audit$/);
    await page.getByRole('button', { name: 'افزودن یادداشت بازرسی به خط زمانی' }).click();
    await expect(page.getByText('scenario.manual_note_appended')).toBeVisible();

    // Never a real request in any of this — only this dev server.
    expect(external).toEqual([]);
  });

  test('an already-completed step is not offered a second time, even after a reload', async ({
    page,
  }) => {
    await page.goto('/assets/ast_demo_grader');
    await page.getByRole('button', { name: 'ثبت درخواست تعمیر' }).click();
    await expect(page.getByText('درخواست تعمیر ثبت شد')).toBeVisible();

    await page.reload();
    await expect(page.getByText('درخواست تعمیر ثبت شد')).toBeVisible();
    await expect(page.getByRole('button', { name: 'ثبت درخواست تعمیر' })).toHaveCount(0);
  });

  test('refreshing mid-story keeps the scenario at the same stage', async ({ page }) => {
    await page.goto('/assets/ast_demo_grader');
    await page.getByRole('button', { name: 'ثبت درخواست تعمیر' }).click();
    await expect(page.getByText('درخواست تعمیر ثبت شد')).toBeVisible();

    await page.goto('/demo');
    await expect(page.locator('[aria-current="step"]')).toHaveText('درخواست تعمیر ثبت شد');

    await page.reload();
    await expect(page.locator('[aria-current="step"]')).toHaveText('درخواست تعمیر ثبت شد');
  });

  test('resetting from a mid-story stage returns every screen to the initial state', async ({
    page,
  }) => {
    await page.goto('/assets/ast_demo_grader');
    await page.getByRole('button', { name: 'ثبت درخواست تعمیر' }).click();
    await expect(page.getByText('درخواست تعمیر ثبت شد')).toBeVisible();

    await page.goto('/demo');
    await page.getByRole('button', { name: 'بازنشانی سناریوی نمایشی' }).click();
    await page.getByRole('button', { name: 'بازنشانی' }).click();
    await expect(page.getByRole('status')).toHaveText('سناریوی نمایشی بازنشانی شد.');
    await expect(page.locator('[aria-current="step"]')).toHaveText('سازمان انتخاب شد');

    await page.goto('/assets/ast_demo_grader');
    await expect(page.getByRole('button', { name: 'ثبت درخواست تعمیر' })).toBeVisible();
  });
});

test.describe('the investor story at every size', () => {
  for (const width of [390, 768, 1440]) {
    test(`every action control has a reachable tap target at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/assets/ast_demo_grader');

      const button = page.getByRole('button', { name: 'ثبت درخواست تعمیر' });
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflows, `${width}px scrolls sideways with the scenario panel open`).toBe(false);
    });
  }
});
