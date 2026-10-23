import { randomBytes, randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import {
  INVENTORY_COMMAND_LABELS,
  INVENTORY_CONSIGNEE_NOTE,
  INVENTORY_DONE_MESSAGES,
  INVENTORY_REFUSAL_TEXT,
  INVENTORY_SHIPMENT_FINISHED_NOTE,
} from '../src/lib/inventory-commands';
import {
  installLiveSession,
  installProvisionedSession,
  liveAccessToken,
  type LivePersona,
  type ProvisionedPerson,
} from './live-session';
import { provisionPerson } from './provisioned-people';

/**
 * Inventory's operator commands through the real stack (EXP-004 criterion 1
 * and 2): the portal, the real gateway, a real inventory-service on a real
 * PostgreSQL, real tokens. Every command is issued **in the browser**, through
 * the portal's own forms; the API is touched only to prove what the forms
 * cannot show.
 *
 * ## Who does what
 *
 * - **the owner** — `dehyari.admin` (ORG-DEH-0001): creates a warehouse,
 *   receives stock, adjusts it (a decrease; one that would leave less than zero
 *   is refused in fixed words), creates a shipment to the other organization,
 *   dispatches it and delivers it.
 * - **the consignee** — `dehyari.admin.b` (ORG-DEH-0002): reads the shipment
 *   and its tracking and is offered no move, in fixed words; never sees the
 *   owner's warehouse.
 * - **a third organization** — provisioned with ORGANIZATION_ADMIN into an
 *   organization of its own: the shipment is, to it, the same absence as an id
 *   that does not exist.
 *
 * Each test of the serial run builds on the one before; every run creates its
 * own warehouse, so the same file runs at desktop and at phone size
 * (`playwright.config.ts`, `MOBILE_SPECS`) without sharing a record. Nothing
 * here is mocked: a stale form, a refusal and an unconfirmed outcome are the
 * unit specs' business (`inventory-actions.spec.ts`, `inventory-retry.spec.tsx`).
 */

const CONSIGNEE = 'ORG-DEH-0002';
const MISSING_SHIPMENT = 'SHP_ZZZZZZZZZZZZZZZZZZZZZZZZZZ';
const RUN = randomUUID().slice(0, 8);
/** An organization of its own for each run: two viewports provision two people. */
const OUTSIDER_ORGANIZATION = `ORG-E2E-INV-${RUN.toUpperCase()}`;
const WAREHOUSE_NAME = `انبار آزمون ${RUN}`;
const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** A `PRD_<ULID>` the service accepts: 26 characters of Crockford's alphabet. */
function productId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(26);
  return `PRD_${Array.from(bytes, (byte) => alphabet[byte % 32]).join('')}`;
}
const PRODUCT = productId();

async function mainText(page: Page): Promise<string> {
  return (await page.locator('main').innerText()).trim();
}

async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_2_1_AA).analyze();
  expect(violations).toEqual([]);
  // Nothing wider than the screen: on a phone a table that overflows the page is reached by dragging.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
}

/** A fresh browser context signed in as one person, for one step of the story. */
async function as(
  browser: Browser,
  who: LivePersona | ProvisionedPerson,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ locale: 'fa-IR', timezoneId: 'Asia/Tehran' });
  if (typeof who === 'string') await installLiveSession(context, who);
  else await installProvisionedSession(context, who);
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

// Under CI the job sets both flags; a skip there would be a green job with no evidence.
if (process.env.CI && process.env.WEB_LIVE_STACK_E2E_EXP004 !== 'true') {
  test('CI runs the live inventory scenarios, none skipped', () => {
    throw new Error(
      'WEB_LIVE_STACK_E2E_EXP004 must be \'true\' in CI: the "Portal in a browser" job starts ' +
        'inventory-service alongside the usual live stack for these scenarios.',
    );
  });
}

