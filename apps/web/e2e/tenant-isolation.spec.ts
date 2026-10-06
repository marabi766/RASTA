import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { installLiveSession, type LiveSession } from './live-session';

/**
 * Tenant isolation through the real stack, in a real browser, at desktop and at
 * phone size (AGENTS.md § 5: "Tenant isolation — for every service with tenant
 * data"; EXP-002's second acceptance criterion).
 *
 * Component and server tests already show the portal *renders* a refusal
 * correctly. What only the live stack can show is that the services *give* one:
 * a real token for organization A, a real gateway, and real tenant-scoped
 * databases that hold organization B's rows.
 *
 * ## The data
 *
 * The demo seeds are built for exactly this. ORG-DEH-0001 and ORG-DEH-0002 each
 * own a machine, a driver and a maintenance schedule; the seeds' own headers say
 * the other organization's rows "must be invisible" to this one.
 *
 * - `AST-SEED-0001..0003` (tags `D1-…`) belong to ORG-DEH-0001,
 *   `DRV-SEED-0001/0002`, and maintenance requests `MNT-SEED-0001/0002`.
 * - `AST-SEED-0004` (tag `D2-GRD-001`) and `DRV-SEED-0003` belong to ORG-DEH-0002,
 *   which has no maintenance *request* at all, so its list is empty.
 *
 * Every test runs in both directions where it can, so a check that only ever
 * looked from one side would not pass for the wrong reason.
 *
 * ## Non-disclosure
 *
 * The platform answers "not yours" and "not there" identically, so an id cannot
 * be used to learn what another organization owns. The key assertion is
 * therefore **equality**: the answer for another tenant's id is byte for byte
 * the answer for an id that does not exist, not merely "some error".
 */

/**
 * ORG-DEH-0001's completed repair order (maintenance seed), on its approved
 * request `MNT-SEED-0001`. ORG-DEH-0002 has no repair order at all.
 */
const OWN_REPAIR_ORDER = 'RPO-SEED-0001';
const MISSING_REPAIR_ORDER = 'RPO-SEED-9999';

/**
 * A well-formed body for every repair-order write. The service validates a body
 * before it looks at the order, so a malformed one would answer 400 for *any*
 * id and hide whether the tenant boundary held — the reason the asset write
 * above sends a well-formed edit.
 */
const REPAIR_ORDER_WRITES: readonly { verb: string; body: Record<string, string> }[] = [
  { verb: 'start', body: {} },
  { verb: 'complete', body: { workPerformed: 'تلاش از مستأجر دیگر' } },
  { verb: 'cancel', body: { reason: 'تلاش از مستأجر دیگر' } },
  {
    verb: 'parts',
    body: { partName: 'فیلتر روغن', quantity: '1', unit: 'عدد', unitCostMinor: '1000' },
  },
  { verb: 'labour', body: { description: 'تعویض شیلنگ', hours: '1', hourlyRateMinor: '1000' } },
  { verb: 'costs', body: { category: 'SERVICE', amountMinor: '1000', description: 'ایاب و ذهاب' } },
];

const OTHER_TENANT_ASSET = 'AST-SEED-0004';
const OTHER_TENANT_ASSET_TAG = 'D2-GRD-001';
const OWN_ASSET = 'AST-SEED-0001';
const OWN_ASSET_TAG = 'D1-TRK-001';
const MISSING_ID = 'AST-SEED-9999';
/** What the driver list renders for each driver (fleet-service's seed). */
const OWN_DRIVER_NUMBERS = ['OP-104', 'OP-108'] as const;
const OTHER_TENANT_DRIVER_NUMBER = 'OP-201';

