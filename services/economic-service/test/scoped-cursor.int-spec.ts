import request from 'supertest';
import type { Server } from 'node:http';
import { admin, apiTenant, startApi, type ApiHarness } from './api-helpers';
import { cleanup, id } from './helpers';
import { INVALID_CURSOR_MESSAGE } from '../src/shared/cursor';

/**
 * A list cursor is resolved inside the list it pages — never as a probe.
 *
 * Every cursor-paginated list in this service passed the cursor to Prisma as
 * `cursor: { id }`. Prisma finds the cursor row with a sub-select that neither
 * the list's `where` nor the tenant guard reaches, so any id in the table was
 * accepted as the ordering boundary: another organization's settlement as the
 * cursor returned the caller's own older rows, a non-existent id returned
 * none, and the difference told the caller whether that settlement existed —
 * a fact `GET /v1/settlements/{id}` deliberately hides behind identical 404s
 * (Codex review of web PR #249).
 *
 * Every list is held here to the same contract (shared/cursor.ts):
 *
 * - a cursor that is a row of **this** list (same tenant, same party filter,
 *   same view, same account) pages from it, with nothing skipped or repeated;
 * - one that does not exist, belongs to another organization, or is the
 *   caller's own row from the other view is refused with one and the same
 *   400 — compared field by field, not just by status, and never echoing the
 *   value sent.
 *
 * The lists: `GET /v1/settlements`, `GET /v1/transactions`,
 * `GET /v1/ledger/accounts/{id}/entries`, `GET /v1/commissions`,
 * `GET /v1/payment-intents`.
 */
