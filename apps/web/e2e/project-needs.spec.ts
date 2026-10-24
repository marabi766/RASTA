import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { installLiveSession } from './live-session';

/**
 * A project's needs, through the real stack: the portal, the real gateway, a
 * real construction-service on a real PostgreSQL, real tokens (EXP-004).
 *
 * ## The data
 *
 * Every test makes **its own project** (and needs) through the gateway as
 * `dehyari.admin` (ORG-DEH-0001, `ORGANIZATION_ADMIN`, who may write projects), with
 * a title unique to the run. A retry therefore runs against new state, and the
 * desktop and the Pixel 5 viewport — both run this file — never share a record.
 * Nothing compares a whole page that another test can change.
 *
 * ## What it proves that the unit specs cannot
 *
 * - the forms the page draws, for a person and a project status, are accepted by
 *   the real service, and each command lands on the real record (add, submit,
 *   withdraw — read back through the API);
 * - the page, with needs in two statuses and every disclosure open, has no WCAG 2.1
 *   AA violation and does not scroll sideways, on both viewports;
 * - tenant isolation: ORG-DEH-0002 reads nothing of ORG-DEH-0001's project or needs
 *   and changes nothing, through the portal and through the gateway directly.
 */

const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// Under CI the job sets the flag; a skip there would be a green job with no evidence.
if (process.env.CI && process.env.WEB_LIVE_STACK_E2E_EXP004 !== 'true') {
  test('CI runs the live project-need scenarios, none skipped', () => {
    throw new Error(
      'WEB_LIVE_STACK_E2E_EXP004 must be \'true\' in CI: the "Portal in a browser" job starts ' +
        'construction-service for these scenarios.',
    );
  });
}

function gatewayUrl(path: string): string {
  const base = process.env.API_GATEWAY_URL;
  if (!base) throw new Error('The live portal browser test requires API_GATEWAY_URL');
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function mainText(page: Page): Promise<string> {
  return (await page.locator('main').innerText()).trim();
}

async function violationsOf(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_2_1_AA).analyze();
  return violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
}

/** The page must not scroll sideways: on a phone that means something is wider than the screen. */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

interface Written {
  readonly id: string;
  readonly version: number;
}

async function call(
  request: APIRequestContext,
  token: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  expected: number,
  data?: unknown,
): Promise<unknown> {
  const response = await request.fetch(gatewayUrl(path), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'POST' && path.endsWith('/projects')
        ? { 'idempotency-key': `e2e-needs-${randomUUID()}` }
        : {}),
    },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.status(), `${method} ${path}: ${await response.text()}`).toBe(expected);
  return response.json();
}

async function createProject(
  request: APIRequestContext,
  token: string,
  title: string,
): Promise<Written> {
  return (await call(request, token, 'POST', '/v1/projects', 201, {
    title,
    operationType: 'road',
    scopeOfWork: 'E2E project needs fixture (EXP-004)',
    locationDescription: 'E2E',
    estimatedCostMinor: '1000000',
  })) as Written;
}

async function createNeed(
  request: APIRequestContext,
  token: string,
  projectId: string,
  title: string,
): Promise<Written> {
  return (await call(request, token, 'POST', `/v1/projects/${projectId}/needs`, 201, {
    title,
    description: 'شرح نیاز برای آزمون',
    quantity: '25.5',
    unit: 'متر مکعب',
  })) as Written;
}

interface NeedRecord {
  readonly id: string;
  readonly status: string;
  readonly version: number;
  readonly withdrawalReason: string | null;
}

async function needsOf(
  request: APIRequestContext,
  token: string,
  projectId: string,
): Promise<NeedRecord[]> {
  const page = (await call(request, token, 'GET', `/v1/projects/${projectId}/needs`, 200)) as {
    items: NeedRecord[];
  };
  return page.items;
}

