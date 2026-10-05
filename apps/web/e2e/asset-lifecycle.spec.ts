import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { sharedDocument } from './document-fixture';
import { installLiveSession } from './live-session';

/**
 * A machine's life on `/assets/[id]` in a real browser — commission it, change
 * its status, retire it — at desktop and at phone size (EXP-002, slice 5).
 *
 * ## Which machines, and why that is safe at both viewports
 *
 * Every test registers **its own** machine through the API with a serial number
 * no other test shares, and works on that one alone. Nothing here reads or
 * writes a seeded asset, so the two Playwright projects can run these scenarios
 * at the same time on one stack without meeting each other — which is why this
 * spec, unlike the other write scenarios, runs at the phone's size too
 * (`playwright.config.ts`).
 *
 * ## What is proved, and by whom
 *
 * The portal is never the only witness of its own write. After each step the
 * scenario asks asset-service, through the gateway and with the same token, what
 * the machine now holds — its status, its version and how many times its
 * timeline says the thing happened. That last number is what shows a stale or
 * repeated command wrote **nothing**, not merely that the page said so.
 *
 * ## Cleanup
 *
 * Each test records the id of every machine it registers, and `afterEach`
 * decommissions exactly those ids that are still in the fleet. A machine cannot
 * be deleted (financial and audit records point at it), so retiring it is the
 * only honest end of a test's machine; nothing is selected by name or age.
 */

test.skip(
  process.env.WEB_LIVE_STACK_E2E !== 'true',
  'needs the live stack the Portal in a browser job starts',
);

const NAME_PREFIX = 'آزمون مرورگر - چرخهٔ حیات';
const DAY_MS = 24 * 60 * 60 * 1000;

function gatewayUrl(path: string): string {
  const base = process.env.API_GATEWAY_URL;
  if (!base) throw new Error('The live portal browser test requires API_GATEWAY_URL');
  return `${base.replace(/\/+$/, '')}${path}`;
}

const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'idempotency-key': `e2e-${randomUUID()}`,
});

interface AssetRecord {
  id: string;
  name: string;
  status: string;
  version: number;
}

async function read(request: APIRequestContext, token: string, id: string): Promise<AssetRecord> {
  const response = await request.get(gatewayUrl(`/v1/assets/${id}`), { headers: auth(token) });
  expect(response.status()).toBe(200);
  return (await response.json()) as AssetRecord;
}

/** How many times the machine's timeline records each event — what actually happened to it. */
async function timelineCounts(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<Record<string, number>> {
  const response = await request.get(gatewayUrl(`/v1/assets/${id}/timeline?limit=100`), {
    headers: auth(token),
  });
  expect(response.status()).toBe(200);
  const { items } = (await response.json()) as { items: { eventName: string }[] };
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.eventName] = (counts[item.eventName] ?? 0) + 1;
  return counts;
}

/** Ids this test registered, so cleanup touches those and nothing else. */
const registered = new Set<string>();

/** Maintenance requests this test filed, cancelled first so they never hold a machine open. */
const filedRequests = new Set<string>();

async function cancelFiledRequests(request: APIRequestContext, accessToken: string): Promise<void> {
  for (const id of filedRequests) {
    const cancelled = await request.post(gatewayUrl(`/v1/maintenance-requests/${id}/cancel`), {
      headers: auth(accessToken),
      data: { reason: 'پاک‌سازی آزمون مرورگر' },
    });
    // Already cancelled through the page or the API is a conflict, not a failure.
    expect([200, 409]).toContain(cancelled.status());
  }
  filedRequests.clear();
}

/**
 * A machine of this test's own: registered, with the dossier activation asks for
 * (a policy in force and an ownership title) unless `complete` is false.
 */