describe('scoped list cursors', () => {
  let harness: ApiHarness;
  let http: Server;

  // A pays B three times and B pays A once, so each of them has both a paid
  // and a received side. C pays D, and none of that is A's or B's business.
  const a = apiTenant('CUR-A');
  const b = apiTenant('CUR-B');
  const c = apiTenant('CUR-C');
  const d = apiTenant('CUR-D');

  const as = (organizationId: string) => `Bearer ${admin(organizationId)}`;

  /** Plainly not an id anywhere: the "does not exist" probe. */
  const MISSING = 'NOT-A-ROW-OF-ANY-LIST';

  /** What every out-of-scope cursor must be answered with, exactly. */
  const REFUSAL = {
    status: 400,
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed',
    details: [{ path: 'cursor', message: INVALID_CURSOR_MESSAGE }],
  };

  interface Settled {
    transactionId: string;
    settlementId: string;
  }

  const paidByA: Settled[] = [];
  let paidByB: Settled;
  let paidByC: Settled;

  /** Tops a wallet up through the simulated provider — one payment intent each. */
  async function fund(organizationId: string, amountMinor: string): Promise<void> {
    const wallet = await request(http)
      .get('/v1/wallets/me')
      .set('authorization', as(organizationId))
      .expect(200);
    await request(http)
      .post(`/v1/wallets/${wallet.body.id}/top-up`)
      .set('authorization', as(organizationId))
      .set('idempotency-key', id('cursor-fund'))
      .send({ amountMinor })
      .expect(201);
  }

  /** hold → authorise → settle, through the real API. */
  async function settle(payer: string, payee: string, grossAmountMinor: string): Promise<Settled> {
    const created = await request(http)
      .post('/v1/transactions')
      .set('authorization', as(payer))
      .set('idempotency-key', id('cursor-txn'))
      .send({
        transactionType: 'MARKETPLACE_ORDER',
        counterpartyOrganizationId: payee,
        grossAmountMinor,
        currency: 'IRR',
        holdFunds: true,
      })
      .expect(201);
    await request(http)
      .post(`/v1/transactions/${created.body.id}/authorise-settlement`)
      .set('authorization', as(payer))
      .set('idempotency-key', id('cursor-auth'))
      .expect(200);
    const settled = await request(http)
      .post('/v1/settlements')
      .set('authorization', as(payer))
      .set('idempotency-key', id('cursor-settle'))
      .send({ transactionId: created.body.id })
      .expect(201);
    return { transactionId: created.body.id, settlementId: settled.body.settlementId };
  }

  function get(path: string, organizationId: string): request.Test {
    return request(http).get(path).set('authorization', as(organizationId));
  }

  /** `path` with `limit` and, when given, `cursor` appended. */
  function page(path: string, limit: number, cursor?: string): string {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return `${path}${path.includes('?') ? '&' : '?'}${query.toString()}`;
  }

  /**
   * The status and the whole body, minus the fields that differ per request
   * whatever the cause: correlation and trace ids, the timestamp, and `path`,
   * which is the request's own URL (cursor included) echoed back to its
   * sender. Any other field — one that varied with the cursor — stays in and
   * would break the comparison.
   */
  function refusalOf(response: request.Response) {
    const {
      correlationId: _correlationId,
      traceId: _traceId,
      timestamp: _timestamp,
      path: _path,
      ...rest
    } = response.body as Record<string, unknown>;
    return { status: response.status, ...rest };
  }

  /**
   * Asks `path` with each cursor and requires the one refusal for all of them —
   * so foreign, missing and other-view cannot be told apart from the answer.
   */
  async function expectIndistinguishable(
    path: string,
    organizationId: string,
    cursors: Record<string, string>,
  ): Promise<void> {
    for (const [label, cursor] of Object.entries(cursors)) {
      const response = await get(page(path, 5, cursor), organizationId);
      const refusal = refusalOf(response);
      expect({ label, ...refusal }).toEqual({ label, ...REFUSAL });
      // Nothing the service wrote reflects the value sent.
      expect(JSON.stringify(refusal)).not.toContain(cursor);
    }
  }

  /**
   * Walks `path` one row at a time, each page's cursor being the last row of
   * the one before, and returns the ids in order. `nextCursor` where the list
   * publishes one; otherwise the last id, as `apps/web` does for settlements.
   */
  async function walk(path: string, organizationId: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const response = await get(page(path, 1, cursor), organizationId).expect(200);
      const items = response.body.items as { id: string }[];
      if (items.length === 0) return ids;
      ids.push(...items.map((item) => item.id));
      if ('nextCursor' in response.body && response.body.nextCursor === null) return ids;
      cursor = (response.body.nextCursor as string | undefined) ?? items[items.length - 1]!.id;
    }
    throw new Error(`${path} did not end within 50 pages`);
  }

  async function allIds(path: string, organizationId: string): Promise<string[]> {
    const response = await get(page(path, 100), organizationId).expect(200);
    return (response.body.items as { id: string }[]).map((item) => item.id);
  }

  async function firstId(path: string, organizationId: string): Promise<string> {
    const ids = await allIds(path, organizationId);
    expect(ids.length).toBeGreaterThan(0);
    return ids[0]!;
  }

  beforeAll(async () => {
    harness = await startApi();
    http = harness.app.getHttpServer() as Server;

    // Two top-ups for A, so its payment intents page.
    await fund(a, '40000000');
    await fund(a, '40000000');
    await fund(b, '40000000');
    await fund(c, '40000000');
    // The payee needs a wallet before it can be paid into one.
    await get('/v1/wallets/me', d).expect(200);

    for (const amount of ['1100', '1200', '1300']) paidByA.push(await settle(a, b, amount));
    paidByB = await settle(b, a, '1400');
    paidByC = await settle(c, d, '1500');
  });

  afterAll(async () => {
    await cleanup(harness.prisma, [a, b, c, d]);
    await harness.close();
  });

  // -------------------------------------------------------------------------
  // GET /v1/settlements — the finding itself
  // -------------------------------------------------------------------------

  describe('GET /v1/settlements', () => {
    it.each([
      ['what A paid', '/v1/settlements', () => a, 3],
      ['what A was paid', '/v1/settlements?incoming=true', () => a, 1],
      ['what B was paid', '/v1/settlements?incoming=true', () => b, 3],
      ['what B paid', '/v1/settlements?incoming=false', () => b, 1],
    ])('pages %s by its own cursor, skipping and repeating nothing', async (_, path, who, n) => {
      const all = await allIds(path, who());
      expect(all).toHaveLength(n);
      await expect(walk(path, who())).resolves.toEqual(all);
    });

    it('resumes after the cursor row, not at it — the next page of the same view', async () => {
      const all = await allIds('/v1/settlements', a);
      const second = await get(page('/v1/settlements', 5, all[0]), a).expect(200);
      expect(second.body.items.map((row: { id: string }) => row.id)).toEqual(all.slice(1));

      // The last row as the cursor is the end of the list: an empty page, not a refusal.
      const end = await get(page('/v1/settlements', 5, all[all.length - 1]), a).expect(200);
      expect(end.body.items).toEqual([]);
    });

    it('answers a foreign, a missing and an other-view cursor identically — paid view', async () => {
      await expectIndistinguishable('/v1/settlements', a, {
        foreign: paidByC.settlementId,
        missing: MISSING,
        // A's own settlement, but one A received: not a row of "what A paid".
        otherView: paidByB.settlementId,
      });
    });

    it('answers a foreign, a missing and an other-view cursor identically — received view', async () => {
      await expectIndistinguishable('/v1/settlements?incoming=true', a, {
        foreign: paidByC.settlementId,
        missing: MISSING,
        otherView: paidByA[0]!.settlementId,
      });
    });

    it('gives the counterparty the cursor on its own side only', async () => {
      // B was paid S: S is a row of B's received view and of nothing else B lists.
      const s = paidByA[0]!.settlementId;
      await get(page('/v1/settlements?incoming=true', 5, s), b).expect(200);
      await expectIndistinguishable('/v1/settlements', b, { otherView: s, missing: MISSING });
    });

    it('tells a third organization nothing about settlements it was not party to', async () => {
      // Tenant isolation: C's answer for A's settlement is its answer for a
      // settlement that does not exist, in both views — and so is D's.
      for (const who of [c, d]) {
        for (const path of ['/v1/settlements', '/v1/settlements?incoming=true']) {
          await expectIndistinguishable(path, who, {
            foreign: paidByA[0]!.settlementId,
            foreignOtherSide: paidByB.settlementId,
            missing: MISSING,
          });
        }
      }
      // And the detail route agrees: one 404 for both.
      const foreign = await get(`/v1/settlements/${paidByA[0]!.settlementId}`, c).expect(404);
      const missing = await get(`/v1/settlements/${MISSING}`, c).expect(404);
      expect([foreign.body.code, foreign.body.message]).toEqual([
        missing.body.code,
        missing.body.message,
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // The other cursor-paginated lists — the same pattern, fixed the same way
  // -------------------------------------------------------------------------

  describe('GET /v1/transactions', () => {
    it('pages both views by their own cursors', async () => {
      for (const path of ['/v1/transactions', '/v1/transactions?includeIncoming=true']) {
        await expect(walk(path, a)).resolves.toEqual(await allIds(path, a));
      }
      expect(await allIds('/v1/transactions?includeIncoming=true', a)).toContain(
        paidByB.transactionId,
      );
    });

    it('answers a foreign, a missing and an other-view cursor identically', async () => {
      await expectIndistinguishable('/v1/transactions', a, {
        foreign: paidByC.transactionId,
        missing: MISSING,
        // A is the payee of this one: a row of its incoming view, not of "what A owes".
        otherView: paidByB.transactionId,
      });
      await expectIndistinguishable('/v1/transactions?includeIncoming=true', a, {
        foreign: paidByC.transactionId,
        missing: MISSING,
      });
    });

    it('judges the cursor by the party scope, not by the filters, which a row can leave', async () => {
      // A transaction's status moves while a client pages. A's own SETTLED row
      // is still a boundary of A's list under `status=CREATED`; refusing it
      // would break paging and protect nothing.
      await get(page('/v1/transactions?status=CREATED', 5, paidByA[0]!.transactionId), a).expect(
        200,
      );
    });

    it('tells a third organization nothing', async () => {
      for (const path of ['/v1/transactions', '/v1/transactions?includeIncoming=true']) {
        await expectIndistinguishable(path, c, {
          foreign: paidByA[0]!.transactionId,
          missing: MISSING,
        });
      }
    });
  });

  describe('GET /v1/ledger/accounts/{id}/entries', () => {
    async function accountOf(organizationId: string, purpose: 'WALLET' | 'ESCROW') {
      const accounts = await get('/v1/ledger/accounts', organizationId).expect(200);
      const account = (accounts.body.items as { id: string; purpose: string }[]).find(
        (row) => row.purpose === purpose,
      );
      expect(account).toBeDefined();
      return account!.id;
    }

    it('pages an account by a cursor from that account', async () => {
      const wallet = await accountOf(a, 'WALLET');
      const path = `/v1/ledger/accounts/${wallet}/entries`;
      const all = await allIds(path, a);
      expect(all.length).toBeGreaterThan(1);
      await expect(walk(path, a)).resolves.toEqual(all);
    });

    it('answers a foreign, a missing and another-account cursor identically', async () => {
      const wallet = await accountOf(a, 'WALLET');
      const escrow = await accountOf(a, 'ESCROW');
      const foreignWallet = await accountOf(c, 'WALLET');

      await expectIndistinguishable(`/v1/ledger/accounts/${wallet}/entries`, a, {
        foreign: await firstId(`/v1/ledger/accounts/${foreignWallet}/entries`, c),
        missing: MISSING,
        // A's own entry, on A's escrow account: not a row of this statement.
        otherAccount: await firstId(`/v1/ledger/accounts/${escrow}/entries`, a),
      });
    });

    it('refuses another organization the account before it looks at any cursor', async () => {
      const wallet = await accountOf(a, 'WALLET');
      const entry = await firstId(`/v1/ledger/accounts/${wallet}/entries`, a);
      // 404 for the account, with or without a cursor: the cursor adds nothing.
      const bare = await get(`/v1/ledger/accounts/${wallet}/entries`, c).expect(404);
      const withCursor = await get(page(`/v1/ledger/accounts/${wallet}/entries`, 5, entry), c);
      expect(refusalOf(withCursor)).toEqual(refusalOf(bare));
    });
  });

  describe('GET /v1/commissions', () => {
    // Commission is recorded against the payee: B has three, A and D one each.
    it('pages by its own cursor', async () => {
      const all = await allIds('/v1/commissions', b);
      expect(all).toHaveLength(3);
      await expect(walk('/v1/commissions', b)).resolves.toEqual(all);
    });

    it('answers a foreign and a missing cursor identically', async () => {
      await expectIndistinguishable('/v1/commissions', b, {
        foreign: await firstId('/v1/commissions', d),
        foreignCounterparty: await firstId('/v1/commissions', a),
        missing: MISSING,
      });
    });
  });

  describe('GET /v1/payment-intents', () => {
    it('pages by its own cursor', async () => {
      const all = await allIds('/v1/payment-intents', a);
      expect(all).toHaveLength(2);
      await expect(walk('/v1/payment-intents', a)).resolves.toEqual(all);
    });

    it('answers a foreign and a missing cursor identically', async () => {
      await expectIndistinguishable('/v1/payment-intents', a, {
        foreign: await firstId('/v1/payment-intents', c),
        missing: MISSING,
      });
    });
  });
});