test.describe('tenant isolation through the live stack', () => {
  test.skip(
    process.env.WEB_LIVE_STACK_E2E !== 'true',
    'needs the live stack the Portal in a browser job starts',
  );

  /** What the page says, without the chrome around it: the region a screen fills. */
  async function mainText(page: Page): Promise<string> {
    return (await page.locator('main').innerText()).trim();
  }

  function gatewayUrl(path: string): string {
    const base = process.env.API_GATEWAY_URL;
    if (!base) throw new Error('The live portal browser test requires API_GATEWAY_URL');
    return `${base.replace(/\/+$/, '')}${path}`;
  }

  async function assetName(
    request: APIRequestContext,
    token: string,
    id: string,
  ): Promise<{ status: number; name?: string }> {
    const response = await request.get(gatewayUrl(`/v1/assets/${id}`), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status() !== 200) return { status: response.status() };
    return { status: 200, name: ((await response.json()) as { name: string }).name };
  }

  test.describe('as ORG-DEH-0001', () => {
    let session: LiveSession;

    test.beforeEach(async ({ context }) => {
      session = await installLiveSession(context, 'orgAdmin');
    });

    test('the asset list holds its own machines and none of the other organization’s', async ({
      page,
    }) => {
      // The seeded machine is found by its tag, not by position: the list is one
      // page of twenty, ordered by id, and every browser scenario registers
      // machines of its own in this organization that sort ahead of the seeds
      // and are never deleted — so the seed's place on page one is not a fact.
      await page.goto(`/assets?q=${encodeURIComponent(OWN_ASSET_TAG)}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('ماشین‌آلات');
      expect(await mainText(page)).toContain(OWN_ASSET_TAG);

      // And the list itself, unfiltered, holds none of another tenant's.
      await page.goto('/assets');
      const text = await mainText(page);
      // Neither the other organization's tag nor the union's.
      expect(text).not.toContain(OTHER_TENANT_ASSET_TAG);
      expect(text).not.toContain('UN-WTR-001');
    });

    test('searching for the other organization’s tag finds nothing, and says nothing more', async ({
      page,
    }) => {
      await page.goto(`/assets?q=${encodeURIComponent(OTHER_TENANT_ASSET_TAG)}`);

      await expect(page.getByText('چیزی با این پالایش پیدا نشد')).toBeVisible();
      expect(await mainText(page)).not.toContain(OTHER_TENANT_ASSET_TAG);
    });

    test('another organization’s machine is answered exactly as a machine that does not exist', async ({
      page,
    }) => {
      await page.goto(`/assets/${OTHER_TENANT_ASSET}`);
      await expect(page.getByText('این دارایی پیدا نشد')).toBeVisible();
      const foreign = await mainText(page);

      await page.goto(`/assets/${MISSING_ID}`);
      await expect(page.getByText('این دارایی پیدا نشد')).toBeVisible();
      const missing = await mainText(page);

      // Equality, not "an error": an id must not be usable to probe what
      // another organization owns.
      expect(foreign).toBe(missing);
      expect(foreign).not.toContain(OTHER_TENANT_ASSET_TAG);
      expect(foreign).not.toContain(OTHER_TENANT_ASSET);
    });

    test('its own machine is shown, so the refusal above is not simply a broken page', async ({
      page,
    }) => {
      await page.goto(`/assets/${OWN_ASSET}`);
      await expect(page.getByText(OWN_ASSET_TAG).first()).toBeVisible();
      await expect(page.getByText('این دارایی پیدا نشد')).toHaveCount(0);
    });

    test('the other organization’s machine history is answered as a missing one', async ({
      page,
    }) => {
      await page.goto(`/assets/${OTHER_TENANT_ASSET}/timeline`);
      const foreign = await mainText(page);

      await page.goto(`/assets/${MISSING_ID}/timeline`);
      const missing = await mainText(page);

      expect(foreign).toBe(missing);
      expect(foreign).not.toContain(OTHER_TENANT_ASSET_TAG);
    });

    test('another organization’s driver is answered exactly as a driver that does not exist', async ({
      page,
    }) => {
      await page.goto('/drivers/DRV-SEED-0003');
      await expect(page.getByText('این راننده پیدا نشد')).toBeVisible();
      const foreign = await mainText(page);

      await page.goto('/drivers/DRV-SEED-9999');
      await expect(page.getByText('این راننده پیدا نشد')).toBeVisible();
      const missing = await mainText(page);

      expect(foreign).toBe(missing);
      expect(foreign).not.toContain('USR-SEED-DEHYARI2-ADMIN');
    });

    test('the driver list holds its own drivers and not the other organization’s', async ({
      page,
    }) => {
      await page.goto('/drivers');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('راننده و تخصیص');

      // The list shows each driver's employee number, not their user id, so an
      // absence of the other tenant's *user id* proves nothing: assert on what
      // is rendered. Both of this organization's drivers are there; the other
      // tenant's (seeded as OP-201) is not.
      const text = await mainText(page);
      expect(text).toContain(OWN_DRIVER_NUMBERS[0]);
      expect(text).toContain(OWN_DRIVER_NUMBERS[1]);
      expect(text).not.toContain(OTHER_TENANT_DRIVER_NUMBER);
      expect(text).not.toContain('USR-SEED-DEHYARI2-ADMIN');
    });

    test('a write to the other organization’s machine is refused and changes nothing', async ({
      request,
    }) => {
      // The token is this organization's own, from the same login the portal's
      // session holds; nothing here forges anything. It goes to the gateway, as
      // the portal's server would send it.
      const headers = {
        authorization: `Bearer ${session.accessToken}`,
        'content-type': 'application/json',
      };

      const edit = await request.patch(gatewayUrl(`/v1/assets/${OTHER_TENANT_ASSET}`), {
        headers,
        // A well-formed edit: since #158 a PATCH must carry expectedVersion, and
        // without it the gateway answers 400 for ANY id (no disclosure either
        // way) — which would hide whether the tenant boundary held. With it, the
        // request reaches the ownership check.
        data: { name: 'تغییر از مستأجر دیگر', expectedVersion: 1 },
      });
      // The same answer a machine that does not exist gets.
      expect(edit.status()).toBe(404);

      const status = await request.post(gatewayUrl(`/v1/assets/${OTHER_TENANT_ASSET}/status`), {
        headers,
        // Likewise since slice 5: every lifecycle command names its version.
        data: { status: 'OUT_OF_SERVICE', reason: 'تلاش از مستأجر دیگر', expectedVersion: 1 },
      });
      expect(status.status()).toBe(404);

      // And it really is untouched, asked of the owning tenant's own token in
      // the other describe below; here, asked with this one, it stays invisible.
      const read = await assetName(request, session.accessToken, OTHER_TENANT_ASSET);
      expect(read.status).toBe(404);
    });
  });

  test.describe('repair orders', () => {
    // Every repair-order write needs an Idempotency-Key at the gateway; each
    // call here is its own request, so each gets its own.
    const headers = (token: string) => ({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': `e2e-${randomUUID()}`,
    });

    test('ORG-DEH-0001’s own completed order is refused by its state, so the 404s below are the tenant boundary', async ({
      context,
      request,
    }) => {
      const session = await installLiveSession(context, 'orgAdmin');

      const cancel = await request.post(
        gatewayUrl(`/v1/repair-orders/${OWN_REPAIR_ORDER}/cancel`),
        {
          headers: headers(session.accessToken),
          data: { reason: 'تلاش برای لغو کار تمام‌شده' },
        },
      );
      expect(cancel.status()).toBe(409);

      const cost = await request.post(gatewayUrl(`/v1/repair-orders/${OWN_REPAIR_ORDER}/costs`), {
        headers: headers(session.accessToken),
        data: { category: 'SERVICE', amountMinor: '1000', description: 'ایاب و ذهاب' },
      });
      expect(cost.status()).toBe(422);

      const read = await request.get(gatewayUrl(`/v1/repair-orders/${OWN_REPAIR_ORDER}`), {
        headers: headers(session.accessToken),
      });
      expect(read.status()).toBe(200);
      expect(((await read.json()) as { status: string }).status).toBe('COMPLETED');
    });

    test('ORG-DEH-0002 can neither read nor write it, and is answered as for an order that does not exist', async ({
      context,
      request,
    }) => {
      const session = await installLiveSession(context, 'orgAdminB');

      const answered = async (id: string, verb: string | null, body: Record<string, string>) => {
        const response =
          verb === null
            ? await request.get(gatewayUrl(`/v1/repair-orders/${id}`), {
                headers: headers(session.accessToken),
              })
            : await request.post(gatewayUrl(`/v1/repair-orders/${id}/${verb}`), {
                headers: headers(session.accessToken),
                data: body,
              });
        const text = await response.json();
        return { status: response.status(), code: (text as { code?: string }).code };
      };

      for (const { verb, body } of [{ verb: null, body: {} }, ...REPAIR_ORDER_WRITES]) {
        const foreign = await answered(OWN_REPAIR_ORDER, verb, body);
        const missing = await answered(MISSING_REPAIR_ORDER, verb, body);
        expect(foreign).toEqual({ status: 404, code: 'NOT_FOUND' });
        expect(foreign).toEqual(missing);
      }

      // And nothing moved: asked of the owning tenant's own token.
      const owner = await installLiveSession(context, 'orgAdmin');
      const read = await request.get(gatewayUrl(`/v1/repair-orders/${OWN_REPAIR_ORDER}`), {
        headers: headers(owner.accessToken),
      });
      expect(read.status()).toBe(200);
      expect(((await read.json()) as { status: string }).status).toBe('COMPLETED');
    });
  });

  test.describe('as ORG-DEH-0002, the other tenant', () => {
    let session: LiveSession;

    test.beforeEach(async ({ context }) => {
      session = await installLiveSession(context, 'orgAdminB');
    });

    test('sees its own machine and not ORG-DEH-0001’s', async ({ page }) => {
      // By tag, not by position (see the same scenario for ORG-DEH-0001): this
      // organization's seeded machine is not always on the first page of twenty.
      await page.goto(`/assets?q=${encodeURIComponent(OTHER_TENANT_ASSET_TAG)}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('ماشین‌آلات');
      expect(await mainText(page)).toContain(OTHER_TENANT_ASSET_TAG);

      await page.goto('/assets');
      const text = await mainText(page);
      expect(text).not.toContain(OWN_ASSET_TAG);
      expect(text).not.toContain('D1-');
    });

    test('ORG-DEH-0001’s machine is answered as a missing one, from this side too', async ({
      page,
    }) => {
      await page.goto(`/assets/${OWN_ASSET}`);
      await expect(page.getByText('این دارایی پیدا نشد')).toBeVisible();
      const foreign = await mainText(page);

      await page.goto(`/assets/${MISSING_ID}`);
      const missing = await mainText(page);

      expect(foreign).toBe(missing);
      expect(foreign).not.toContain(OWN_ASSET_TAG);
    });

    test('has no maintenance requests, and ORG-DEH-0001’s are answered as missing ones', async ({
      page,
    }) => {
      await page.goto('/maintenance');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('نگهداری و تعمیرات');
      await expect(page.getByText('هیچ درخواست نگهداری‌ای ثبت نشده')).toBeVisible();

      await page.goto('/maintenance/MNT-SEED-0001');
      await expect(page.getByText('این درخواست پیدا نشد')).toBeVisible();
      const foreign = await mainText(page);

      await page.goto('/maintenance/MNT-SEED-9999');
      const missing = await mainText(page);
      expect(foreign).toBe(missing);
    });

    test('the driver list holds its own driver and not ORG-DEH-0001’s', async ({ page }) => {
      await page.goto('/drivers');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('راننده و تخصیص');

      const text = await mainText(page);
      expect(text).toContain(OTHER_TENANT_DRIVER_NUMBER);
      for (const number of OWN_DRIVER_NUMBERS) expect(text).not.toContain(number);
    });

    test('its machine is unchanged after ORG-DEH-0001 tried to write to it', async ({
      request,
    }) => {
      // Asserts what must be true at any time, so it does not depend on the
      // attempt above having run first: the machine is still there, still
      // serving, and still not renamed to the attacker's string.
      const after = await assetName(request, session.accessToken, OTHER_TENANT_ASSET);

      expect(after.status).toBe(200);
      expect(after.name).toEqual(expect.any(String));
      expect(after.name).not.toBe('تغییر از مستأجر دیگر');
    });
  });
});
