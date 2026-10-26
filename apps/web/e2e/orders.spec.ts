import { randomUUID } from 'node:crypto';

import { test, type APIRequestContext } from '@playwright/test';
import { expect } from './expect';

import { formatMoney } from '../src/lib/format';
import { ORDER_STATUS_LABELS } from '../src/lib/order-fields';
import { installLiveSession } from './live-session';

/**
 * Placing an order through the live stack (EXP-003), and who can see it.
 *
 * ## No money moves
 *
 * CI starts marketplace-service with `MARKETPLACE_TEMPORAL_ENABLED=false`
 * (ADR-039's explicit no-Temporal mode), so no saga runs: an order stays
 * `PENDING`, nothing is held, and economic-service is not in this stack. The
 * suite never confirms receipt, never settles — `e2e/README.md`: no browser test
 * may start money moving.
 *
 * ## The data
 *
 * marketplace-service's demo seed gives each tenant offers on the same product:
 * `PRD_SEED_AGGREGATE` is offered by ORG-DEH-0001 (`OFR_SEED_AGGREGATE_D1`) and by
 * ORG-DEH-0002 (`OFR_SEED_AGGREGATE_D2`, 8 900 000 per unit, minimum 10, 220
 * available), and ORG-DEH-0002 also holds a **draft** offer
 * (`OFR_SEED_HOSE_D2_DRAFT`) nobody else may see.
 *
 * ## What "another tenant's resource" is here
 *
 * An order has exactly two parties, and the realm has two non-platform
 * organizations. A third, unrelated organization to read an order as does not
 * exist in the realm, so the order-read leg shows the boundary from both sides
 * (each side's list holds only what it is a party to under that role) rather
 * than a stranger's 404 — that needs a third persona, which is realm and
 * identity-seed work outside `apps/web`. The **write** leg has a real stranger:
 * ORG-DEH-0002's draft offer is, to ORG-DEH-0001, an offer that does not exist,
 * and an order against it must be answered exactly as one against an id that was
 * never there.
 *
 * Specs here share what the first one places, so they run in order.
 */

