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
 *
 * ## One run per stack
 *
 * **The live block assumes it is the only run using its stack.** CI gives every
 * job a fresh stack; a local run uses a stack nobody else is writing to. It does
 * not try to share the suite's machine (`AST-SEED-E2E-0001`) with another run:
 * it does not tell its requests from a concurrent run's, and it does not guess
 * whether an open request belongs to a run that is still going. Instead it
 * states the assumption and checks it — before each test the machine must have
 * no open corrective request, or the test stops with a message saying so — and
 * it cancels only the requests this run created, by the ids it recorded.
 * See `e2e/README.md`.
 *
 * ## What the repair-order scenarios leave behind
 *
 * One of them takes a request all the way to a completed repair, which is
 * final: a COMPLETED request is not open, so it does not trip the check above on
 * a re-run, and it is left as the record it is. The suite never approves it —
 * approval authorises settlement, and nothing here may start money moving.
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

/** What every request this suite files starts with: readable in a failure, not a way to find them again. */
const TITLE_PREFIX = 'آزمون مرورگر';
const titled = (what: string): string => `${TITLE_PREFIX} - ${what}`;

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
 * Cancels the requests this run created, by the ids it recorded, and nothing
 * else: no title, prefix or age is used to decide what is "ours". A recorded id
 * that is no longer open (a test that cancelled its own request through the
 * page) is skipped, because cancelling it again would be a conflict, not a
 * cleanup.
 */
async function cancelCreated(request: APIRequestContext, accessToken: string): Promise<void> {
  if (created.size === 0) return;
  const open = new Set((await openCorrective(request, accessToken)).map((record) => record.id));
  for (const id of created) if (open.has(id)) await cancel(request, accessToken, id);
  created.clear();
}

/**
 * The assumption this suite is built on, checked rather than hoped for: the
 * machine has no open corrective request before a test starts. If it has one, a
 * previous run on this stack left it (or another run is using the stack), and
 * the duplicate rule would turn that into a confusing failure inside a test.
 * Nothing is cancelled here — what is open is not this run's to remove.
 */
