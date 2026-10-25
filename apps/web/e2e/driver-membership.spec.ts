import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import { NOT_A_MEMBER_TEXT } from '../src/lib/driver-fields';
import {
  installLiveSession,
  installProvisionedSession,
  liveAccessToken,
  type LivePersona,
  type LiveSession,
  type ProvisionedPerson,
} from './live-session';
import { provisionPerson } from './provisioned-people';
import { withContext } from '../src/lib/page-context';

/**
 * Registering a driver through the real stack (task 095): the portal, the real
 * gateway, a real fleet-service asking a real identity-service, real tokens.
 *
 * The demo run of 2026-10-24 registered OP-115 for `USR-DEMO-DRIVER-0115`, a
 * user that does not exist, through a form that asked for a raw id. Here:
 *
 * - **an organization administrator** (`dehyari.admin`, ORG-DEH-0001) picks a
 *   member by name and username; the picker holds this organization's members
 *   who are not drivers yet — not the other organization's, not the seeded
 *   drivers — and the registered member then leaves it and appears, named, in
 *   the list;
 * - **a fleet manager** (no right to list members) keeps the id field, and is
 *   refused in Persian, in the same words, for a member of ORG-DEH-0002 and for
 *   a user who does not exist — and fleet-service holds no row for either.
 *
 * Every person is provisioned per test, so a retry starts from people nobody
 * has registered yet (pre-review checklist 21).
 */

test.skip(
  process.env.WEB_LIVE_STACK_E2E !== 'true',
  'needs the live stack the Portal in a browser job starts',
);

const HOME = 'ORG-DEH-0001';
const OTHER = 'ORG-DEH-0002';
/** The seeded drivers of ORG-DEH-0001, by username (fleet-service seed). */
const SEEDED_DRIVERS = ['dehyari.admin', 'operator.one'];

const WCAG_2_1_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

function gatewayUrl(path: string): string {
  const base = process.env.API_GATEWAY_URL;
  if (!base) throw new Error('The live driver scenarios require API_GATEWAY_URL');
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** fleet-service's own answer, through the gateway as ORG-DEH-0001's administrator. */
async function driverRowsOf(userId: string): Promise<{ id: string; userId: string }[]> {
  const response = await fetch(gatewayUrl(`/v1/drivers?userId=${encodeURIComponent(userId)}`), {
    headers: { authorization: `Bearer ${await liveAccessToken('orgAdmin')}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: { id: string; userId: string }[] }).items;
}

async function as(
  browser: Browser,
  who: LivePersona | ProvisionedPerson,
): Promise<{ page: Page; session: LiveSession; close: () => Promise<void> }> {
  const context = await browser.newContext({ locale: 'fa-IR', timezoneId: 'Asia/Tehran' });
  const session =
    typeof who === 'string'
      ? await installLiveSession(context, who)
      : await installProvisionedSession(context, who);
  const page = await context.newPage();
  return { page, session, close: () => context.close() };
}

const person = async (label: string, organizationId: string, roles: string[]) =>
  provisionPerson(
    await liveAccessToken('systemAdmin'),
    `e2e.drv.${randomUUID().slice(0, 8)}.${label}`,
    organizationId,
    roles,
  );

test.describe('registering a driver needs a member of the organization (task 095)', () => {
  test.setTimeout(120_000);

  test('an administrator picks a member by name; the picker holds only members who are not drivers yet', async ({
    browser,
  }) => {
    const member = await person('member', HOME, ['OPERATOR']);
    const elsewhere = await person('elsewhere', OTHER, ['OPERATOR']);
    const employeeNo = `OP-E2E-${randomUUID().slice(0, 6)}`;

    const { page, session, close } = await as(browser, 'orgAdmin');
    try {
      await page.goto('/drivers');
      const form = page.locator('form', { has: page.getByRole('button', { name: 'ثبت راننده' }) });
      const picker = form.getByRole('combobox', { name: /عضو سازمان/ });
      await expect(picker).toBeVisible();
      // No id to type: the member is picked.
      await expect(form.locator('input[name="userId"]')).toHaveCount(0);

      const labels = await picker.locator('option').allTextContents();
      expect(labels.some((label) => label.endsWith(member.username))).toBe(true);
      expect(labels.some((label) => label.includes(elsewhere.username))).toBe(false);
      for (const seeded of SEEDED_DRIVERS) {
        expect(labels.some((label) => label.endsWith(`— ${seeded}`))).toBe(false);
      }
      const { violations } = await new AxeBuilder({ page }).withTags(WCAG_2_1_AA).analyze();
      expect(violations).toEqual([]);

      const option = labels.find((label) => label.endsWith(member.username))!;
      await picker.selectOption({ label: option });
      await form.locator('[name="employeeNo"]').fill(employeeNo);
      await form.getByRole('button', { name: 'ثبت راننده' }).click();
      // The driver's own page — no flag it never read (PR 405 review 2, F2).
      await page.waitForURL(/\/drivers\/DRV_[0-9A-Z]+$/);

      // fleet-service holds exactly one row for the member, in this organization.
      const rows = await driverRowsOf(member.userId);
      expect(rows).toHaveLength(1);
      expect(page.url()).toContain(`/drivers/${rows[0]!.id}`);

      // A registered member leaves the picker, and the list names them.
      await page.goto(withContext(session.context, `/drivers?q=${encodeURIComponent(employeeNo)}`));
      const after = await page
        .getByRole('combobox', { name: /عضو سازمان/ })
        .locator('option')
        .allTextContents();
      expect(after.some((label) => label.endsWith(member.username))).toBe(false);
      const row = page.getByRole('row', { name: new RegExp(employeeNo) });
      await expect(row).toContainText(member.username);
    } finally {
      await close();
    }
  });

  test('a fleet manager keeps the id field and is refused, in the same Persian words, for a member elsewhere and for nobody', async ({
    browser,
  }) => {
    const manager = await person('manager', HOME, ['FLEET_MANAGER']);
    const elsewhere = await person('elsewhere', OTHER, ['OPERATOR']);
    const nobody = 'USR_01JZZZZZZZZZZZZZZZZZZZZZZZ';

    const { page, close } = await as(browser, manager);
    try {
      await page.goto('/drivers');
      const form = page.locator('form', { has: page.getByRole('button', { name: 'ثبت راننده' }) });
      await expect(form.getByRole('combobox', { name: /عضو سازمان/ })).toHaveCount(0);
      const id = form.locator('input[name="userId"]');

      for (const userId of [elsewhere.userId, nobody]) {
        await id.fill(userId);
        await form.getByRole('button', { name: 'ثبت راننده' }).click();
        await expect(form.getByText(NOT_A_MEMBER_TEXT)).toBeVisible();
        await expect(page).toHaveURL(/\/drivers(\?.*)?$/);
        expect(await driverRowsOf(userId)).toEqual([]);
      }
      // Nothing in English, and nothing that tells the two apart.
      await expect(form).not.toContainText('not a member');
    } finally {
      await close();
    }
  });
});
