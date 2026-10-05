import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { installLiveSession } from './live-session';

/**
 * A machine's documents and its fleet availability on `/assets/[id]` in a real
 * browser, at desktop and at phone size (EXP-002, slice 7): attach a file, see
 * it listed; declare a machine available or not and withdraw the declaration;
 * see a block the platform imposes with its reason and no way to withdraw it;
 * send a form twice; and ask for another organization's machine.
 *
 * ## The file's path
 *
 * The browser hands the file to the portal's server, the server asks
 * document-service for a signed URL, puts the bytes in object storage, registers
 * the document and only then attaches the reference through asset-service
 * (`server/asset-documents.ts`). Every document scenario therefore needs
 * document-service **and** MinIO — started by the "Portal in a browser" job —
 * and asks both of them, through the gateway and with the same token, what they
 * now hold.
 *
 * ## Which machines, and why that is safe at both viewports
 *
 * As in `asset-records.spec.ts`: every test registers **its own** machine through
 * the API and works on that one alone, so the two Playwright projects can run
 * these scenarios at the same time on one stack. A machine cannot be deleted, so
 * `afterEach` decommissions exactly the ids the test registered.
 *
 * ## Fleet learns of a machine from an event
 *
 * fleet-service keeps a replica of every machine, filled by asset-service's
 * `ASSET_CREATED` (and, for a block, `INSPECTION_FAILED`). The portal shows
 * "not yet known to the fleet" until the replica has the row, so each scenario
 * waits for what it needs with `expect.poll` — on the service's answer, never on
 * a sleep.
 *
 * ## Whose machines, and the gateway's rate limits
 *
 * The scenarios act as the other tenant's administrator (`dehyari.admin.b`,
 * ORG-DEH-0002) as `asset-records.spec.ts` does, and sign in as `dehyari.admin`
 * only where a scenario needs ORG-DEH-0001 (the operator's machine, the foreign
 * tenant's, and the refusal scenario). The job sizes the per-person allowance for
 * the suite.
 *
 * **Documents have an allowance of their own** and it is small: docs/06 § 6.9
 * caps unsafe requests on `/v1/documents` at twenty an hour per person, and an
 * upload is two of them (the upload URL and the registration), so one person may
 * attach ten files an hour. The document scenarios are therefore spread over two
 * people and kept to what each needs to show: the one that sends a form twice
 * runs at desktop size only, and a refused file costs one request, not two.
 */

test.skip(
  process.env.WEB_LIVE_STACK_E2E !== 'true',
  'needs the live stack the Portal in a browser job starts',
);

const NAME_PREFIX = 'آزمون مرورگر - مدارک و ناوگان';
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

interface Dossier {
  documents: { id: string; documentId: string; kind: string; title: string }[];
}

interface Blocker {
  code: string;
  owner: string;
  detail: string;
  cause?: string;
}

interface MachineAvailability {
  assetId: string;
  available: boolean;
  blockers: Blocker[];
}

interface Window {
  id: string;
  assetId: string;
  available: boolean;
  reason: string;
  revokedAt: string | null;
}

const ids = (items: { id: string }[]): string[] => items.map((item) => item.id);

async function read(request: APIRequestContext, token: string, id: string): Promise<AssetRecord> {
  const response = await request.get(gatewayUrl(`/v1/assets/${id}`), { headers: auth(token) });
  expect(response.status()).toBe(200);
  return (await response.json()) as AssetRecord;
}

