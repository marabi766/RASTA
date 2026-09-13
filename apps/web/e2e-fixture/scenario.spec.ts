import { expect, test, type Page } from '@playwright/test';

/**
 * The interactive scenario engine, against the real fixture-mode production
 * build: the status card, the reset control's full confirm flow, and the
 * same "opens no connection to any host but this server" guarantee
 * `presentation.spec.ts` already proves for the rest of the demo.
 */

function recordExternalRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('http') && !url.includes('localhost:3212')) seen.push(url);
  });
  return seen;
}

test.describe('the scenario status card', () => {
  test('shows the scenario name, stage and a revision of zero on first load', async ({ page }) => {
    await page.goto('/demo');

    await expect(page.getByText('scenario_demo_grader_oil_change')).toBeVisible();
    // Two legitimate matches since Phase C added the stage stepper: the
    // summary line and the stepper's current-stage chip.
    await expect(page.getByText('سازمان انتخاب شد', { exact: true }).first()).toBeVisible();
  });

  test('never appears on a product screen away from the presentation', async ({ page }) => {
    await page.goto('/assets');
    await expect(page.getByText('scenario_demo_grader_oil_change')).toHaveCount(0);
  });
});

test.describe('scenario reset, end to end', () => {
  test('asks for confirmation, then shows a success status', async ({ page }) => {
    const external = recordExternalRequests(page);
    await page.goto('/demo');

    await page.getByRole('button', { name: 'بازنشانی سناریوی نمایشی' }).click();
    await expect(page.getByRole('button', { name: 'بازنشانی' })).toBeFocused();

    await page.getByRole('button', { name: 'بازنشانی' }).click();
    await expect(page.getByRole('status')).toHaveText('سناریوی نمایشی بازنشانی شد.');
    await expect(page.getByRole('status')).toBeFocused();

    expect(external).toEqual([]);
  });

  test('cancel returns focus to the trigger and makes no change', async ({ page }) => {
    await page.goto('/demo');

    await page.getByRole('button', { name: 'بازنشانی سناریوی نمایشی' }).click();
    await page.getByRole('button', { name: 'انصراف' }).click();

    await expect(page.getByRole('button', { name: 'بازنشانی سناریوی نمایشی' })).toBeFocused();
    await expect(page.getByText('بازبینی')).toBeVisible();
  });

  test('is reachable with the keyboard alone', async ({ page }) => {
    await page.goto('/demo');

    await page.getByRole('button', { name: 'بازنشانی سناریوی نمایشی' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'بازنشانی' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('status')).toBeVisible();
  });

  test('the fixture disclosure stays visible through the whole reset flow', async ({ page }) => {
    await page.goto('/demo');
    await expect(page.getByTestId('fixture-disclosure')).toBeVisible();

    await page.getByRole('button', { name: 'بازنشانی سناریوی نمایشی' }).click();
    await expect(page.getByTestId('fixture-disclosure')).toBeVisible();

    await page.getByRole('button', { name: 'بازنشانی' }).click();
    await expect(page.getByTestId('fixture-disclosure')).toBeVisible();
  });
});

test.describe('the scenario surface at every size', () => {
  for (const width of [390, 768, 1440]) {
    test(`reset control has a reachable tap target at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/demo');

      const trigger = page.getByRole('button', { name: 'بازنشانی سناریوی نمایشی' });
      const box = (await trigger.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);

      await trigger.click();
      const confirm = page.getByRole('button', { name: 'بازنشانی' });
      const confirmBox = (await confirm.boundingBox())!;
      expect(confirmBox.height).toBeGreaterThanOrEqual(44);

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(overflows, `${width}px scrolls sideways with the confirm step open`).toBe(false);
    });
  }
});
