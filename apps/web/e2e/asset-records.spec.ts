import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { installLiveSession } from './live-session';

/**
 * A machine's insurance policies and technical inspections on `/assets/[id]` in a
 * real browser, at desktop and at phone size (EXP-002, slice 6): record one, see
 * it judged against the server's clock, send a form twice, and ask for another
 * organization's machine.
 *
 * ## Which machines, and why that is safe at both viewports
 *
 * As in `asset-lifecycle.spec.ts`: every test registers **its own** machine
 * through the API, with serial and policy numbers no other test shares, and works
 * on that one alone. Nothing here reads or writes a seeded asset, so the two
 * Playwright projects can run these scenarios at the same time on one stack.
 *
 * ## What is proved, and by whom
 *
 * The portal is never the only witness of its own write. After each step the
 * scenario asks asset-service, through the gateway and with the same token, what
 * the machine now holds — the rows, and how many times its timeline says each
 * thing happened (the timeline entry is written in the same transaction as the
 * record and its outbox event). That last number is what shows a repeated send
 * wrote **nothing**, not merely that the page said so.
 *
 * ## Cleanup
 *
 * Each test records the id of every machine it registers, and `afterEach`
 * decommissions exactly those ids that are still in the fleet. A machine cannot
 * be deleted (financial and audit records point at it), so retiring it is the
 * only honest end; nothing is selected by name or age.
 */

test.skip(
  process.env.WEB_LIVE_STACK_E2E !== 'true',
  'needs the live stack the Portal in a browser job starts',
);

const NAME_PREFIX = 'آزمون مرورگر - ثبت سوابق';
const DAY_MS = 24 * 60 * 60 * 1000;

function gatewayUrl(path: string): string {
  const base = process.env.API_GATEWAY_URL;
  if (!base) throw new Error('The live portal browser test requires API_GATEWAY_URL');
  return `${base.replace(/\/+$/, '')}${path}`;
}

const auth = (token: string, key: string = `e2e-${randomUUID()}`) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'idempotency-key': key,
});

interface AssetRecord {
  id: string;
  name: string;
  status: string;
  version: number;
}

interface PolicyRecord {
  id: string;
  policyNumber: string;
  insurerName: string;
  coverage: string;
  premiumMinor: string | null;
  validFrom: string;
  validTo: string;
}

interface InspectionRecord {
  id: string;
  certificateNo: string;
  centerName: string | null;
  inspectedAt: string;
  validTo: string;
  result: string;
}

async function read(request: APIRequestContext, token: string, id: string): Promise<AssetRecord> {
  const response = await request.get(gatewayUrl(`/v1/assets/${id}`), { headers: auth(token) });
  expect(response.status()).toBe(200);
  return (await response.json()) as AssetRecord;
}