async function dossierOf(request: APIRequestContext, token: string, id: string): Promise<Dossier> {
  const response = await request.get(gatewayUrl(`/v1/assets/${id}/dossier`), {
    headers: auth(token),
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as Dossier;
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

async function availabilityOf(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<MachineAvailability | null> {
  const response = await request.get(gatewayUrl(`/v1/fleet/availability?assetId=${id}&limit=1`), {
    headers: auth(token),
  });
  expect(response.status()).toBe(200);
  const { items } = (await response.json()) as { items: MachineAvailability[] };
  return items[0] ?? null;
}

async function windowsOf(request: APIRequestContext, token: string, id: string): Promise<Window[]> {
  const response = await request.get(
    gatewayUrl(`/v1/fleet/availability/windows?assetId=${id}&limit=50`),
    { headers: auth(token) },
  );
  expect(response.status()).toBe(200);
  return ((await response.json()) as { items: Window[] }).items;
}

const registered = new Map<string, string>();

/** A machine of this test's own, registered — and waited for in fleet-service's replica. */
async function registerMachine(
  request: APIRequestContext,
  token: string,
  options: { awaitFleet?: boolean } = {},
): Promise<AssetRecord> {
  const suffix = randomUUID().slice(0, 8);
  const created = await request.post(gatewayUrl('/v1/assets'), {
    headers: auth(token),
    data: {
      name: `${NAME_PREFIX} ${suffix}`,
      type: 'LOADER',
      serialNumber: `E2E-DOC-${randomUUID().slice(0, 12)}`,
    },
  });
  expect(created.status()).toBe(201);
  const asset = (await created.json()) as AssetRecord;
  registered.set(asset.id, token);
  if (options.awaitFleet !== false) {
    await expect
      .poll(async () => (await availabilityOf(request, token, asset.id))?.assetId, {
        message: 'fleet-service has not received the machine',
        timeout: 60_000,
      })
      .toBe(asset.id);
  }
  return read(request, token, asset.id);
}

async function retireRegistered(request: APIRequestContext): Promise<void> {
  for (const [id, token] of registered) {
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

const ymd = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

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

/** What a PDF's first bytes look like: document-service reads the type from them, not from the name. */
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

const pdf = (name = 'title.pdf') => ({ name, mimeType: 'application/pdf', buffer: PDF_BYTES });

const NOTICES = {
  attached: 'مدرک بارگذاری و به دارایی پیوست شد.',
  declared: 'اعلام وضعیت ثبت شد.',
  revoked: 'اعلام باطل شد.',
};

const attachForm = (page: Page) => page.getByRole('form', { name: 'پیوست مدرک' });
const declareForm = (page: Page) => page.getByRole('form', { name: 'اعلام وضعیت دارایی' });
const documentItem = (page: Page, title: string) =>
  page.getByTestId('document-list').locator('li', { hasText: title });
const windowItems = (page: Page) => page.getByTestId('availability-windows').locator('li');

async function openAndFillAttach(
  page: Page,
  fields: {
    title: string;
    kind?: string;
    file: { name: string; mimeType: string; buffer: Buffer };
  },
): Promise<void> {
  await page.getByText('پیوست مدرک…', { exact: true }).click();
  const form = attachForm(page);
  await form.getByLabel(/نوع مدرک/).selectOption(fields.kind ?? 'OWNERSHIP_TITLE');
  await form.getByLabel(/عنوان/).fill(fields.title);
  await form.getByLabel(/تاریخ صدور/).fill(ymd(-30));
  await form.getByLabel(/تاریخ انقضا/).fill(ymd(400));
  await form.getByLabel(/^فایل/).setInputFiles(fields.file);
}

async function openAndFillDeclare(
  page: Page,
  fields: { available: 'true' | 'false'; reason: string; from?: string; to?: string },
): Promise<void> {
  await page.getByText('اعلام وضعیت دارایی…', { exact: true }).click();
  const form = declareForm(page);
  await form.getByLabel(/وضعیت اعلام‌شده/).selectOption(fields.available);
  await form.getByLabel(/دلیل/).fill(fields.reason);
  if (fields.from) await form.getByLabel(/از تاریخ/).fill(fields.from);
  if (fields.to) await form.getByLabel(/تا تاریخ/).fill(fields.to);
}

test.describe('a machine’s documents, through the portal and the live stack', () => {
  let token: string;

  test.beforeEach(async ({ context }) => {
    token = (await installLiveSession(context, 'orgAdminB')).accessToken;
  });

  test.afterEach(async ({ request }) => {
    await retireRegistered(request);
  });

  test('attaches a file: it is stored, registered with document-service, referenced on the machine and listed', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token, { awaitFleet: false });
    const title = `سند مالکیت ${randomUUID().slice(0, 6)}`;

    await page.goto(`/assets/${asset.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(asset.name);
    await expect(page.getByText('مدرکی پیوست نشده')).toBeVisible();

    await openAndFillAttach(page, { title, file: pdf('ownership.pdf') });

    // The form open on the page is itself accessible, at this viewport.
    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await attachForm(page).getByRole('button', { name: 'بارگذاری و پیوست' }).click();
    await expect(page.getByText(NOTICES.attached)).toBeVisible();

    const item = documentItem(page, title);
    await expect(item).toHaveCount(1);
    await expect(item.getByText('سند مالکیت', { exact: true })).toBeVisible();
    await expect(item).toHaveAttribute('data-validity', 'CURRENT');

    // What asset-service holds: one reference, to a document that exists.
    const dossier = await dossierOf(request, token, asset.id);
    expect(dossier.documents).toHaveLength(1);
    expect(dossier.documents[0]).toMatchObject({ title, kind: 'OWNERSHIP_TITLE' });
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      ASSET_DOCUMENT_ATTACHED: 1,
    });

    // What document-service holds: the file's metadata, tied to this machine,
    // with the name the browser sent and the type read from the bytes.
    const document = await request.get(
      gatewayUrl(`/v1/documents/${dossier.documents[0]!.documentId}`),
      { headers: auth(token) },
    );
    expect(document.status()).toBe(200);
    expect(await document.json()).toMatchObject({
      documentClass: 'OTHER',
      contentType: 'application/pdf',
      filename: 'ownership.pdf',
      sizeBytes: PDF_BYTES.length,
      ownerResourceType: 'Asset',
      ownerResourceId: asset.id,
      status: 'REGISTERED',
    });

    // After the redirect the page is a plain GET: reloading it attaches nothing.
    await page.reload();
    await expect(documentItem(page, title)).toHaveCount(1);
    expect((await dossierOf(request, token, asset.id)).documents).toHaveLength(1);

    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('says in words what document-service refuses — a type, a size — and attaches nothing', async ({
    context,
    page,
    request,
  }) => {
    // The other person, so the allowance of `/v1/documents` is not the first one's too.
    const token = (await installLiveSession(context, 'orgAdmin')).accessToken;
    const asset = await registerMachine(request, token, { awaitFleet: false });
    await page.goto(`/assets/${asset.id}`);

    // A type the class does not take. The portal holds no list of types: the
    // sentence is document-service's refusal, worded.
    await openAndFillAttach(page, {
      title: 'یادداشت متنی',
      file: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    });
    await attachForm(page).getByRole('button', { name: 'بارگذاری و پیوست' }).click();
    await expect(page.getByText(/این نوع فایل برای این نوع مدرک پذیرفته نمی‌شود/)).toBeVisible();
    // What was typed is still there, and the file must be chosen again.
    await expect(attachForm(page).getByLabel(/عنوان/)).toHaveValue('یادداشت متنی');
    expect(await violationsOf(page)).toEqual([]);

    // A size over the class's ceiling: the declared size is refused before a byte moves.
    await attachForm(page)
      .getByLabel(/^فایل/)
      .setInputFiles({
        name: 'big.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.concat([PDF_BYTES, Buffer.alloc(6 * 1024 * 1024)]),
      });
    await attachForm(page).getByRole('button', { name: 'بارگذاری و پیوست' }).click();
    await expect(page.getByText(/حجم فایل از حد مجاز این نوع مدرک بیشتر است/)).toBeVisible();

    // And an empty selection is said before anything is sent.
    await attachForm(page).getByRole('button', { name: 'بارگذاری و پیوست' }).click();
    await expect(page.getByText('فایل مدرک را انتخاب کنید')).toBeVisible();

    expect((await dossierOf(request, token, asset.id)).documents).toHaveLength(0);
    expect(await timelineCounts(request, token, asset.id)).not.toHaveProperty(
      'ASSET_DOCUMENT_ATTACHED',
    );
  });

  test('says what is wrong at the field, in Persian, before the file moves', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token, { awaitFleet: false });
    await page.goto(`/assets/${asset.id}`);
    await openAndFillAttach(page, { title: 'س', file: pdf() });

    await attachForm(page).getByRole('button', { name: 'بارگذاری و پیوست' }).click();
    await expect(page.getByText(/عنوان دست‌کم/)).toBeVisible();
    await expect(page.getByText(NOTICES.attached)).toHaveCount(0);
    expect((await dossierOf(request, token, asset.id)).documents).toHaveLength(0);
  });

  test('a form sent twice attaches once: a double click, and the same key through the gateway', async ({
    page,
    request,
    isMobile,
  }) => {
    // A double click can send twice, and each send is documents' scarce allowance.
    test.skip(isMobile, 'desktop only: a second viewport adds nothing but uploads');
    const asset = await registerMachine(request, token, { awaitFleet: false });
    const title = `سند دوباره ${randomUUID().slice(0, 6)}`;

    await page.goto(`/assets/${asset.id}`);
    await openAndFillAttach(page, { title, file: pdf('twice.pdf') });
    await attachForm(page).getByRole('button', { name: 'بارگذاری و پیوست' }).dblclick();

    // Whichever way the second press lands — a disabled button, or a second send
    // refused for its different document — the machine holds one reference.
    await expect
      .poll(async () => (await dossierOf(request, token, asset.id)).documents.length, {
        timeout: 30_000,
      })
      .toBe(1);
    await expect(documentItem(page, title)).toHaveCount(1);
    expect(await timelineCounts(request, token, asset.id)).toMatchObject({
      ASSET_DOCUMENT_ATTACHED: 1,
    });

    // The same submission, replayed, through the gateway.
    const key = `e2e-${randomUUID()}`;
    const body = {
      documentId: (await dossierOf(request, token, asset.id)).documents[0]!.documentId,
      kind: 'MANUAL',
      title: `دفترچه ${randomUUID().slice(0, 6)}`,
    };
    const send = (data: Record<string, unknown>) =>
      request.post(gatewayUrl(`/v1/assets/${asset.id}/documents`), {
        headers: auth(token, key),
        data,
      });
    const first = await send(body);
    expect(first.status()).toBe(201);
    const second = await send(body);
    // The second answer is the first one's, replayed: same status, same reference.
    expect(second.status()).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect((await dossierOf(request, token, asset.id)).documents).toHaveLength(2);

    // The same key with another body is refused, and attaches nothing.
    const reused = await send({ ...body, kind: 'PHOTO' });
    expect(reused.status()).toBe(409);
    expect(((await reused.json()) as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await dossierOf(request, token, asset.id)).documents).toHaveLength(2);

    // And a write with no key at all is refused: the service does not guess.
    const keyless = await request.post(gatewayUrl(`/v1/assets/${asset.id}/documents`), {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: body,
    });
    expect(keyless.status()).toBe(400);
    expect((await dossierOf(request, token, asset.id)).documents).toHaveLength(2);
  });

  test('a person without the right to attach is offered the list and no form, and the services refuse the writes anyway', async ({
    context,
    page,
    request,
  }) => {
    // The operator belongs to ORG-DEH-0001, so the machine must too.
    const owner = (await installLiveSession(context, 'orgAdmin')).accessToken;
    const asset = await registerMachine(request, owner, { awaitFleet: false });
    const operator = (await installLiveSession(context, 'operator')).accessToken;

    await page.goto(`/assets/${asset.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(asset.name);
    await expect(page.getByText('مدرکی پیوست نشده')).toBeVisible();
    await expect(page.getByText('پیوست مدرک…', { exact: true })).toHaveCount(0);

    // The page hiding the form is UX. The services are the check.
    const reference = await request.post(gatewayUrl(`/v1/assets/${asset.id}/documents`), {
      headers: auth(operator),
      data: { documentId: 'DOC_01J00000000000000000000000', kind: 'OTHER', title: 'مدرک ممنوع' },
    });
    expect(reference.status()).toBe(403);
    expect((await dossierOf(request, owner, asset.id)).documents).toHaveLength(0);
  });
});

test.describe('a machine’s availability, through the portal and the live stack', () => {
  let token: string;

  test.beforeEach(async ({ context }) => {
    token = (await installLiveSession(context, 'orgAdminB')).accessToken;
  });

  test.afterEach(async ({ request }) => {
    await retireRegistered(request);
  });

  test('declares a machine unavailable and withdraws the declaration', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const reason = `رزرو برای پروژه ${randomUUID().slice(0, 6)}`;

    await page.goto(`/assets/${asset.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(asset.name);
    await expect(page.getByText('اعلامی ثبت نشده')).toBeVisible();
    // A freshly registered machine is not ACTIVE, so the platform already says
    // it cannot be dispatched — and says whose fact that is.
    await expect(page.getByTestId('availability-blockers')).toBeVisible();

    await openAndFillDeclare(page, { available: 'false', reason, from: ymd(-1), to: ymd(10) });
    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await declareForm(page).getByRole('button', { name: 'ثبت اعلام' }).click();
    await expect(page.getByText(NOTICES.declared)).toBeVisible();

    const item = windowItems(page).filter({ hasText: reason });
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute('data-state', 'IN_FORCE');
    await expect(item.getByText('غیرقابل‌استفاده اعلام شده')).toBeVisible();
    // The declaration is one of the blockers now, marked as a fleet declaration.
    await expect(
      page.getByTestId('availability-blockers').locator('[data-imposed-by="DECLARATION"]'),
    ).toHaveCount(1);

    const rows = await windowsOf(request, token, asset.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ available: false, reason, revokedAt: null });

    // Withdraw it, from the control beside it.
    await item.getByRole('button', { name: 'ابطال این اعلام' }).click();
    await expect(page.getByText(NOTICES.revoked)).toBeVisible();

    const withdrawn = windowItems(page).filter({ hasText: reason });
    await expect(withdrawn).toHaveAttribute('data-state', 'REVOKED');
    await expect(withdrawn.getByRole('button', { name: 'ابطال این اعلام' })).toHaveCount(0);
    await expect(
      page.getByTestId('availability-blockers').locator('[data-imposed-by="DECLARATION"]'),
    ).toHaveCount(0);

    const after = await windowsOf(request, token, asset.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.revokedAt).not.toBeNull();

    // After the redirect the page is a plain GET: reloading it changes nothing.
    await page.reload();
    await expect(windowItems(page)).toHaveCount(1);
    expect(await windowsOf(request, token, asset.id)).toHaveLength(1);

    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('a new declaration replaces the last, and only the live one can be withdrawn', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const first = `نخستین ${randomUUID().slice(0, 6)}`;
    const second = `دومین ${randomUUID().slice(0, 6)}`;

    await page.goto(`/assets/${asset.id}`);
    await openAndFillDeclare(page, { available: 'false', reason: first });
    await declareForm(page).getByRole('button', { name: 'ثبت اعلام' }).click();
    await expect(page.getByText(NOTICES.declared)).toBeVisible();

    await openAndFillDeclare(page, { available: 'true', reason: second });
    await declareForm(page).getByRole('button', { name: 'ثبت اعلام' }).click();
    await expect(windowItems(page)).toHaveCount(2);

    // Newest first; the older was superseded, so it is withdrawn and offers no control.
    await expect(windowItems(page).first()).toContainText(second);
    await expect(windowItems(page).first()).toHaveAttribute('data-state', 'IN_FORCE');
    await expect(windowItems(page).nth(1)).toContainText(first);
    await expect(windowItems(page).nth(1)).toHaveAttribute('data-state', 'REVOKED');
    await expect(page.getByRole('button', { name: 'ابطال این اعلام' })).toHaveCount(1);
  });

  test('a declaration sent twice declares once: a double click, and the same key through the gateway', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);
    const reason = `دوبار ${randomUUID().slice(0, 6)}`;

    await page.goto(`/assets/${asset.id}`);
    await openAndFillDeclare(page, { available: 'false', reason });
    await declareForm(page).getByRole('button', { name: 'ثبت اعلام' }).dblclick();
    await expect(windowItems(page).filter({ hasText: reason })).toHaveCount(1);
    expect(await windowsOf(request, token, asset.id)).toHaveLength(1);

    // The same submission, replayed, through the gateway: an old declaration
    // retried must not undo a newer one.
    const key = `e2e-${randomUUID()}`;
    const body = {
      assetId: asset.id,
      available: false,
      reason: `ممنوعیت موقت ${randomUUID().slice(0, 6)}`,
    };
    const send = (data: Record<string, unknown>) =>
      request.post(gatewayUrl('/v1/fleet/availability'), { headers: auth(token, key), data });
    const old = await send(body);
    expect(old.status()).toBe(201);
    const newer = await request.post(gatewayUrl('/v1/fleet/availability'), {
      headers: auth(token),
      data: { assetId: asset.id, available: true, reason: 'آماده به کار' },
    });
    expect(newer.status()).toBe(201);

    const retried = await send(body);
    expect(retried.status()).toBe(201);
    // The retry is the first request's answer; it supersedes nothing.
    expect(((await retried.json()) as Window).id).toBe(((await old.json()) as Window).id);
    const live = (await windowsOf(request, token, asset.id)).filter(
      (row) => row.revokedAt === null,
    );
    expect(live.map((row) => row.id)).toEqual([((await newer.json()) as Window).id]);

    // The same key with another body is refused; and no key at all is refused.
    const reused = await send({ ...body, available: true });
    expect(reused.status()).toBe(409);
    expect(((await reused.json()) as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
    const keyless = await request.post(gatewayUrl('/v1/fleet/availability'), {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: body,
    });
    expect(keyless.status()).toBe(400);
  });

  test('a dispatch block the platform imposes is shown with its reason, and nothing withdraws it from the portal', async ({
    page,
    request,
  }) => {
    const asset = await registerMachine(request, token);

    // A failed inspection: asset-service publishes it, fleet-service blocks the machine.
    const recorded = await request.post(gatewayUrl(`/v1/assets/${asset.id}/inspections`), {
      headers: auth(token),
      data: {
        certificateNo: `E2E-BLK-${randomUUID().slice(0, 10)}`,
        inspectedAt: new Date(Date.now() - DAY_MS).toISOString(),
        validTo: new Date(Date.now() + 300 * DAY_MS).toISOString(),
        result: 'FAILED',
      },
    });
    expect(recorded.status()).toBe(201);
    await expect
      .poll(
        async () =>
          (await availabilityOf(request, token, asset.id))?.blockers.some(
            (blocker) => blocker.code === 'DISPATCH_BLOCKED' && blocker.cause === 'INSPECTION',
          ),
        { message: 'fleet-service has not applied the failed inspection', timeout: 60_000 },
      )
      .toBe(true);

    await page.goto(`/assets/${asset.id}`);
    const blockers = page.getByTestId('availability-blockers');
    const inspection = blockers
      .locator('[data-blocker="DISPATCH_BLOCKED"]')
      .filter({ hasText: 'آخرین معاینهٔ فنی مردود شده است' });
    await expect(inspection).toHaveCount(1);
    await expect(inspection).toHaveAttribute('data-imposed-by', 'PLATFORM');
    await expect(inspection).toContainText('از این صفحه برداشته نمی‌شود');
    await expect(inspection).toContainText('سامانهٔ دارایی');
    // The service's English sentence is never on the page.
    await expect(page.locator('main')).not.toContainText(
      'The most recent technical inspection failed',
    );

    // No declaration, so there is no window — and no control, though this person may declare.
    await expect(page.getByRole('button', { name: 'ابطال این اعلام' })).toHaveCount(0);

    // Declaring the machine available does not lift the block: the service says
    // so on the route, and the page shows it.
    await openAndFillDeclare(page, { available: 'true', reason: 'آماده به کار اعلام شد' });
    await declareForm(page).getByRole('button', { name: 'ثبت اعلام' }).click();
    await expect(page.getByText(NOTICES.declared)).toBeVisible();
    await expect(
      page
        .getByTestId('availability-blockers')
        .filter({ hasText: 'آخرین معاینهٔ فنی مردود شده است' }),
    ).toHaveCount(1);
    // The one control on the page belongs to the declaration, never to the block.
    await expect(page.getByRole('button', { name: 'ابطال این اعلام' })).toHaveCount(1);

    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('a person without the right to declare is offered the section and no forms, and the service refuses the writes anyway', async ({
    context,
    page,
    request,
  }) => {
    const owner = (await installLiveSession(context, 'orgAdmin')).accessToken;
    const asset = await registerMachine(request, owner);
    const declared = await request.post(gatewayUrl('/v1/fleet/availability'), {
      headers: auth(owner),
      data: { assetId: asset.id, available: false, reason: 'رزرو برای بازدید' },
    });
    expect(declared.status()).toBe(201);
    const window = (await declared.json()) as Window;

    const operator = (await installLiveSession(context, 'operator')).accessToken;
    await page.goto(`/assets/${asset.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(asset.name);
    await expect(windowItems(page)).toHaveCount(1);
    await expect(page.getByText('اعلام وضعیت دارایی…', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'ابطال این اعلام' })).toHaveCount(0);

    // The page hiding the controls is UX. The service is the check.
    const refusedDeclare = await request.post(gatewayUrl('/v1/fleet/availability'), {
      headers: auth(operator),
      data: { assetId: asset.id, available: true, reason: 'ممنوع برای اپراتور' },
    });
    expect(refusedDeclare.status()).toBe(403);
    const refusedRevoke = await request.post(
      gatewayUrl(`/v1/fleet/availability/${window.id}/revoke`),
      { headers: auth(operator) },
    );
    expect(refusedRevoke.status()).toBe(403);
    const rows = await windowsOf(request, owner, asset.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
  });
});

test.describe('another organization’s machine: documents and availability, through the portal and the live stack', () => {
  // Pure tenant-isolation checks with no layout in them: once, at desktop size.
  test.skip(({ isMobile }) => isMobile, 'identical at the phone’s size, and written once');

  test.afterEach(async ({ request }) => {
    await retireRegistered(request);
  });

  test('is answered as a machine that does not exist, for every read and every write', async ({
    context,
    page,
    request,
  }) => {
    const owner = (await installLiveSession(context, 'orgAdminB')).accessToken;
    const asset = await registerMachine(request, owner);
    const missing = 'AST_01J00000000000000000000999';
    const missingWindow = 'AVW_01J00000000000000000000999';
    const other = (await installLiveSession(context, 'orgAdmin')).accessToken;

    // Something of the owner's own to protect: a window, and a document reference.
    const declared = await request.post(gatewayUrl('/v1/fleet/availability'), {
      headers: auth(owner),
      data: { assetId: asset.id, available: false, reason: `رزرو ${randomUUID().slice(0, 6)}` },
    });
    expect(declared.status()).toBe(201);
    const window = (await declared.json()) as Window;
    const reference = await request.post(gatewayUrl(`/v1/assets/${asset.id}/documents`), {
      headers: auth(owner),
      data: { documentId: 'DOC_01J00000000000000000000001', kind: 'OTHER', title: 'مدرک مالک' },
    });
    expect(reference.status()).toBe(201);

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
    expect(foreignPage).not.toContain(asset.name);
    expect(foreignPage).not.toContain('مدرک مالک');
    await expect(page.getByText('پیوست مدرک…', { exact: true })).toHaveCount(0);
    await expect(page.getByText('اعلام وضعیت دارایی…', { exact: true })).toHaveCount(0);

    // Every read and write, well-formed so the body is not what is refused. Each
    // carries its own fresh key. The window id in a message is the one thing that
    // differs per request, so it is masked before the two answers are compared.
    const mask = (text: string | undefined, id: string) => text?.split(id).join('<id>');
    const answered = async (
      method: 'GET' | 'POST',
      path: string,
      body: Record<string, unknown> | null,
      id: string,
    ) => {
      const url = gatewayUrl(path);
      const response =
        method === 'GET'
          ? await request.get(url, { headers: auth(other) })
          : await request.post(url, { headers: auth(other), data: body ?? undefined });
      const json = (await response.json()) as { code?: string; message?: string };
      return { status: response.status(), code: json.code, message: mask(json.message, id) };
    };

    const attachBody = {
      documentId: 'DOC_01J00000000000000000000002',
      kind: 'OTHER',
      title: 'مدرک بیگانه',
    };
    const declareBody = (assetId: string) => ({ assetId, available: true, reason: 'اعلام بیگانه' });

    const CALLS: readonly [
      string,
      string,
      (id: string) => string,
      (id: string) => Record<string, unknown> | null,
    ][] = [
      ['GET', 'dossier', (id) => `/v1/assets/${id}/dossier`, () => null],
      [
        'GET',
        'windows',
        (id) => `/v1/fleet/availability/windows?assetId=${id}&limit=5`,
        () => null,
      ],
      ['POST', 'attach', (id) => `/v1/assets/${id}/documents`, () => attachBody],
      ['POST', 'declare', () => '/v1/fleet/availability', (id) => declareBody(id)],
    ];
    for (const [method, name, path, body] of CALLS) {
      const foreign = await answered(
        method as 'GET' | 'POST',
        path(asset.id),
        body(asset.id),
        asset.id,
      );
      const nothing = await answered(
        method as 'GET' | 'POST',
        path(missing),
        body(missing),
        missing,
      );
      expect([name, foreign]).toMatchObject([name, { status: 404, code: 'NOT_FOUND' }]);
      // Byte for byte the answer for an id that does not exist.
      expect([name, foreign]).toEqual([name, nothing]);
    }

    // Revoking another organization's window answers as a window that does not exist.
    const foreignRevoke = await answered(
      'POST',
      `/v1/fleet/availability/${window.id}/revoke`,
      null,
      window.id,
    );
    const missingRevoke = await answered(
      'POST',
      `/v1/fleet/availability/${missingWindow}/revoke`,
      null,
      missingWindow,
    );
    expect(foreignRevoke).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(foreignRevoke).toEqual(missingRevoke);

    // The composed read names no row for a machine that is not the caller's.
    const foreignAvailability = await request.get(
      gatewayUrl(`/v1/fleet/availability?assetId=${asset.id}&limit=1`),
      { headers: auth(other) },
    );
    const missingAvailability = await request.get(
      gatewayUrl(`/v1/fleet/availability?assetId=${missing}&limit=1`),
      { headers: auth(other) },
    );
    expect(foreignAvailability.status()).toBe(missingAvailability.status());
    expect(((await foreignAvailability.json()) as { items: unknown[] }).items).toEqual([]);

    // And nothing moved: asked of the owner's own token.
    expect(ids(await windowsOf(request, owner, asset.id))).toEqual([window.id]);
    expect((await windowsOf(request, owner, asset.id))[0]!.revokedAt).toBeNull();
    const dossier = await dossierOf(request, owner, asset.id);
    expect(dossier.documents.map((document) => document.title)).toEqual(['مدرک مالک']);
  });

  test('a document of another organization is answered as one that does not exist', async ({
    context,
    request,
  }) => {
    const owner = (await installLiveSession(context, 'orgAdminB')).accessToken;
    const asset = await registerMachine(request, owner, { awaitFleet: false });
    const other = (await installLiveSession(context, 'orgAdmin')).accessToken;

    // The owner registers a document through document-service directly.
    const intent = await request.post(gatewayUrl('/v1/documents/upload-url'), {
      headers: auth(owner),
      data: {
        documentClass: 'OTHER',
        contentType: 'application/pdf',
        sizeBytes: PDF_BYTES.length,
        filename: 'private.pdf',
      },
    });
    expect(intent.status()).toBe(201);
    const { uploadIntentId, uploadUrl } = (await intent.json()) as {
      uploadIntentId: string;
      uploadUrl: string;
    };
    const stored = await request.put(uploadUrl, {
      headers: { 'content-type': 'application/pdf' },
      data: PDF_BYTES,
    });
    expect(stored.ok()).toBe(true);
    const registered = await request.post(gatewayUrl('/v1/documents'), {
      headers: auth(owner),
      data: { uploadIntentId, ownerResourceType: 'Asset', ownerResourceId: asset.id },
    });
    expect(registered.status()).toBe(201);
    const { id } = (await registered.json()) as { id: string };

    const read = async (documentId: string) => {
      const response = await request.get(gatewayUrl(`/v1/documents/${documentId}`), {
        headers: auth(other),
      });
      const json = (await response.json()) as { code?: string; message?: string };
      return {
        status: response.status(),
        code: json.code,
        message: json.message?.split(documentId).join('<id>'),
      };
    };
    const foreign = await read(id);
    const nothing = await read('DOC_01J00000000000000000000999');
    expect(foreign).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(foreign).toEqual(nothing);
  });
});
