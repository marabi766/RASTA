/**
 * @jest-environment node
 */
import {
  DEMAND_INVALID_MESSAGE,
  DEMAND_REFUSAL_MESSAGES,
  KEY_REUSED_MESSAGE,
} from '@/lib/demand-commands';
import { actingAccessToken } from '@/test/session-token';

import { canUseDemands, provenUnwritten, submitDemand } from './demand-commands';
import { demandReplayWindowSeconds, demandStampTerms, mintDemandSubmission } from './demand-replay';
import {
  DEMAND_LIST_MAX_PAGES,
  fetchDemand,
  fetchDemandAggregation,
  fetchDemands,
} from './demands';
import type { WebSession } from './session';

/**
 * The demand reads and the submission against a fake gateway: what is asked,
 * the tenant wall (a record of another organization is never returned, whatever
 * the gateway answers), the cursor followed through empty pages, the key sent,
 * how refusals are said, and the signed deadline.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

const session = (organizationId = 'ORG-BUYER'): WebSession => ({
  subject: 'user-1',
  username: 'buyer',
  organizationId,
  accessToken: actingAccessToken(organizationId, ['PROCUREMENT_USER']),
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
});
const S = session();

const demand = (over: Record<string, unknown> = {}) => ({
  id: 'DMR_1',
  organizationId: 'ORG-BUYER',
  productId: 'PRD_01J00000000000000000000000',
  quantity: 12,
  status: 'SUBMITTED',
  aggregationId: 'AGG_1',
  note: null,
  submittedAt: '2026-11-01T08:00:00.000Z',
  withdrawnAt: null,
  withdrawReason: null,
  version: 1,
  ...over,
});

const aggregation = (over: Record<string, unknown> = {}) => ({
  id: 'AGG_1',
  organizationId: 'ORG-BUYER',
  productId: 'PRD_01J00000000000000000000000',
  status: 'OPEN',
  openedAt: '2026-11-01T08:00:00.000Z',
  closesAt: '2026-11-02T08:00:00.000Z',
  totalQuantity: 12,
  demandCount: 1,
  extensionCount: 0,
  setting: { windowHours: 24, minQuantity: 100, shortfallPolicy: 'EXTEND', settingVersion: null },
  closedAt: null,
  cancelledAt: null,
  cancelReason: null,
  rfqId: null,
  version: 1,
  ...over,
});

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

/** Answers each call with the next of `answers` (the last one repeats). */
function gateway(
  ...answers: { status: number; body: unknown; headers?: Record<string, string> }[]
) {
  const seen: Seen[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)]!;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  }) as typeof fetch;
  global.fetch = impl;
  return { impl, seen };
}

const ok = (body: unknown) => ({ status: 200, body });
const problem = (status: number, code: string, details?: object[]) => ({
  status,
  body: { code, message: 'English sentence nobody shows', details, correlationId: 'corr-1' },
});

describe('the list', () => {
  it('asks for this organization’s demands, a page at a time, filtered by status', async () => {
    const { seen } = gateway(ok({ items: [demand()], nextCursor: 'C2' }));
    const result = await fetchDemands(S, { status: 'SUBMITTED', cursor: 'C1' });
    expect(result).toEqual({ kind: 'OK', data: { items: [demand()], nextCursor: 'C2' } });
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe('/v1/demand-requests');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '20',
      status: 'SUBMITTED',
      cursor: 'C1',
    });
    expect(seen[0]!.headers.get('x-organization-id')).toBe('ORG-BUYER');
  });

  it('follows the cursor past empty pages and stops at the first page with demands', async () => {
    const { seen } = gateway(
      ok({ items: [], nextCursor: 'C2' }),
      ok({ items: [], nextCursor: 'C3' }),
      ok({ items: [demand()], nextCursor: null }),
    );
    expect(await fetchDemands(S)).toEqual({
      kind: 'OK',
      data: { items: [demand()], nextCursor: null },
    });
    expect(seen.map((call) => new URL(call.url).searchParams.get('cursor'))).toEqual([
      null,
      'C2',
      'C3',
    ]);
  });

  it('after the bounded number of empty pages it keeps the cursor: more may exist, never "none"', async () => {
    const { seen } = gateway(ok({ items: [], nextCursor: 'MORE' }));
    expect(await fetchDemands(S)).toEqual({
      kind: 'OK',
      data: { items: [], nextCursor: 'MORE' },
    });
    expect(seen).toHaveLength(DEMAND_LIST_MAX_PAGES);
  });

  it('a page holding another organization’s demand is refused whole — none of it is returned', async () => {
    gateway(
      ok({
        items: [demand(), demand({ id: 'DMR_X', organizationId: 'ORG-OTHER' })],
        nextCursor: null,
      }),
    );
    const result = await fetchDemands(S);
    expect(result.kind).toBe('MALFORMED');
    expect(JSON.stringify(result)).not.toContain('DMR_X');
  });

  it('a refusal stays a refusal (unknown), never an empty list', async () => {
    gateway(problem(403, 'INSUFFICIENT_ROLE'));
    expect(await fetchDemands(S)).toEqual({ kind: 'FORBIDDEN' });
  });

  it('a missing nextCursor is malformed, not the end of the list', async () => {
    gateway(ok({ items: [demand()] }));
    expect((await fetchDemands(S)).kind).toBe('MALFORMED');
  });

  it('a session with no organization reads nothing', async () => {
    const { seen } = gateway(ok({ items: [], nextCursor: null }));
    const none = { ...session(), organizationId: null, accessToken: actingAccessToken(null) };
    expect(await fetchDemands(none)).toEqual({ kind: 'NOT_FOUND' });
    expect(seen).toHaveLength(0);
  });
});