async function assertMachineIsOurs(request: APIRequestContext, accessToken: string): Promise<void> {
  const open = await openCorrective(request, accessToken);
  if (open.length > 0) {
    throw new Error(
      `${MACHINE} already has ${open.length} open corrective request(s) ` +
        `(${open.map((record) => record.id).join(', ')}). The live browser suite assumes it is ` +
        'the only run on its stack and starts from a machine with none; reset the stack ' +
        '(or cancel those requests yourself) and run it again. See apps/web/e2e/README.md.',
    );
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
    await assertMachineIsOurs(request, accessToken);
  });

  test.afterEach(async ({ request }) => {
    // Only the ids this run recorded.
    if (accessToken) await cancelCreated(request, accessToken);
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

  // -------------------------------------------------------------------------
  // The repair order on a request
  // -------------------------------------------------------------------------

  const WORKSHOP = 'ORG-WORKSHOP-E2E-0001';

  const authorised = () => ({ authorization: `Bearer ${accessToken}` });

  /** A corrective request filed straight at the owning service, its id recorded for cleanup. */
  async function file(request: APIRequestContext, what: string): Promise<string> {
    const filed = await request.post(maintenanceUrl('/v1/maintenance-requests'), {
      headers: authorised(),
      data: { assetId: MACHINE, type: 'CORRECTIVE', severity: 'LOW', title: titled(what) },
    });
    expect(filed.status()).toBe(201);
    const { id } = (await filed.json()) as RequestRecord;
    created.add(id);
    return id;
  }

  /** The request's one repair order, referred straight at the owning service. */
  async function refer(request: APIRequestContext, requestId: string): Promise<string> {
    const assigned = await request.post(
      maintenanceUrl(`/v1/maintenance-requests/${requestId}/assign`),
      {
        headers: authorised(),
        data: { workshopOrganizationId: WORKSHOP, workshopName: 'تعمیرگاه آزمون' },
      },
    );
    expect(assigned.status()).toBe(201);
    return ((await assigned.json()) as { id: string }).id;
  }

  interface OrderRecord {
    id: string;
    status: string;
    partsCostMinor: string;
    labourCostMinor: string;
    otherCostMinor: string;
    totalCostMinor: string;
    parts?: { partName: string; quantity: string; totalCostMinor: string }[];
    labour?: { description: string; hours: string; totalCostMinor: string }[];
    costs?: { category: string; amountMinor: string }[];
  }

  /** What the owning service holds for the order, asked with the same token. */
  async function orderOf(request: APIRequestContext, orderId: string): Promise<OrderRecord> {
    const read = await request.get(maintenanceUrl(`/v1/repair-orders/${orderId}`), {
      headers: authorised(),
    });
    expect(read.status()).toBe(200);
    return (await read.json()) as OrderRecord;
  }

  async function requestOf(request: APIRequestContext, id: string): Promise<RequestRecord> {
    const read = await request.get(maintenanceUrl(`/v1/maintenance-requests/${id}`), {
      headers: authorised(),
    });
    expect(read.status()).toBe(200);
    return (await read.json()) as RequestRecord & { totalCostMinor: string };
  }

  /** A form on the page, found by a control only it has. */
  const formWith = (page: import('@playwright/test').Page, field: string) =>
    page.locator('form').filter({ has: page.locator(`[name="${field}"]`) });

  /** Opens a form that stays closed until asked for. */
  const openDisclosure = async (page: import('@playwright/test').Page, summary: string) => {
    await page.locator('summary', { hasText: summary }).click();
  };

  test('a request goes from referral to a completed repair through its page, and maintenance-service holds every step', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);

    const id = await file(request, 'تعمیر کامل از صفحه');
    const detail = `/maintenance/${encodeURIComponent(id)}`;
    const flashed = new RegExp(`/maintenance/${encodeURIComponent(id)}\\?flash=`);

    // Refer it to a workshop from the page.
    await page.goto(detail);
    const assign = formWith(page, 'workshopOrganizationId');
    await assign.locator('input[name="workshopOrganizationId"]').fill(WORKSHOP);
    await assign.locator('input[name="workshopName"]').fill('تعمیرگاه آزمون');
    await assign.getByRole('button', { name: 'ارجاع به تعمیرگاه' }).click();
    await expect(page).toHaveURL(flashed);
    await expect(page.getByText('کار به تعمیرگاه ارجاع شد.')).toBeVisible();

    const detailOf = await requestOf(request, id);
    const orderId = (detailOf as unknown as { repairOrders: { id: string; status: string }[] })
      .repairOrders[0]?.id;
    expect(orderId).toBeTruthy();
    expect((await orderOf(request, orderId!)).status).toBe('OPEN');

    // Start it.
    await page.getByRole('button', { name: 'آغاز تعمیر' }).click();
    await expect(page).toHaveURL(flashed);
    await expect(page.getByRole('status').filter({ hasText: 'تعمیر آغاز شد' })).toBeVisible();
    expect((await orderOf(request, orderId!)).status).toBe('IN_PROGRESS');
    expect((await requestOf(request, id)).status).toBe('IN_PROGRESS');

    // A part, labour, and a charge that is neither.
    await openDisclosure(page, 'ثبت قطعه');
    const part = formWith(page, 'partName');
    await part.locator('input[name="partName"]').fill('فیلتر روغن');
    await part.locator('input[name="quantity"]').fill('۲');
    await part.locator('input[name="unitCostMinor"]').fill('۳۵۰٬۰۰۰');
    await part.getByRole('button', { name: 'ثبت قطعه' }).click();
    await expect(page.getByText('قطعه ثبت شد.')).toBeVisible();

    await openDisclosure(page, 'ثبت اجرت');
    const labour = formWith(page, 'hourlyRateMinor');
    await labour.locator('input[name="description"]').fill('تعویض شیلنگ');
    await labour.locator('input[name="hours"]').fill('۱٫۵');
    await labour.locator('input[name="hourlyRateMinor"]').fill('800000');
    await labour.getByRole('button', { name: 'ثبت اجرت' }).click();
    await expect(page.getByText('اجرت ثبت شد.')).toBeVisible();

    await openDisclosure(page, 'ثبت هزینهٔ دیگر');
    const charge = formWith(page, 'amountMinor');
    await charge.locator('select[name="category"]').selectOption('SERVICE');
    await charge.locator('input[name="amountMinor"]').fill('500000');
    await charge.locator('input[name="description"]').fill('ایاب و ذهاب');
    await charge.getByRole('button', { name: 'ثبت هزینه' }).click();
    await expect(page.getByText('هزینه ثبت شد.')).toBeVisible();

    // Money is minor-unit strings in the service, however it was typed: 2 × 350 000,
    // 1.5 h × 800 000, 500 000.
    const recorded = await orderOf(request, orderId!);
    expect(recorded).toEqual(
      expect.objectContaining({
        status: 'IN_PROGRESS',
        partsCostMinor: '700000',
        labourCostMinor: '1200000',
        otherCostMinor: '500000',
        totalCostMinor: '2400000',
      }),
    );
    expect(recorded.parts).toEqual([
      expect.objectContaining({ partName: 'فیلتر روغن', quantity: '2', totalCostMinor: '700000' }),
    ]);
    expect(recorded.labour).toEqual([
      expect.objectContaining({ description: 'تعویض شیلنگ', hours: '1.5' }),
    ]);
    // And the page lists them as read back, in the reader's digits.
    await expect(page.getByText(/فیلتر روغن — ۲ عدد/)).toBeVisible();
    await expect(page.getByText(/تعویض شیلنگ — ۱٫۵ ساعت/)).toBeVisible();

    // The page was drawn at 2 400 000. Somebody else records a charge before the
    // button is pressed: the completion is refused by the service, whole, and the
    // person is sent to a page that shows the new total.
    const late = await request.post(maintenanceUrl(`/v1/repair-orders/${orderId}/costs`), {
      headers: authorised(),
      data: {
        category: 'SERVICE',
        amountMinor: '400000',
        currency: 'IRR',
        description: 'هزینه دیرهنگام',
      },
    });
    expect(late.status()).toBe(201);

    const complete = formWith(page, 'workPerformed');
    await complete.locator('textarea[name="workPerformed"]').fill('شیلنگ و فیلتر تعویض شد');
    await complete.getByRole('button', { name: 'تکمیل تعمیر' }).click();
    await expect(page).toHaveURL(flashed);
    await expect(
      page.getByRole('alert').filter({ hasText: 'هزینهٔ ارجاع از زمان نمایش تغییر کرده بود' }),
    ).toBeVisible();
    expect((await orderOf(request, orderId!)).status).toBe('IN_PROGRESS');
    expect((await requestOf(request, id)).status).toBe('IN_PROGRESS');

    // At the total it now shows, it goes through.
    await page.goto(detail);
    const again = formWith(page, 'workPerformed');
    await again.locator('textarea[name="workPerformed"]').fill('شیلنگ و فیلتر تعویض شد');
    await again.getByRole('button', { name: 'تکمیل تعمیر' }).click();
    await expect(page).toHaveURL(flashed);
    await expect(page.getByRole('status').filter({ hasText: 'تعمیر تکمیل شد' })).toBeVisible();

    const done = await orderOf(request, orderId!);
    expect(done).toEqual(
      expect.objectContaining({ status: 'COMPLETED', totalCostMinor: '2800000' }),
    );
    const completed = (await requestOf(request, id)) as RequestRecord & { totalCostMinor: string };
    expect(completed.status).toBe('COMPLETED');
    expect(completed.totalCostMinor).toBe('2800000');

    // What is left is the owner's approval of that total — offered, never pressed.
    await expect(page.getByRole('heading', { name: 'تأیید هزینه' })).toBeVisible();
    await expect(page.getByText(/۲٬۸۰۰٬۰۰۰ ریال/).first()).toBeVisible();
  });

  test('a referral is withdrawn from its page, the request stays open, and a form carrying another command’s baseline is refused', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    const id = await file(request, 'ارجاع پس‌گرفته');
    const orderId = await refer(request, id);
    const detail = `/maintenance/${encodeURIComponent(id)}`;

    await page.goto(detail);

    // The start form and the withdraw form each carry a baseline signed for that
    // command. Put the withdraw form's into the start form, as a script could.
    const start = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'آغاز تعمیر' }) });
    await page.locator('summary', { hasText: 'پس‌گرفتن این ارجاع' }).click();
    const withdraw = formWith(page, 'reason').filter({
      has: page.getByRole('button', { name: 'پس‌گرفتن ارجاع' }),
    });
    const withdrawBaseline = await withdraw.locator('input[name="baseline"]').inputValue();
    await start.locator('input[name="baseline"]').evaluate((input, value) => {
      (input as HTMLInputElement).value = value;
    }, withdrawBaseline);
    await start.getByRole('button', { name: 'آغاز تعمیر' }).click();

    await expect(
      page.getByText(/این فرم منقضی شده است یا با صفحهٔ نمایش‌داده‌شده نمی‌خواند/),
    ).toBeVisible();
    expect((await orderOf(request, orderId)).status).toBe('OPEN');

    // The withdrawal itself.
    await page.goto(detail);
    await page.locator('summary', { hasText: 'پس‌گرفتن این ارجاع' }).click();
    const form = formWith(page, 'reason').filter({
      has: page.getByRole('button', { name: 'پس‌گرفتن ارجاع' }),
    });
    await form.locator('textarea[name="reason"]').fill('تعمیرگاه کار را نپذیرفت');
    await form.getByRole('button', { name: 'پس‌گرفتن ارجاع' }).click();

    await expect(page).toHaveURL(new RegExp(`${encodeURIComponent(id)}\\?flash=`));
    await expect(page.getByRole('status').filter({ hasText: 'ارجاع پس گرفته شد' })).toBeVisible();

    const withdrawn = await orderOf(request, orderId);
    expect(withdrawn.status).toBe('CANCELLED');
    // The request is not the job going away: it is open, and can be referred again.
    expect((await requestOf(request, id)).status).toBe('OPEN');
    await expect(formWith(page, 'workshopOrganizationId')).toBeVisible();
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