test.describe('a project’s needs, live (EXP-004)', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E_EXP004 !== 'true',
    'needs construction-service alongside the usual live stack — set ' +
      'WEB_LIVE_STACK_E2E_EXP004=true locally after starting it (the "Portal in a browser" ' +
      'CI job always does)',
  );
  test.setTimeout(120_000);

  const RUN = randomUUID().slice(0, 8);

  test('the page with needs in two statuses and every form open has no axe violation and fits the screen', async ({
    page,
    request,
  }) => {
    const { accessToken } = await installLiveSession(page.context(), 'orgAdmin');
    const project = await createProject(request, accessToken, `پروژه نیازها ${RUN}-axe`);
    const draft = await createNeed(request, accessToken, project.id, `نیاز پیش‌نویس ${RUN}-axe`);
    const sent = await createNeed(request, accessToken, project.id, `نیاز ارسال‌شده ${RUN}-axe`);
    await call(
      request,
      accessToken,
      'POST',
      `/v1/projects/${project.id}/needs/${sent.id}/submit`,
      200,
      { expectedVersion: sent.version },
    );

    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const draftItem = page.getByRole('listitem').filter({ hasText: `نیاز پیش‌نویس ${RUN}-axe` });
    const sentItem = page.getByRole('listitem').filter({ hasText: `نیاز ارسال‌شده ${RUN}-axe` });
    await expect(draftItem).toBeVisible();
    await expect(sentItem).toBeVisible();
    expect(draft.id).not.toBe(sent.id);

    // A draft is edited, sent and withdrawn; a sent one only withdrawn.
    await expect(draftItem.getByRole('button', { name: /^ارسال «/ })).toBeVisible();
    await expect(draftItem.locator('summary')).toHaveCount(2);
    await expect(sentItem.getByRole('button', { name: /^ارسال «/ })).toHaveCount(0);
    await expect(sentItem.locator('summary')).toHaveCount(1);

    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    for (const summary of await page.locator('main summary').all()) await summary.click();
    expect(await violationsOf(page)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('a need is added, sent and withdrawn through the forms, and each lands on the real record', async ({
    page,
    request,
  }) => {
    const { accessToken } = await installLiveSession(page.context(), 'orgAdmin');
    const project = await createProject(request, accessToken, `پروژه نیازها ${RUN}-forms`);
    const title = `بتن آماده ${RUN}-forms`;
    const reason = `دیگر لازم نیست — ${RUN}`;

    await page.goto(`/projects/${project.id}`);
    await expect(page.getByText('برای این پروژه هنوز نیازی ثبت نشده است.')).toBeVisible();

    const add = page.locator('form').filter({
      has: page.getByRole('button', { name: 'افزودن نیاز', exact: true }),
    });
    await add.getByLabel('عنوان نیاز').fill(title);
    await add.getByLabel('شرح نیاز').fill('بتن با مقاومت بالا');
    await add.getByLabel('مقدار').fill('25.5');
    await add.getByLabel('واحد').fill('متر مکعب');
    await add.getByRole('button', { name: 'افزودن نیاز', exact: true }).click();

    await expect(page.getByText('نیاز به صورت پیش‌نویس ثبت شد.')).toBeVisible();
    const item = page.getByRole('listitem').filter({ hasText: title });
    await expect(item).toBeVisible();
    await expect(item.getByText('پیش‌نویس', { exact: true })).toBeVisible();

    const added = await needsOf(request, accessToken, project.id);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ status: 'DRAFT', version: 1 });

    await item.getByRole('button', { name: /^ارسال «/ }).click();
    await expect(page.getByText('نیاز به محدوده پروژه فرستاده شد.')).toBeVisible();
    await expect(item.getByText('ارسال‌شده', { exact: true })).toBeVisible();
    // Submitted: it is no longer edited, only withdrawn.
    await expect(item.getByRole('button', { name: /^ارسال «/ })).toHaveCount(0);
    expect((await needsOf(request, accessToken, project.id))[0]).toMatchObject({
      status: 'SUBMITTED',
    });

    await item.locator('summary').click();
    await item.getByLabel('دلیل پس‌گرفتن').fill(reason);
    await item.getByRole('button', { name: 'پس‌گرفتن نیاز', exact: true }).click();
    await expect(page.getByText('نیاز پس گرفته شد و دلیل آن در پرونده ماند.')).toBeVisible();
    await expect(item.getByText('پس‌گرفته', { exact: true })).toBeVisible();
    await expect(item.locator('summary')).toHaveCount(0);

    expect((await needsOf(request, accessToken, project.id))[0]).toMatchObject({
      status: 'WITHDRAWN',
      withdrawalReason: reason,
    });
  });

  test('ORG-DEH-0002 reads nothing of ORG-DEH-0001’s project or needs and changes nothing', async ({
    browser,
    request,
  }) => {
    const ownerContext = await browser.newContext();
    const owner = await installLiveSession(ownerContext, 'orgAdmin');
    await ownerContext.close();
    const title = `نیاز خصوصی ${RUN}-iso`;
    const project = await createProject(request, owner.accessToken, `پروژه نیازها ${RUN}-iso`);
    const need = await createNeed(request, owner.accessToken, project.id, title);

    // Through the portal, as the other organization's administrator.
    const otherContext = await browser.newContext();
    const other = await installLiveSession(otherContext, 'orgAdminB');
    const page = await otherContext.newPage();
    try {
      await page.goto(`/projects/${project.id}`);
      await expect(page.getByText('این پروژه پیدا نشد')).toBeVisible();
      expect(await mainText(page)).not.toContain(title);
      await expect(page.getByRole('button', { name: /ارسال «|افزودن نیاز/ })).toHaveCount(0);
    } finally {
      await otherContext.close();
    }

    // Through the gateway directly: the project and its needs are absent, not forbidden.
    await call(request, other.accessToken, 'GET', `/v1/projects/${project.id}/needs`, 404);
    await call(request, other.accessToken, 'POST', `/v1/projects/${project.id}/needs`, 404, {
      title: 'نیاز تزریق‌شده',
      description: 'شرح',
    });
    const base = `/v1/projects/${project.id}/needs/${need.id}`;
    await call(request, other.accessToken, 'PATCH', base, 404, {
      expectedVersion: need.version,
      title: 'تغییر از سازمان دیگر',
    });
    await call(request, other.accessToken, 'POST', `${base}/submit`, 404, {
      expectedVersion: need.version,
    });
    await call(request, other.accessToken, 'POST', `${base}/withdraw`, 404, {
      expectedVersion: need.version,
      reason: 'پس‌گرفتن از سازمان دیگر',
    });

    // Nothing moved: one need, still the owner's draft, at the version it had.
    const after = await needsOf(request, owner.accessToken, project.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: need.id, status: 'DRAFT', version: need.version });
  });
});