test.describe.serial('inventory commands, live (EXP-004)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true' || process.env.WEB_LIVE_STACK_E2E_EXP004 !== 'true',
    'needs inventory-service alongside the usual live stack — set WEB_LIVE_STACK_E2E=true and ' +
      'WEB_LIVE_STACK_E2E_EXP004=true locally after starting it (the "Portal in a browser" CI job ' +
      'always does)',
  );
  test.setTimeout(120_000);

  let outsider: ProvisionedPerson;
  let warehousePath = '';
  let shipmentPath = '';

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    outsider = await provisionPerson(
      await liveAccessToken('systemAdmin'),
      `e2e.inventory.${RUN}.outsider`,
      OUTSIDER_ORGANIZATION,
      ['ORGANIZATION_ADMIN'],
    );
  });

  test('the owner creates a warehouse in the browser', async ({ browser }) => {
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto('/inventory');
      const form = page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.CREATE_WAREHOUSE });
      await expect(form).toBeVisible();
      // What the API has not: no edit, no retire.
      await expect(page.getByRole('form', { name: /ویرایش|بستن|حذف/ })).toHaveCount(0);
      await expectAccessible(page);

      await form.getByLabel('نام انبار').fill(WAREHOUSE_NAME);
      await form.getByRole('button', { name: INVENTORY_COMMAND_LABELS.CREATE_WAREHOUSE }).click();

      await expect(page).toHaveURL(/\/inventory\?warehouse=WHS_[^&]+&flash=/);
      warehousePath = `/inventory?warehouse=${new URL(page.url()).searchParams.get('warehouse')}`;
      await expect(page.getByText(INVENTORY_DONE_MESSAGES.CREATE_WAREHOUSE)).toBeVisible();
      await expect(page.getByRole('link', { name: WAREHOUSE_NAME })).toBeVisible();
      // Nothing in it yet: a receipt is offered, an adjustment waits for stock.
      await expect(
        page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.RECEIVE_STOCK }),
      ).toBeVisible();
      await expect(
        page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.ADJUST_STOCK }),
      ).toHaveCount(0);
      await expect(page.getByText('حرکتی ثبت نشده')).toBeVisible();
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('the owner receives stock; the balance and the ledger say so', async ({ browser }) => {
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(warehousePath);
      const form = page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.RECEIVE_STOCK });
      await form.getByLabel('شناسه کالا').fill(PRODUCT);
      await form.getByLabel('تعداد دریافتی').fill('۵۰');
      await form.getByRole('button', { name: INVENTORY_COMMAND_LABELS.RECEIVE_STOCK }).click();

      await expect(page).toHaveURL(/flash=/);
      await expect(page.getByText(INVENTORY_DONE_MESSAGES.RECEIVE_STOCK)).toBeVisible();
      const stock = page.getByRole('table', { name: 'موجودی کالاها در انبار' });
      await expect(stock.getByRole('row', { name: new RegExp(PRODUCT) })).toContainText('۵۰');
      const ledger = page.getByRole('table', { name: 'حرکت‌های موجودی انبار' });
      await expect(ledger.getByRole('row').nth(1)).toContainText('رسید');
      await expect(ledger.getByRole('row').nth(1)).toContainText('+۵۰');
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('the owner adjusts it down; one that would go below zero is refused in the portal’s words', async ({
    browser,
  }) => {
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(warehousePath);
      const form = page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.ADJUST_STOCK });
      await expect(form).toBeVisible();
      // The API has neither a reason nor a second approval; the form says so and draws neither.
      await expect(form).toContainText('دلیل یا تایید دوم نمی‌خواهد');
      await expect(form.getByLabel(/دلیل/)).toHaveCount(0);

      await form.getByLabel('کالا', { exact: false }).first().selectOption({ index: 1 });
      await form.getByLabel('نوع تغییر').selectOption('DECREASE');
      await form.getByLabel('مقدار').fill('۱۰۰۰');
      await form.getByRole('button', { name: INVENTORY_COMMAND_LABELS.ADJUST_STOCK }).click();
      await expect(page.getByText(INVENTORY_REFUSAL_TEXT.ON_HAND_WOULD_BE_NEGATIVE)).toBeVisible();
      expect(await mainText(page)).not.toMatch(/ON_HAND_WOULD_BE_NEGATIVE|would|negative/i);
      await expectAccessible(page);

      await form.getByLabel('مقدار').fill('۸');
      await form.getByRole('button', { name: INVENTORY_COMMAND_LABELS.ADJUST_STOCK }).click();
      await expect(page).toHaveURL(/flash=/);
      await expect(page.getByText(INVENTORY_DONE_MESSAGES.ADJUST_STOCK)).toBeVisible();
      const stock = page.getByRole('table', { name: 'موجودی کالاها در انبار' });
      await expect(stock.getByRole('row', { name: new RegExp(PRODUCT) })).toContainText('۴۲');
      const ledger = page.getByRole('table', { name: 'حرکت‌های موجودی انبار' });
      await expect(ledger.getByRole('row').nth(1)).toContainText('اصلاح');
      await expect(ledger.getByRole('row').nth(1)).toContainText('−۸');
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('the owner creates a shipment to the other organization', async ({ browser }) => {
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(warehousePath);
      const form = page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.CREATE_SHIPMENT });
      await form.getByLabel('سازمان گیرنده').fill(CONSIGNEE);
      await form.getByLabel('حمل‌کننده مرحله ۱').fill(`باربری ${RUN}`);
      await form.getByRole('button', { name: 'افزودن مرحله حمل' }).click();
      await form.getByLabel('حمل‌کننده مرحله ۲').fill('باربری دوم');
      await form.getByLabel('شماره پیگیری مرحله ۲').fill('WB-2');
      await form.getByRole('button', { name: INVENTORY_COMMAND_LABELS.CREATE_SHIPMENT }).click();

      await expect(page).toHaveURL(/\/inventory\/shipments\/SHP_[^?]+\?flash=/);
      shipmentPath = new URL(page.url()).pathname;
      await expect(page.getByText(INVENTORY_DONE_MESSAGES.CREATE_SHIPMENT)).toBeVisible();
      await expect(page.getByText('ایجادشده، هنوز ارسال نشده').first()).toBeVisible();
      const legs = page.getByRole('table', { name: 'مرحله‌های حمل محموله' });
      await expect(legs.getByRole('row').nth(1)).toContainText(`باربری ${RUN}`);
      await expect(legs.getByRole('row').nth(2)).toContainText('WB-2');
      // The dispatch only: a shipment is not delivered before it left.
      await expect(
        page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.DISPATCH_SHIPMENT }),
      ).toBeVisible();
      await expect(
        page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.DELIVER_SHIPMENT }),
      ).toHaveCount(0);
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('the consignee reads it and tracks it; it moves nothing, and the owner’s warehouse is not its own', async ({
    browser,
  }) => {
    expect(shipmentPath).not.toBe('');
    const { page, close } = await as(browser, 'orgAdminB');
    try {
      await page.goto(shipmentPath);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('اطلاعات محموله');
      await expect(page.getByText(INVENTORY_CONSIGNEE_NOTE)).toBeVisible();
      await expect(page.locator('main form')).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'پیگیری محموله' })).toContainText('ایجادشده');
      await expectAccessible(page);

      // It sees the shipment in its list, and still not the warehouse it leaves.
      await page.goto('/inventory');
      expect(await mainText(page)).toContain(shipmentPath.split('/').pop());
      expect(await mainText(page)).not.toContain(WAREHOUSE_NAME);
      await page.goto(warehousePath);
      await expect(page.getByText('انبار یافت نشد')).toBeVisible();
      await expect(
        page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.RECEIVE_STOCK }),
      ).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('a third organization finds the shipment exactly as it finds an id that does not exist', async ({
    browser,
  }) => {
    const { page, close } = await as(browser, outsider);
    try {
      await page.goto(shipmentPath);
      await expect(page.getByText('این محموله پیدا نشد')).toBeVisible();
      const foreign = await mainText(page);
      await page.goto(`/inventory/shipments/${MISSING_SHIPMENT}`);
      expect(await mainText(page)).toBe(foreign);
      expect(foreign).not.toContain(WAREHOUSE_NAME);
      await page.goto(warehousePath);
      await expect(page.getByText('انبار یافت نشد')).toBeVisible();
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('the owner dispatches, then delivers; the history follows', async ({ browser }) => {
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(shipmentPath);
      await page
        .getByRole('form', { name: INVENTORY_COMMAND_LABELS.DISPATCH_SHIPMENT })
        .getByRole('button', { name: INVENTORY_COMMAND_LABELS.DISPATCH_SHIPMENT })
        .click();
      await expect(page).toHaveURL(/flash=/);
      await expect(page.getByText(INVENTORY_DONE_MESSAGES.DISPATCH_SHIPMENT)).toBeVisible();
      await expect(page.getByText('ارسال‌شده، در راه').first()).toBeVisible();
      await expect(
        page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.DISPATCH_SHIPMENT }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('form', { name: INVENTORY_COMMAND_LABELS.DELIVER_SHIPMENT }),
      ).toBeVisible();
      await expectAccessible(page);

      await page
        .getByRole('form', { name: INVENTORY_COMMAND_LABELS.DELIVER_SHIPMENT })
        .getByRole('button', { name: INVENTORY_COMMAND_LABELS.DELIVER_SHIPMENT })
        .click();
      await expect(page).toHaveURL(/flash=/);
      await expect(page.getByText(INVENTORY_DONE_MESSAGES.DELIVER_SHIPMENT)).toBeVisible();
      await expect(page.getByText('تحویل‌شده').first()).toBeVisible();
      await expect(page.getByText(INVENTORY_SHIPMENT_FINISHED_NOTE)).toBeVisible();
      await expect(page.locator('main form')).toHaveCount(0);
      const tracking = page.getByRole('region', { name: 'پیگیری محموله' });
      await expect(tracking.getByRole('listitem')).toHaveCount(3);
      await expectAccessible(page);
    } finally {
      await close();
    }
  });

  test('a delivered shipment’s old dispatch form is refused in fixed words by the service', async ({
    browser,
  }) => {
    // A dispatch form drawn earlier in another tab is what the service refuses once the
    // shipment has moved: proven through the API, with the closed reason in `details`.
    const token = await liveAccessToken('orgAdmin');
    const id = shipmentPath.split('/').pop()!;
    const response = await fetch(
      `${(process.env.API_GATEWAY_URL ?? '').replace(/\/+$/, '')}/v1/shipments/${id}/dispatch`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `e2e-inventory-${randomUUID()}`,
        },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; details?: { code?: string }[] };
    expect(body.code).toBe('INVALID_STATE_TRANSITION');
    expect(body.details?.[0]?.code).toBe('SHIPMENT_NOT_CREATED');
    // And the portal draws neither move.
    const { page, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto(shipmentPath);
      await expect(page.locator('main form')).toHaveCount(0);
      await expect(page.locator('main')).not.toContainText('SHIPMENT_NOT_CREATED');
    } finally {
      await close();
    }
  });
});