async function policiesOf(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<PolicyRecord[]> {
  const response = await request.get(gatewayUrl(`/v1/assets/${id}/insurance-policies`), {
    headers: auth(token),
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as PolicyRecord[];
}

async function inspectionsOf(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<InspectionRecord[]> {
  const response = await request.get(gatewayUrl(`/v1/assets/${id}/inspections`), {
    headers: auth(token),
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as InspectionRecord[];
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

/** A machine of this test's own, registered and with no policy or inspection yet. */
async function registerMachine(request: APIRequestContext, token: string): Promise<AssetRecord> {
  const suffix = randomUUID().slice(0, 8);
  const created = await request.post(gatewayUrl('/v1/assets'), {
    headers: auth(token),
    data: {
      name: `${NAME_PREFIX} ${suffix}`,
      type: 'LOADER',
      serialNumber: `E2E-REC-${randomUUID().slice(0, 12)}`,
    },
  });
  expect(created.status()).toBe(201);
  const asset = (await created.json()) as AssetRecord;
  registered.add(asset.id);
  return read(request, token, asset.id);
}

async function retireRegistered(request: APIRequestContext, token: string): Promise<void> {
  for (const id of registered) {
    const asset = await read(request, token, id);
    if (asset.status !== 'DECOMMISSIONED') {
      const retired = await request.post(gatewayUrl(`/v1/assets/${id}/decommission`), {
        headers: auth(token),
        data: { reason: 'پاک‌سازی آزمون مرورگر', expectedVersion: asset.version },
      });
      expect(retired.status()).toBe(200);
    }
  }
  registered.clear();
}

/** `YYYY-MM-DD` of the UTC day `offset` days from now — what `type="date"` takes. */
const ymd = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

/** The instant the portal sends for a typed day: Tehran midnight of it. */
const tehranMidnight = (day: string): string => new Date(`${day}T00:00:00+03:30`).toISOString();

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

const NOTICES = {
  policy: 'بیمه‌نامه ثبت شد.',
  inspection: 'معاینهٔ فنی ثبت شد.',
};

const policyForm = (page: Page) => page.getByRole('form', { name: 'ثبت بیمه‌نامه' });
const inspectionForm = (page: Page) => page.getByRole('form', { name: 'ثبت معاینهٔ فنی' });

const policyItem = (page: Page, policyNumber: string) =>
  page.getByTestId('policy-list').locator('li', { hasText: policyNumber });
const inspectionItem = (page: Page, certificateNo: string) =>
  page.getByTestId('inspection-list').locator('li', { hasText: certificateNo });

async function openAndFillPolicy(
  page: Page,
  fields: { number: string; from: string; to: string; premium?: string },
): Promise<void> {
  await page.getByText('ثبت بیمه‌نامه…', { exact: true }).click();
  const form = policyForm(page);
  await form.getByLabel(/شمارهٔ بیمه‌نامه/).fill(fields.number);
  await form.getByLabel(/شرکت بیمه/).fill('بیمه نمونه');
  await form.getByLabel(/نوع پوشش/).selectOption('COMPREHENSIVE');
  await form.getByLabel(/تاریخ شروع/).fill(fields.from);
  await form.getByLabel(/تاریخ پایان/).fill(fields.to);
  if (fields.premium) await form.getByLabel(/حق بیمه/).fill(fields.premium);
}

test.describe('a machine’s insurance and inspections, through the portal and the live stack', () => {
  let token: string;

  test.beforeEach(async ({ context }) => {
    token = (await installLiveSession(context, 'orgAdmin')).accessToken;
  });

  test.afterEach(async ({ request }) => {
    await retireRegistered(request, token);
  });

  test('records a policy, shows it as in force on the server’s clock, and a calendar day never moves by one', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const number = `E2E-POL-${randomUUID().slice(0, 10)}`;
    const from = ymd(-2);
    const to = ymd(300);

    await page.goto(`/assets/${asset.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(asset.name);
    // Nothing recorded yet, and the section says so.
    await expect(page.getByText('بیمه‌نامه‌ای ثبت نشده')).toBeVisible();

    await openAndFillPolicy(page, { number, from, to, premium: '۱۲۰٬۰۰۰٬۰۰۰' });

    // The form open on the page is itself accessible, at this viewport.
    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await policyForm(page).getByRole('button', { name: 'ثبت بیمه‌نامه' }).click();
    await expect(page.getByText(NOTICES.policy)).toBeVisible();

    const item = policyItem(page, number);
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute('data-window', 'CURRENT');
    await expect(item.getByText('معتبر', { exact: true })).toBeVisible();
    await expect(item.getByText('بیمه نمونه')).toBeVisible();
    await expect(item.getByText('جامع (بدنه)')).toBeVisible();

    // What the service holds: one row, the typed days as Tehran midnight, the
    // amount as minor units — and one entry on the timeline.
    const rows = await policiesOf(request, token, asset.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      policyNumber: number,
      insurerName: 'بیمه نمونه',
      coverage: 'COMPREHENSIVE',
      premiumMinor: '120000000',
      validFrom: tehranMidnight(from),
      validTo: tehranMidnight(to),
    });
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      INSURANCE_RECORDED: 1,
    });

    // After the redirect the page is a plain GET: reloading it records nothing.
    await page.reload();
    await expect(policyItem(page, number)).toHaveCount(1);
    expect(await policiesOf(request, token, asset.id)).toHaveLength(1);

    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('records an inspection, with its result and the date it is next due', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const certificate = `E2E-INSP-${randomUUID().slice(0, 10)}`;
    const inspected = ymd(-3);
    const due = ymd(360);

    await page.goto(`/assets/${asset.id}`);
    await expect(page.getByText('معاینهٔ فنی‌ای ثبت نشده')).toBeVisible();

    await page.getByText('ثبت معاینهٔ فنی…', { exact: true }).click();
    const form = inspectionForm(page);
    await form.getByLabel(/شمارهٔ گواهی/).fill(certificate);
    await form.getByLabel(/مرکز معاینه/).fill('مرکز معاینه فنی شمال');
    await form.getByLabel(/نتیجهٔ معاینه/).selectOption('CONDITIONAL');
    await form.getByLabel(/تاریخ معاینه/).fill(inspected);
    await form.getByLabel(/تاریخ پایان اعتبار/).fill(due);
    await form.getByLabel(/یادداشت/).fill('لنت ترمز نزدیک به تعویض');

    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await form.getByRole('button', { name: 'ثبت معاینهٔ فنی' }).click();
    await expect(page.getByText(NOTICES.inspection)).toBeVisible();

    const item = inspectionItem(page, certificate);
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute('data-window', 'CURRENT');
    await expect(item.getByText('مشروط', { exact: true })).toBeVisible();
    await expect(item.getByText('مرکز معاینه فنی شمال')).toBeVisible();
    await expect(item.getByText('معاینهٔ بعدی تا')).toBeVisible();
    await expect(item.getByText('لنت ترمز نزدیک به تعویض')).toBeVisible();

    const rows = await inspectionsOf(request, token, asset.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      certificateNo: certificate,
      centerName: 'مرکز معاینه فنی شمال',
      result: 'CONDITIONAL',
      inspectedAt: tehranMidnight(inspected),
      validTo: tehranMidnight(due),
    });
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      INSPECTION_RECORDED: 1,
    });

    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('judges each record against the server’s clock: expired, current and not yet begun, whatever the browser’s clock says', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const suffix = randomUUID().slice(0, 8);

    // The service refuses a policy that has already lapsed, so the three windows
    // come from what it accepts: a policy in force, one that begins next week,
    // and an inspection whose certificate ran out a month ago.
    const post = async (path: string, data: Record<string, unknown>) => {
      const response = await request.post(gatewayUrl(`/v1/assets/${asset.id}/${path}`), {
        headers: auth(token),
        data,
      });
      expect(response.status()).toBe(201);
    };
    const current = `E2E-CUR-${suffix}`;
    const future = `E2E-FUT-${suffix}`;
    const lapsed = `E2E-OLD-${suffix}`;
    await post('insurance-policies', {
      policyNumber: current,
      insurerName: 'بیمه نمونه',
      coverage: 'THIRD_PARTY',
      validFrom: new Date(Date.now() - 5 * DAY_MS).toISOString(),
      validTo: new Date(Date.now() + 200 * DAY_MS).toISOString(),
    });
    await post('insurance-policies', {
      policyNumber: future,
      insurerName: 'بیمه نمونه',
      coverage: 'LIABILITY',
      validFrom: new Date(Date.now() + 7 * DAY_MS).toISOString(),
      validTo: new Date(Date.now() + 400 * DAY_MS).toISOString(),
    });
    await post('inspections', {
      certificateNo: lapsed,
      inspectedAt: new Date(Date.now() - 400 * DAY_MS).toISOString(),
      validTo: new Date(Date.now() - 35 * DAY_MS).toISOString(),
      result: 'PASSED',
    });

    const expectWindows = async () => {
      await expect(policyItem(page, current)).toHaveAttribute('data-window', 'CURRENT');
      await expect(policyItem(page, future)).toHaveAttribute('data-window', 'FUTURE');
      await expect(inspectionItem(page, lapsed)).toHaveAttribute('data-window', 'EXPIRED');
      await expect(policyItem(page, future).getByText('هنوز آغاز نشده')).toBeVisible();
      await expect(inspectionItem(page, lapsed).getByText('منقضی', { exact: true })).toBeVisible();
    };

    await page.goto(`/assets/${asset.id}`);
    await expectWindows();

    // The visitor's clock is far in the future: every date on the page is "in the
    // past" to the browser, and the page still says what the server judged.
    await page.clock.setFixedTime(new Date('2040-06-01T00:00:00Z'));
    await page.reload();
    await expectWindows();
    // And the same with the browser's clock far in the past.
    await page.clock.setFixedTime(new Date('2001-01-01T00:00:00Z'));
    await page.reload();
    await expectWindows();
  });

  test('a form sent twice records once: a double click, and the same key through the gateway', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const number = `E2E-DBL-${randomUUID().slice(0, 10)}`;

    // ---- two presses of one button ---------------------------------------
    await page.goto(`/assets/${asset.id}`);
    await openAndFillPolicy(page, { number, from: ymd(-1), to: ymd(300) });
    await policyForm(page).getByRole('button', { name: 'ثبت بیمه‌نامه' }).dblclick();
    await expect(policyItem(page, number)).toHaveCount(1);

    expect(await policiesOf(request, token, asset.id)).toHaveLength(1);
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      INSURANCE_RECORDED: 1,
    });

    // ---- the same submission, replayed, through the gateway ---------------
    const key = `e2e-${randomUUID()}`;
    const body = {
      certificateNo: `E2E-RPL-${randomUUID().slice(0, 10)}`,
      inspectedAt: new Date(Date.now() - DAY_MS).toISOString(),
      validTo: new Date(Date.now() + 300 * DAY_MS).toISOString(),
      result: 'PASSED',
    };
    const send = (data: Record<string, unknown>) =>
      request.post(gatewayUrl(`/v1/assets/${asset.id}/inspections`), {
        headers: auth(token, key),
        data,
      });

    const first = await send(body);
    expect(first.status()).toBe(201);
    const second = await send(body);
    // The second answer is the first one's, replayed: same status, same record.
    expect(second.status()).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(await inspectionsOf(request, token, asset.id)).toHaveLength(1);
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      INSPECTION_RECORDED: 1,
    });

    // The same key with another body is refused, and records nothing.
    const reused = await send({ ...body, result: 'FAILED' });
    expect(reused.status()).toBe(409);
    expect(((await reused.json()) as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await inspectionsOf(request, token, asset.id)).toHaveLength(1);
    expect(await timelineCounts(request, token, asset.id)).not.toHaveProperty('INSPECTION_FAILED');

    // And a write with no key at all is refused: the service does not guess.
    const keyless = await request.post(gatewayUrl(`/v1/assets/${asset.id}/inspections`), {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: { ...body, certificateNo: `E2E-NOKEY-${randomUUID().slice(0, 8)}` },
    });
    expect(keyless.status()).toBe(400);
    expect(await inspectionsOf(request, token, asset.id)).toHaveLength(1);
  });

  test('says in words that a policy was already recorded, and records it once, when a second page sends the same number', async ({
    context,
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const number = `E2E-SAME-${randomUUID().slice(0, 10)}`;
    const second = await context.newPage();

    for (const target of [page, second]) {
      await target.goto(`/assets/${asset.id}`);
      await openAndFillPolicy(target, { number, from: ymd(-1), to: ymd(300) });
    }

    await policyForm(page).getByRole('button', { name: 'ثبت بیمه‌نامه' }).click();
    await expect(page.getByText(NOTICES.policy)).toBeVisible();

    // A different render, so a different submission: the service's own
    // uniqueness answers, in Persian, and nothing is recorded twice.
    await policyForm(second).getByRole('button', { name: 'ثبت بیمه‌نامه' }).click();
    await expect(
      second.getByRole('alert').filter({ hasText: /از پیش در سامانه ثبت شده/ }),
    ).toBeVisible();
    await expect(second.getByText(NOTICES.policy)).toHaveCount(0);

    expect(await policiesOf(request, token, asset.id)).toHaveLength(1);
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      INSURANCE_RECORDED: 1,
    });
  });

  test('says what is wrong at the field, in Persian, without sending anything', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    await page.goto(`/assets/${asset.id}`);
    await openAndFillPolicy(page, { number: 'ab', from: ymd(10), to: ymd(5) });

    await policyForm(page).getByRole('button', { name: 'ثبت بیمه‌نامه' }).click();
    await expect(page.getByText(/شمارهٔ بیمه‌نامه دست‌کم/)).toBeVisible();
    await expect(page.getByText('تاریخ پایان باید پس از تاریخ شروع باشد')).toBeVisible();
    // What was typed is still there.
    await expect(policyForm(page).getByLabel(/شرکت بیمه/)).toHaveValue('بیمه نمونه');
    await expect(page.getByText(NOTICES.policy)).toHaveCount(0);
    expect(await violationsOf(page)).toEqual([]);

    expect(await policiesOf(request, token, asset.id)).toHaveLength(0);
  });

  test('a policy that has already expired is refused in words, and nothing is recorded', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    await page.goto(`/assets/${asset.id}`);
    await openAndFillPolicy(page, {
      number: `E2E-EXP-${randomUUID().slice(0, 10)}`,
      from: ymd(-400),
      to: ymd(-30),
    });

    await policyForm(page).getByRole('button', { name: 'ثبت بیمه‌نامه' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: /تاریخ پایان این بیمه‌نامه گذشته/ }),
    ).toBeVisible();
    expect(await policiesOf(request, token, asset.id)).toHaveLength(0);
    expect(await timelineCounts(request, token, asset.id)).not.toHaveProperty('INSURANCE_RECORDED');
  });

  test('a person without the right to record is offered the lists and no forms, and the service refuses the writes anyway', async ({
    context,
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const number = `E2E-VIEW-${randomUUID().slice(0, 10)}`;
    const recorded = await request.post(gatewayUrl(`/v1/assets/${asset.id}/insurance-policies`), {
      headers: auth(token),
      data: {
        policyNumber: number,
        insurerName: 'بیمه نمونه',
        coverage: 'THIRD_PARTY',
        validFrom: new Date(Date.now() - DAY_MS).toISOString(),
        validTo: new Date(Date.now() + 300 * DAY_MS).toISOString(),
      },
    });
    expect(recorded.status()).toBe(201);

    const operator = (await installLiveSession(context, 'operator')).accessToken;
    await page.goto(`/assets/${asset.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(asset.name);
    await expect(page.getByText('ثبت بیمه‌نامه…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('ثبت معاینهٔ فنی…', { exact: true })).toHaveCount(0);

    // The page hiding the forms is UX. The service is the check.
    for (const [path, data] of [
      [
        'insurance-policies',
        {
          policyNumber: `E2E-DENY-${randomUUID().slice(0, 8)}`,
          insurerName: 'بیمه نمونه',
          coverage: 'THIRD_PARTY',
          validFrom: new Date(Date.now() - DAY_MS).toISOString(),
          validTo: new Date(Date.now() + 300 * DAY_MS).toISOString(),
        },
      ],
      [
        'inspections',
        {
          certificateNo: `E2E-DENY-${randomUUID().slice(0, 8)}`,
          inspectedAt: new Date(Date.now() - DAY_MS).toISOString(),
          validTo: new Date(Date.now() + 300 * DAY_MS).toISOString(),
          result: 'PASSED',
        },
      ],
    ] as const) {
      const refused = await request.post(gatewayUrl(`/v1/assets/${asset.id}/${path}`), {
        headers: auth(operator),
        data,
      });
      expect([path, refused.status()]).toEqual([path, 403]);
    }
    expect(await policiesOf(request, token, asset.id)).toHaveLength(1);
    expect(await inspectionsOf(request, token, asset.id)).toHaveLength(0);
  });
});

test.describe('another organization’s machine: records, through the portal and the live stack', () => {
  // Pure tenant-isolation checks with no layout in them: once, at desktop size.
  test.skip(({ isMobile }) => isMobile, 'identical at the phone’s size, and written once');

  test.afterEach(async ({ context, request }) => {
    const owner = (await installLiveSession(context, 'orgAdmin')).accessToken;
    await retireRegistered(request, owner);
  });

  test('is answered as a machine that does not exist, for both reads and both writes', async ({
    context,
    page,
    request,
  }) => {
    const owner = (await installLiveSession(context, 'orgAdmin')).accessToken;
    const asset = await registerMachine(request, owner);
    const missing = 'AST_01J00000000000000000000999';
    const other = (await installLiveSession(context, 'orgAdminB')).accessToken;

    // Something of the owner's own to protect.
    const number = `E2E-OWN-${randomUUID().slice(0, 10)}`;
    const recorded = await request.post(gatewayUrl(`/v1/assets/${asset.id}/insurance-policies`), {
      headers: auth(owner),
      data: {
        policyNumber: number,
        insurerName: 'بیمه نمونه',
        coverage: 'THIRD_PARTY',
        validFrom: new Date(Date.now() - DAY_MS).toISOString(),
        validTo: new Date(Date.now() + 300 * DAY_MS).toISOString(),
      },
    });
    expect(recorded.status()).toBe(201);

    // The page: the same words for a foreign id and a missing one, with nothing of
    // the owner's on it and no form.
    const mainText = async (id: string) => {
      await page.goto(`/assets/${id}`);
      await expect(page.getByText('این دارایی پیدا نشد').first()).toBeVisible();
      return (await page.locator('main').innerText()).trim();
    };
    const foreignPage = await mainText(asset.id);
    const missingPage = await mainText(missing);
    expect(foreignPage).toBe(missingPage);
    expect(foreignPage).not.toContain(number);
    expect(foreignPage).not.toContain(asset.name);
    await expect(page.getByText('ثبت بیمه‌نامه…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('ثبت معاینهٔ فنی…', { exact: true })).toHaveCount(0);

    // The two reads and the two writes, well-formed so the body is not what is
    // refused: a malformed one would answer 400 for any id and hide whether the
    // tenant boundary held. Each carries its own fresh key.
    const policyBody = {
      policyNumber: `E2E-X-${randomUUID().slice(0, 10)}`,
      insurerName: 'بیمه نمونه',
      coverage: 'THIRD_PARTY',
      validFrom: new Date(Date.now() - DAY_MS).toISOString(),
      validTo: new Date(Date.now() + 300 * DAY_MS).toISOString(),
    };
    const inspectionBody = {
      certificateNo: `E2E-X-${randomUUID().slice(0, 10)}`,
      inspectedAt: new Date(Date.now() - DAY_MS).toISOString(),
      validTo: new Date(Date.now() + 300 * DAY_MS).toISOString(),
      result: 'PASSED',
    };
    const answered = async (id: string, path: string, body: Record<string, unknown> | null) => {
      const url = gatewayUrl(`/v1/assets/${id}/${path}`);
      const response =
        body === null
          ? await request.get(url, { headers: auth(other) })
          : await request.post(url, { headers: auth(other), data: body });
      const json = (await response.json()) as { code?: string; message?: string };
      return { status: response.status(), code: json.code, message: json.message };
    };

    const CALLS: readonly [string, Record<string, unknown> | null][] = [
      ['insurance-policies', null],
      ['inspections', null],
      ['insurance-policies', policyBody],
      ['inspections', inspectionBody],
    ];
    for (const [path, body] of CALLS) {
      const foreign = await answered(asset.id, path, body);
      const nothing = await answered(missing, path, body);
      expect(foreign).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      // Byte for byte the answer for an id that does not exist.
      expect([path, body === null, foreign]).toEqual([path, body === null, nothing]);
    }

    // And nothing moved: asked of the owner's own token.
    const rows = await policiesOf(request, owner, asset.id);
    expect(rows.map((row) => row.policyNumber)).toEqual([number]);
    expect(await inspectionsOf(request, owner, asset.id)).toHaveLength(0);
    expect(await timelineCounts(request, owner, asset.id)).toMatchObject({
      INSURANCE_RECORDED: 1,
    });
    expect(await timelineCounts(request, owner, asset.id)).not.toHaveProperty(
      'INSPECTION_RECORDED',
    );
  });
});