async function registerMachine(
  request: APIRequestContext,
  token: string,
  options: { complete?: boolean } = {},
): Promise<AssetRecord> {
  const suffix = randomUUID().slice(0, 8);
  const created = await request.post(gatewayUrl('/v1/assets'), {
    headers: auth(token),
    data: {
      name: `${NAME_PREFIX} ${suffix}`,
      type: 'LOADER',
      serialNumber: `E2E-LC-${randomUUID().slice(0, 12)}`,
    },
  });
  expect(created.status()).toBe(201);
  const asset = (await created.json()) as AssetRecord;
  registered.add(asset.id);

  if (options.complete !== false) {
    const policy = await request.post(gatewayUrl(`/v1/assets/${asset.id}/insurance-policies`), {
      headers: auth(token),
      data: {
        policyNumber: `E2E-POL-${suffix}`,
        insurerName: 'بیمه نمونه',
        coverage: 'THIRD_PARTY',
        validFrom: new Date(Date.now() - DAY_MS).toISOString(),
        validTo: new Date(Date.now() + 300 * DAY_MS).toISOString(),
      },
    });
    expect(policy.status()).toBe(201);
    const title = await request.post(gatewayUrl(`/v1/assets/${asset.id}/documents`), {
      headers: auth(token),
      data: {
        documentId: await sharedDocument(request, token),
        kind: 'OWNERSHIP_TITLE',
        title: 'سند مالکیت آزمون',
      },
    });
    expect(title.status()).toBe(201);
  }
  return read(request, token, asset.id);
}