describe('one demand, and the aggregation it joined (tenant isolation)', () => {
  it('reads the demand and the aggregation it names', async () => {
    const { seen } = gateway(ok(demand()), ok(aggregation()));
    const read = await fetchDemand(S, 'DMR_1');
    expect(read).toEqual({ kind: 'OK', data: demand() });
    expect(await fetchDemandAggregation(S, demand())).toEqual({ kind: 'OK', data: aggregation() });
    expect(seen.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/demand-requests/DMR_1',
      '/v1/aggregations/AGG_1',
    ]);
  });

  it('another organization’s demand is absent — the service’s 404 …', async () => {
    gateway(problem(404, 'NOT_FOUND'));
    expect(await fetchDemand(S, 'DMR_OTHER')).toEqual({ kind: 'NOT_FOUND' });
  });

  it('… and the same if the gateway ever answered it: nothing of it is returned', async () => {
    gateway(ok(demand({ id: 'DMR_OTHER', organizationId: 'ORG-OTHER', note: 'secret' })));
    expect(await fetchDemand(S, 'DMR_OTHER')).toEqual({ kind: 'NOT_FOUND' });
  });

  it('an answer for another id than asked is absent too', async () => {
    gateway(ok(demand({ id: 'DMR_2' })));
    expect(await fetchDemand(S, 'DMR_1')).toEqual({ kind: 'NOT_FOUND' });
  });

  it('an aggregation of another organization, or another id than the demand names, is absent', async () => {
    gateway(ok(aggregation({ organizationId: 'ORG-OTHER' })));
    expect(await fetchDemandAggregation(S, demand())).toEqual({ kind: 'NOT_FOUND' });
    gateway(ok(aggregation({ id: 'AGG_2' })));
    expect(await fetchDemandAggregation(S, demand())).toEqual({ kind: 'NOT_FOUND' });
  });

  it('the same demand read by a session of another organization is absent', async () => {
    gateway(ok(demand()));
    expect(await fetchDemand(session('ORG-OTHER'), 'DMR_1')).toEqual({ kind: 'NOT_FOUND' });
  });

  it('a required nullable field left out is malformed, never defaulted', async () => {
    const rest: Record<string, unknown> = demand();
    delete rest.withdrawnAt;
    gateway(ok(rest));
    expect((await fetchDemand(S, 'DMR_1')).kind).toBe('MALFORMED');
  });

  it('escapes the id in the path', async () => {
    const { seen } = gateway(problem(404, 'NOT_FOUND'));
    await fetchDemand(S, '../aggregations/AGG_1');
    expect(new URL(seen[0]!.url).pathname).toBe('/v1/demand-requests/..%2Faggregations%2FAGG_1');
  });
});