test.describe('placing an order through the live stack', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true',
    'needs the live stack the Portal in a browser job starts',
  );
  test.describe.configure({ mode: 'serial' });

  const PRODUCT = 'PRD_SEED_AGGREGATE';
  const OWN_OFFER = 'OFR_SEED_AGGREGATE_D1';
  const OTHER_OFFER = 'OFR_SEED_AGGREGATE_D2';
  const OTHER_TENANT_DRAFT = 'OFR_SEED_HOSE_D2_DRAFT';
  const MISSING_OFFER = 'OFR_SEED_9999';
  const MINIMUM = 10;
  const UNIT_PRICE = 8_900_000n;
  const BUYER = 'ORG-DEH-0001';
  const SUPPLIER = 'ORG-DEH-0002';

  const gatewayUrl = (path: string): string => {
    const base = process.env.API_GATEWAY_URL;
    if (!base) throw new Error('The live portal browser test requires API_GATEWAY_URL');
    return `${base.replace(/\/+$/, '')}${path}`;
  };

  const headers = (token: string, key?: string) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(key ? { 'idempotency-key': key } : {}),
  });

  interface OrderBody {
    id: string;
    status: string;
    buyerOrganizationId: string;
    supplierOrganizationId: string;
    totalAmountMinor: string;
    lines: { offerId: string; quantity: number; unitPriceMinor: string }[];
  }

  async function orderIds(
    request: APIRequestContext,
    token: string,
    role: 'BUYER' | 'SUPPLIER',
  ): Promise<string[]> {
    const response = await request.get(gatewayUrl(`/v1/orders?role=${role}&limit=100`), {
      headers: headers(token),
    });
    expect(response.status()).toBe(200);
    return ((await response.json()) as { items: { id: string }[] }).items.map((o) => o.id);
  }

  /** What the service says to an order for these offers, reduced to what must not differ. */
  async function answerTo(request: APIRequestContext, token: string, offerId: string) {
    const response = await request.post(gatewayUrl('/v1/orders'), {
      headers: headers(token, `e2e-${randomUUID()}`),
      data: { lines: [{ offerId, quantity: MINIMUM }] },
    });
    const body = (await response.json()) as { code?: string; message?: string };
    return { status: response.status(), code: body.code, message: body.message };
  }

  let placedId = '';

  test('the buyer sees the form without its own offer, is refused below the minimum, and then places the order', async ({
    browser,
    request,
  }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ locale: 'fa-IR', timezoneId: 'Asia/Tehran' });
    const session = await installLiveSession(context, 'orgAdmin');
    expect(session.organizationId).toBe(BUYER);
    const page = await context.newPage();

    const before = await orderIds(request, session.accessToken, 'BUYER');

    await page.goto(`/marketplace/${PRODUCT}`);
    const form = page.getByRole('form', { name: 'ثبت سفارش' });
    await expect(form).toBeVisible();

    // Its own offer is on the page (the table lists every supplier) but not a
    // choice in the form: a form built only to be refused is not offered.
    const choices = await form
      .locator('select[name="offerId"] option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(choices).toContain(OTHER_OFFER);
    expect(choices).not.toContain(OWN_OFFER);

    // The copy that must not claim a bank.
    await expect(form).toContainText('به بانک واقعی وصل نیست');
    await expect(form).not.toContainText(/پرداخت امن|درگاه/);

    // Below the supplier's minimum: refused by the service, kept on the form.
    await form.locator('select[name="offerId"]').selectOption(OTHER_OFFER);
    await form.locator('input[name="quantity"]').fill('1');
    await form.getByRole('button', { name: 'ثبت سفارش' }).click();

    // The portal's own sentence for the service's one business-rule code; the
    // service's English (which names the offer and the live minimum) is not shown.
    await expect(page.getByText(/سفارش با شرایط کنونی این پیشنهاد جور نیست/)).toBeVisible();
    await expect(page.getByText(/minimum quantity/i)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/marketplace/${PRODUCT}$`));
    await expect(form.locator('select[name="offerId"]')).toHaveValue(OTHER_OFFER);
    // And nothing was placed.
    expect(await orderIds(request, session.accessToken, 'BUYER')).toEqual(before);

    // At the minimum, in Persian digits as a person on a Persian keyboard types it.
    await form.locator('input[name="quantity"]').fill('۱۰');
    await form.getByRole('button', { name: 'ثبت سفارش' }).click();

    await expect(page).toHaveURL(/\/orders\/[^/?]+\?placed=1$/);
    placedId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
    expect(placedId).not.toBe('');

    await expect(page.getByText(/سفارش ثبت شد/)).toBeVisible();
    const main = page.locator('main');
    await expect(main).toContainText(placedId);
    await expect(main).toContainText(ORDER_STATUS_LABELS.PENDING!);
    // Priced by the service, not by the page: the total the portal shows is the
    // one the service holds, read back below.
    await expect(main).toContainText(formatMoney((UNIT_PRICE * BigInt(MINIMUM)).toString()));
    await expect(main).not.toContainText(/پرداخت شد|پذیرفته شد/);

    const read = await request.get(gatewayUrl(`/v1/orders/${placedId}`), {
      headers: headers(session.accessToken),
    });
    expect(read.status()).toBe(200);
    const order = (await read.json()) as OrderBody;
    expect(order).toMatchObject({
      status: 'PENDING',
      buyerOrganizationId: BUYER,
      supplierOrganizationId: SUPPLIER,
      totalAmountMinor: (UNIT_PRICE * BigInt(MINIMUM)).toString(),
    });
    expect(order.lines).toMatchObject([
      { offerId: OTHER_OFFER, quantity: MINIMUM, unitPriceMinor: UNIT_PRICE.toString() },
    ]);

    await context.close();
  });

  test('the service replays an order placed twice under one key, which is what a repeated submit relies on', async ({
    request,
    browser,
  }) => {
    const context = await browser.newContext();
    const session = await installLiveSession(context, 'orgAdmin');
    const key = `e2e-${randomUUID()}`;
    const send = () =>
      request.post(gatewayUrl('/v1/orders'), {
        headers: headers(session.accessToken, key),
        data: { lines: [{ offerId: OTHER_OFFER, quantity: MINIMUM }] },
      });

    const first = await send();
    const second = await send();
    expect(first.status()).toBe(201);
    expect(second.status()).toBe(201);
    const firstId = ((await first.json()) as OrderBody).id;
    expect(((await second.json()) as OrderBody).id).toBe(firstId);

    // One order for the key, not two: the buyer's list holds it once.
    const ids = await orderIds(request, session.accessToken, 'BUYER');
    expect(ids.filter((id) => id === firstId)).toHaveLength(1);
    await context.close();
  });

  test('both parties are parties, and each list holds an order only under the role it has in it', async ({
    browser,
    request,
  }) => {
    test.skip(placedId === '', 'the order was not placed by the previous test');
    const buyerContext = await browser.newContext({ locale: 'fa-IR', timezoneId: 'Asia/Tehran' });
    const buyer = await installLiveSession(buyerContext, 'orgAdmin');
    const supplierContext = await browser.newContext({
      locale: 'fa-IR',
      timezoneId: 'Asia/Tehran',
    });
    const supplier = await installLiveSession(supplierContext, 'orgAdminB');
    expect(supplier.organizationId).toBe(SUPPLIER);

    // The supplier is a party: it reads the order, in the API and in the portal.
    const read = await request.get(gatewayUrl(`/v1/orders/${placedId}`), {
      headers: headers(supplier.accessToken),
    });
    expect(read.status()).toBe(200);
    const page = await supplierContext.newPage();
    await page.goto(`/orders/${placedId}`);
    await expect(page.locator('main')).toContainText(placedId);

    // Roles do not bleed: the supplier did not place it, the buyer is not selling.
    expect(await orderIds(request, supplier.accessToken, 'SUPPLIER')).toContain(placedId);
    expect(await orderIds(request, supplier.accessToken, 'BUYER')).not.toContain(placedId);
    expect(await orderIds(request, buyer.accessToken, 'BUYER')).toContain(placedId);
    expect(await orderIds(request, buyer.accessToken, 'SUPPLIER')).not.toContain(placedId);

    await buyerContext.close();
    await supplierContext.close();
  });

  test('another tenant’s draft offer is answered exactly as an offer that does not exist', async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext();
    const buyer = await installLiveSession(context, 'orgAdmin');
    const before = await orderIds(request, buyer.accessToken, 'BUYER');

    const foreign = await answerTo(request, buyer.accessToken, OTHER_TENANT_DRAFT);
    const missing = await answerTo(request, buyer.accessToken, MISSING_OFFER);

    expect(foreign).toEqual({ status: 404, code: 'NOT_FOUND', message: expect.any(String) });
    // Byte for byte: status, code and message. An id must not tell the draft
    // from the nothing.
    expect(foreign).toEqual(missing);

    // Control, so the 404 above is the boundary and not a broken request: the
    // same call against a published offer of the same tenant is accepted.
    const control = await answerTo(request, buyer.accessToken, OTHER_OFFER);
    expect(control.status).toBe(201);

    // And nothing was placed by the two refusals.
    const after = await orderIds(request, buyer.accessToken, 'BUYER');
    expect(after.filter((id) => !before.includes(id))).toHaveLength(1);
    await context.close();
  });

  test('an organization is refused an order from its own offer, in words, not found', async ({
    browser,
    request,
  }) => {
    const context = await browser.newContext();
    const supplier = await installLiveSession(context, 'orgAdminB');
    const answer = await answerTo(request, supplier.accessToken, OTHER_OFFER);
    expect(answer).toMatchObject({ status: 422, code: 'BUSINESS_RULE_VIOLATION' });
    expect(answer.message).toBe('An organization cannot order from itself');
    await context.close();
  });
});