/** Moves a machine through the API, as another person's earlier command would have. */
async function command(
  request: APIRequestContext,
  token: string,
  id: string,
  verb: 'activate' | 'status' | 'decommission',
  body: Record<string, unknown>,
): Promise<AssetRecord> {
  const response = await request.post(gatewayUrl(`/v1/assets/${id}/${verb}`), {
    headers: auth(token),
    data: body,
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as AssetRecord;
}

const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function violationsOf(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_2_1_AA).analyze();
  return violations.map((violation) => ({
    rule: violation.id,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
}

/** A page that scrolls sideways has something wider than the screen on it. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** The machine's status as the identity card shows it. */
const statusBadge = (page: Page) =>
  page
    .locator('dl > div')
    .filter({ has: page.locator('dt', { hasText: /^وضعیت$/ }) })
    .locator('dd');

/** The tick that names the machine, found by the words it carries. */
const confirmationTick = (page: Page, name: string) =>
  page.getByRole('checkbox', {
    name: new RegExp(`اسقاط «${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}»`),
  });

const NOTICES = {
  activated: 'دارایی فعال شد و به ناوگان پیوست.',
  statusChanged: 'وضعیت دارایی تغییر کرد.',
  decommissioned: 'دارایی اسقاط شد. این وضعیت نهایی است.',
};
const NOTHING_WRITTEN = /این بار چیزی نوشته نشد/;

test.describe('a machine’s life, through the portal and the live stack', () => {
  let token: string;

  test.beforeEach(async ({ context }) => {
    token = (await installLiveSession(context, 'orgAdmin')).accessToken;
  });

  test.afterEach(async ({ request }) => {
    // Cancel the requests this test filed (an open one would keep a machine
    // from being retired), then retire what it registered and left in the
    // fleet; skip what it already retired through the page.
    await cancelFiledRequests(request, token);
    for (const id of registered) {
      const asset = await read(request, token, id);
      if (asset.status !== 'DECOMMISSIONED') {
        await command(request, token, id, 'decommission', {
          reason: 'پاک‌سازی آزمون مرورگر',
          expectedVersion: asset.version,
        });
      }
    }
    registered.clear();
  });

  test('commissions, changes the status of and retires a machine, one confirmed step at a time', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    await page.goto(`/assets/${asset.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(asset.name);
    await expect(statusBadge(page)).toHaveText('ثبت‌شده');

    // A registered machine can be commissioned, withdrawn or retired; it cannot
    // be "marked idle" before it is in service, and the form offers no such thing.
    await expect(page.getByRole('button', { name: 'فعال‌سازی دارایی' })).toBeVisible();
    await expect(page.getByLabel('وضعیت تازه').locator('option')).toHaveText([
      'انتخاب کنید…',
      'خارج از سرویس',
    ]);

    // ---- activate ---------------------------------------------------------
    await page.getByRole('button', { name: 'فعال‌سازی دارایی' }).click();
    await expect(page.getByText(NOTICES.activated)).toBeVisible();
    await expect(statusBadge(page)).toHaveText('فعال');
    await expect(page.getByRole('button', { name: 'فعال‌سازی دارایی' })).toHaveCount(0);

    const active = await read(request, token, asset.id);
    expect(active.status).toBe('ACTIVE');
    expect(active.version).toBe(asset.version + 1);
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({ ASSET_ACTIVATED: 1 });

    // ---- change status ----------------------------------------------------
    // From ACTIVE a person may go idle or withdraw the machine — and nothing
    // that another service owns (assigned, in repair).
    await expect(page.getByLabel('وضعیت تازه').locator('option')).toHaveText([
      'انتخاب کنید…',
      'بیکار',
      'خارج از سرویس',
    ]);
    await page.getByLabel('وضعیت تازه').selectOption('IDLE');
    await page.getByLabel(/دلیل تغییر/).fill('فصل غیرکاری، تا بهار');
    await page.getByRole('button', { name: 'ثبت تغییر وضعیت' }).click();

    await expect(page.getByText(NOTICES.statusChanged)).toBeVisible();
    await expect(statusBadge(page)).toHaveText('بیکار');
    const idle = await read(request, token, asset.id);
    expect(idle.status).toBe('IDLE');
    expect(idle.version).toBe(active.version + 1);
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      ASSET_ACTIVATED: 1,
      ASSET_STATUS_CHANGED: 1,
    });

    // ---- decommission: name it, say why, confirm ---------------------------
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.getByText('اسقاط این دارایی…').click();
    await expect(page.getByText(`اسقاط «${asset.name}»`, { exact: true })).toBeVisible();
    await expect(page.getByText(/نهایی و بازگشت‌ناپذیر است/)).toBeVisible();
    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // Without the tick the browser refuses before anything is sent...
    await page.getByLabel(/دلیل اسقاط/).fill('فرسودگی کامل و هزینهٔ تعمیر بیش از ارزش');
    await page.getByRole('button', { name: 'اسقاط قطعی دارایی' }).click();
    await expect(page.getByText(NOTICES.decommissioned)).toHaveCount(0);
    expect((await read(request, token, asset.id)).status).toBe('IDLE');

    // ...and with it, the machine is retired.
    await confirmationTick(page, asset.name).check();
    await page.getByRole('button', { name: 'اسقاط قطعی دارایی' }).click();

    await expect(page.getByText(NOTICES.decommissioned)).toBeVisible();
    await expect(page.getByText('این دارایی اسقاط شده است')).toBeVisible();
    await expect(statusBadge(page)).toHaveText('از رده خارج');
    // Final: no lifecycle form and no edit form is offered any more.
    await expect(page.getByRole('heading', { name: 'وضعیت و چرخهٔ حیات' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ذخیرهٔ مشخصات' })).toHaveCount(0);

    const gone = await read(request, token, asset.id);
    expect(gone.status).toBe('DECOMMISSIONED');
    expect(gone.version).toBe(idle.version + 1);
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      ASSET_ACTIVATED: 1,
      ASSET_STATUS_CHANGED: 1,
      ASSET_DECOMMISSIONED: 1,
    });

    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('an activation that is refused says what the dossier is missing, and writes nothing', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token, { complete: false });
    await page.goto(`/assets/${asset.id}`);

    await page.getByRole('button', { name: 'فعال‌سازی دارایی' }).click();

    // Both are missing, and the service names both at once.
    await expect(
      page.getByRole('alert').filter({ hasText: /هیچ‌کدام ثبت نشده است/ }),
    ).toBeVisible();
    expect(await read(request, token, asset.id)).toMatchObject({
      status: 'REGISTERED',
      version: asset.version,
    });
    expect(await timelineCounts(request, token, asset.id)).not.toHaveProperty('ASSET_ACTIVATED');
  });

  test('a page that went stale is refused and shown the machine as it is, and nothing is written', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    await page.goto(`/assets/${asset.id}`);
    await expect(page.getByRole('button', { name: 'فعال‌سازی دارایی' })).toBeVisible();

    // Somebody else renames the machine after this page was drawn: its version
    // moves on, its status does not.
    const renamed = `${asset.name} (نام تازه)`;
    const response = await request.patch(gatewayUrl(`/v1/assets/${asset.id}`), {
      headers: auth(token),
      data: { name: renamed, expectedVersion: asset.version },
    });
    expect(response.status()).toBe(200);

    await page.getByRole('button', { name: 'فعال‌سازی دارایی' }).click();

    // Refused — with the reason, as a warning, on the page as it is now.
    await expect(page.getByText(NOTHING_WRITTEN)).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: NOTHING_WRITTEN })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);
    await expect(statusBadge(page)).toHaveText('ثبت‌شده');
    await expect(page.getByText(NOTICES.activated)).toHaveCount(0);

    const after = await read(request, token, asset.id);
    expect(after.status).toBe('REGISTERED');
    expect(after.version).toBe(asset.version + 1);
    expect(await timelineCounts(request, token, asset.id)).not.toHaveProperty('ASSET_ACTIVATED');

    // The fresh page carries a fresh version: the same button now works.
    await page.getByRole('button', { name: 'فعال‌سازی دارایی' }).click();
    await expect(page.getByText(NOTICES.activated)).toBeVisible();
    expect((await read(request, token, asset.id)).status).toBe('ACTIVE');
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({ ASSET_ACTIVATED: 1 });
  });

  test('the same command from open pages is applied once; the others are told it is already changed', async ({
    context,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    await command(request, token, asset.id, 'activate', {
      expectedVersion: asset.version,
    });
    const drawnAt = asset.version + 1;

    // Three tabs of one person, all drawn at the same version: the machine is
    // ACTIVE and every one offers "mark idle".
    const [first, second, third] = await Promise.all([
      context.newPage(),
      context.newPage(),
      context.newPage(),
    ]);
    for (const page of [first, second, third]) {
      await page.goto(`/assets/${asset.id}`);
      await page.getByLabel('وضعیت تازه').selectOption('IDLE');
      await page.getByLabel(/دلیل تغییر/).fill('فصل غیرکاری، تا بهار');
    }

    await first.getByRole('button', { name: 'ثبت تغییر وضعیت' }).click();
    await expect(first.getByText(NOTICES.statusChanged)).toBeVisible();

    // The same form again: already changed, not applied a second time.
    await second.getByRole('button', { name: 'ثبت تغییر وضعیت' }).click();
    await expect(second.getByText(NOTHING_WRITTEN)).toBeVisible();
    await expect(second.getByText(NOTICES.statusChanged)).toHaveCount(0);

    const idle = await read(request, token, asset.id);
    expect(idle.status).toBe('IDLE');
    expect(idle.version).toBe(drawnAt + 1);
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      ASSET_STATUS_CHANGED: 1,
    });

    // Somebody returns the machine to service. Now the third tab's "mark idle"
    // is a legal move from where the machine stands — a status check alone would
    // let it through — and is still refused, because the machine is not the one
    // that tab was drawn from.
    const back = await command(request, token, asset.id, 'status', {
      status: 'ACTIVE',
      reason: 'بازگشت به سرویس',
      expectedVersion: idle.version,
    });
    await third.getByRole('button', { name: 'ثبت تغییر وضعیت' }).click();
    await expect(third.getByText(NOTHING_WRITTEN)).toBeVisible();

    const after = await read(request, token, asset.id);
    expect(after).toMatchObject({ status: 'ACTIVE', version: back.version });
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      ASSET_STATUS_CHANGED: 2, // the first tab's, and the return to service — never a third
    });
  });

  test('a decommission sent from a second page after the first retired the machine is refused, and recorded once', async ({
    context,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto(`/assets/${asset.id}`);
    await second.goto(`/assets/${asset.id}`);

    for (const page of [first, second]) {
      await page.getByText('اسقاط این دارایی…').click();
      await page.getByLabel(/دلیل اسقاط/).fill('فرسودگی کامل و هزینهٔ تعمیر بیش از ارزش');
      await confirmationTick(page, asset.name).check();
    }

    await first.getByRole('button', { name: 'اسقاط قطعی دارایی' }).click();
    await expect(first.getByText(NOTICES.decommissioned)).toBeVisible();

    await second.getByRole('button', { name: 'اسقاط قطعی دارایی' }).click();
    // Already changed — not a second retirement, and not a confusing "invalid
    // transition" either.
    await expect(second.getByText(NOTHING_WRITTEN)).toBeVisible();
    await expect(second.getByText(NOTICES.decommissioned)).toHaveCount(0);

    const gone = await read(request, token, asset.id);
    expect(gone.status).toBe('DECOMMISSIONED');
    expect(gone.version).toBe(asset.version + 1);
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      ASSET_DECOMMISSIONED: 1,
    });
  });

  test('a machine with open maintenance work cannot be retired, even though its own status shows none', async ({
    page,
    request,
    isMobile,
  }) => {
    test.skip(isMobile, 'a service-to-service rule, identical at the phone’s size');

    // OUT_OF_SERVICE shows no open work at all: maintenance accepts a repair on
    // such a machine and asset-service keeps it OUT_OF_SERVICE, so only the
    // owner of the work knows (docs/24 Q-94).
    const asset = await registerMachine(request, token, { complete: false });
    const out = await command(request, token, asset.id, 'status', {
      status: 'OUT_OF_SERVICE',
      reason: 'عیب فنی، در انتظار تعمیر',
      expectedVersion: asset.version,
    });
    expect(out.status).toBe('OUT_OF_SERVICE');

    // maintenance-service learns of the new machine from its event; until it
    // has, it cannot take a request about it, so wait for exactly that.
    let requestId = '';
    await expect
      .poll(
        async () => {
          const filed = await request.post(gatewayUrl('/v1/maintenance-requests'), {
            headers: auth(token),
            data: {
              assetId: asset.id,
              type: 'CORRECTIVE',
              severity: 'LOW',
              title: `${NAME_PREFIX} - کار باز`,
            },
          });
          if (filed.status() === 201) {
            requestId = ((await filed.json()) as { id: string }).id;
            filedRequests.add(requestId);
          }
          return filed.status();
        },
        { timeout: 60_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toBe(201);

    await page.goto(`/assets/${asset.id}`);
    await expect(statusBadge(page)).toHaveText('خارج از سرویس');
    await page.getByText('اسقاط این دارایی…').click();
    await page.getByLabel(/دلیل اسقاط/).fill('فرسودگی کامل و هزینهٔ تعمیر بیش از ارزش');
    await confirmationTick(page, asset.name).check();
    await page.getByRole('button', { name: 'اسقاط قطعی دارایی' }).click();

    // Refused with the reason, as a warning, and nothing written.
    await expect(page.getByRole('alert').filter({ hasText: /کار باز تعمیر دارد/ })).toBeVisible();
    await expect(page.getByText(NOTICES.decommissioned)).toHaveCount(0);
    const refused = await read(request, token, asset.id);
    expect(refused).toMatchObject({ status: 'OUT_OF_SERVICE', version: out.version });
    expect(await timelineCounts(request, token, asset.id)).not.toHaveProperty(
      'ASSET_DECOMMISSIONED',
    );

    // The owner closes its work; the same form, still at the same version, goes through.
    const cancelled = await request.post(
      gatewayUrl(`/v1/maintenance-requests/${requestId}/cancel`),
      {
        headers: auth(token),
        data: { reason: 'پاک‌سازی آزمون مرورگر' },
      },
    );
    expect(cancelled.status()).toBe(200);
    filedRequests.delete(requestId);

    await page.getByLabel(/دلیل اسقاط/).fill('فرسودگی کامل و هزینهٔ تعمیر بیش از ارزش');
    await confirmationTick(page, asset.name).check();
    await page.getByRole('button', { name: 'اسقاط قطعی دارایی' }).click();
    await expect(page.getByText(NOTICES.decommissioned)).toBeVisible();
    expect((await read(request, token, asset.id)).status).toBe('DECOMMISSIONED');
  });

  test('a person without the right to manage assets is offered no forms, and the service refuses them anyway', async ({
    context,
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const operator = (await installLiveSession(context, 'operator')).accessToken;

    await page.goto(`/assets/${asset.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(asset.name);
    await expect(page.getByRole('heading', { name: 'وضعیت و چرخهٔ حیات' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'فعال‌سازی دارایی' })).toHaveCount(0);

    // The page hiding the forms is UX. The service is the check.
    for (const [verb, body] of [
      ['activate', { expectedVersion: asset.version }],
      [
        'status',
        { status: 'OUT_OF_SERVICE', reason: 'تلاش بدون دسترسی', expectedVersion: asset.version },
      ],
      ['decommission', { reason: 'تلاش بدون دسترسی', expectedVersion: asset.version }],
    ] as const) {
      const refused = await request.post(gatewayUrl(`/v1/assets/${asset.id}/${verb}`), {
        headers: auth(operator),
        data: body,
      });
      expect([verb, refused.status()]).toEqual([verb, 403]);
    }
    expect(await read(request, token, asset.id)).toMatchObject({
      status: 'REGISTERED',
      version: asset.version,
    });
  });
});

test.describe('another organization’s machine, through the portal and the live stack', () => {
  // Pure tenant-isolation checks with no layout in them: once, at desktop size.
  test.skip(({ isMobile }) => isMobile, 'identical at the phone’s size, and written once');

  test.afterEach(async ({ context, request }) => {
    const owner = (await installLiveSession(context, 'orgAdmin')).accessToken;
    for (const id of registered) {
      const asset = await read(request, owner, id);
      if (asset.status !== 'DECOMMISSIONED') {
        await command(request, owner, id, 'decommission', {
          reason: 'پاک‌سازی آزمون مرورگر',
          expectedVersion: asset.version,
        });
      }
    }
    registered.clear();
  });

  test('is answered as a machine that does not exist, for the page and for every write', async ({
    context,
    page,
    request,
  }) => {
    const owner = (await installLiveSession(context, 'orgAdmin')).accessToken;
    const asset = await registerMachine(request, owner);
    const missing = 'AST_01J00000000000000000000999';

    const other = (await installLiveSession(context, 'orgAdminB')).accessToken;

    // The page.
    const mainText = async (id: string) => {
      await page.goto(`/assets/${id}`);
      await expect(page.getByText('این دارایی پیدا نشد')).toBeVisible();
      return (await page.locator('main').innerText()).trim();
    };
    const foreignPage = await mainText(asset.id);
    const missingPage = await mainText(missing);
    expect(foreignPage).toBe(missingPage);
    expect(foreignPage).not.toContain(asset.id);
    expect(foreignPage).not.toContain(asset.name);
    await expect(page.getByRole('button', { name: 'فعال‌سازی دارایی' })).toHaveCount(0);
    await expect(page.getByText('اسقاط این دارایی…')).toHaveCount(0);

    // The read and every write, well-formed so the body is not what is refused:
    // a malformed one would answer 400 for any id and hide whether the tenant
    // boundary held.
    const answered = async (id: string, verb: string | null, body: Record<string, unknown>) => {
      const response =
        verb === null
          ? await request.get(gatewayUrl(`/v1/assets/${id}`), { headers: auth(other) })
          : verb === 'patch'
            ? await request.patch(gatewayUrl(`/v1/assets/${id}`), {
                headers: auth(other),
                data: body,
              })
            : await request.post(gatewayUrl(`/v1/assets/${id}/${verb}`), {
                headers: auth(other),
                data: body,
              });
      const json = (await response.json()) as { code?: string; message?: string };
      return { status: response.status(), code: json.code, message: json.message };
    };

    const WRITES: readonly [string | null, Record<string, unknown>][] = [
      [null, {}],
      ['patch', { name: 'تغییر از مستأجر دیگر', expectedVersion: asset.version }],
      ['activate', { expectedVersion: asset.version }],
      [
        'status',
        { status: 'OUT_OF_SERVICE', reason: 'تلاش از مستأجر دیگر', expectedVersion: asset.version },
      ],
      ['decommission', { reason: 'تلاش از مستأجر دیگر', expectedVersion: asset.version }],
    ];
    for (const [verb, body] of WRITES) {
      const foreign = await answered(asset.id, verb, body);
      const nothing = await answered(missing, verb, body);
      expect(foreign).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      // Byte for byte the answer for an id that does not exist.
      expect([verb, foreign]).toEqual([verb, nothing]);
    }

    // And nothing moved: asked of the owner's own token.
    expect(await read(request, owner, asset.id)).toMatchObject({
      name: asset.name,
      status: 'REGISTERED',
      version: asset.version,
    });
    expect(await timelineCounts(request, owner, asset.id)).not.toHaveProperty('ASSET_ACTIVATED');
  });
});