describe('the submission', () => {
  const BODY = { productId: 'PRD_01J00000000000000000000000', quantity: 12 };

  it('posts the body with the submission id as the Idempotency-Key', async () => {
    const { impl, seen } = gateway({ status: 201, body: demand() });
    expect(await submitDemand(S, BODY, 'sub-key-0001', impl)).toMatchObject({
      kind: 'CREATED',
      data: { id: 'DMR_1' },
    });
    expect(seen[0]!.method).toBe('POST');
    expect(new URL(seen[0]!.url).pathname).toBe('/v1/demand-requests');
    expect(seen[0]!.body).toEqual(BODY);
    expect(seen[0]!.headers.get('idempotency-key')).toBe('sub-key-0001');
  });

  it.each(Object.entries(DEMAND_REFUSAL_MESSAGES))(
    'says the %s refusal in its own fixed words, never the service’s sentence',
    async (code, text) => {
      const { impl } = gateway(
        problem(422, 'BUSINESS_RULE_VIOLATION', [
          { path: 'Demand cannot be submitted', code, message: 'English' },
        ]),
      );
      expect(await submitDemand(S, BODY, 'sub-key-0001', impl)).toMatchObject({
        kind: 'INVALID',
        message: text,
      });
    },
  );

  it('says a reused key and an unknown refusal in fixed words', async () => {
    let { impl } = gateway(problem(409, 'IDEMPOTENCY_KEY_REUSED'));
    expect(await submitDemand(S, BODY, 'sub-key-0001', impl)).toMatchObject({
      kind: 'INVALID',
      message: KEY_REUSED_MESSAGE,
    });
    ({ impl } = gateway(problem(422, 'SOMETHING_NEW')));
    expect(await submitDemand(S, BODY, 'sub-key-0001', impl)).toMatchObject({
      kind: 'INVALID',
      message: DEMAND_INVALID_MESSAGE,
    });
  });

  it('only a 4xx with a documented code proves nothing was written', () => {
    expect(provenUnwritten(413, 'PAYLOAD_TOO_LARGE')).toBe(true);
    expect(provenUnwritten(409, 'IDEMPOTENCY_KEY_REUSED')).toBe(true);
    expect(provenUnwritten(413, undefined)).toBe(false);
    expect(provenUnwritten(418, 'MADE_UP')).toBe(false);
    expect(provenUnwritten(500, 'INTERNAL_ERROR')).toBe(false);
    expect(provenUnwritten(503, 'SERVICE_UNAVAILABLE')).toBe(false);
  });
});

describe('who is offered the demand screens', () => {
  const env = { WEB_PROCUREMENT_DEMAND_ROLES: ['PROCUREMENT_USER', 'ORGANIZATION_ADMIN'] };

  it.each([
    [['PROCUREMENT_USER']],
    [['ORGANIZATION_ADMIN']],
    [['FLEET_MANAGER', 'PROCUREMENT_USER']],
  ])('%j is offered them', (roles) => expect(canUseDemands(roles, env)).toBe(true));

  it.each([
    [['FLEET_MANAGER']],
    [['PROCUREMENT_USER', 'AUDITOR']],
    [['ORGANIZATION_ADMIN', 'SYSTEM_ADMIN']],
    [[]],
    [null],
  ])('%j is not', (roles) => expect(canUseDemands(roles, env)).toBe(false));
});

describe('the signed deadline of the form', () => {
  const env = {
    WEB_PROCUREMENT_IDEMPOTENCY_TTL_HOURS: 1,
    WEB_PROCUREMENT_REPLAY_MARGIN_SECONDS: 600,
  };
  const NOW = 1_900_000_000_000;

  it('is the mirrored retention less the margin, from when the form was drawn', () => {
    expect(demandReplayWindowSeconds(env)).toBe(3000);
    const { id, replay } = mintDemandSubmission(S, NOW, env);
    expect(demandStampTerms(S, replay, id, NOW + 3_000_000, env)).toEqual({
      issuedAt: NOW,
      deadline: NOW + 3_000_000,
      windowMs: 3_000_000,
      expired: false,
    });
    expect(demandStampTerms(S, replay, id, NOW + 3_000_001, env)?.expired).toBe(true);
  });

  it('a setting lowered later shortens it; one raised later never lengthens it', () => {
    const { id, replay } = mintDemandSubmission(S, NOW, env);
    const lower = { ...env, WEB_PROCUREMENT_REPLAY_MARGIN_SECONDS: 1200 };
    expect(demandStampTerms(S, replay, id, NOW, lower)?.deadline).toBe(NOW + 2_400_000);
    const higher = { ...env, WEB_PROCUREMENT_IDEMPOTENCY_TTL_HOURS: 24 };
    expect(demandStampTerms(S, replay, id, NOW, higher)?.deadline).toBe(NOW + 3_000_000);
  });

  it('is refused for another submission id, another login, or a forged token', () => {
    const { id, replay } = mintDemandSubmission(S, NOW, env);
    expect(demandStampTerms(S, replay, 'other-id', NOW, env)).toBeNull();
    expect(demandStampTerms({ ...S, subject: 'user-2' }, replay, id, NOW, env)).toBeNull();
    expect(demandStampTerms(S, `${replay}x`, id, NOW, env)).toBeNull();
    expect(demandStampTerms(S, undefined, id, NOW, env)).toBeNull();
  });
});
