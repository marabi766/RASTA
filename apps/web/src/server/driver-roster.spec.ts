/**
 * @jest-environment node
 */
import {
  ROSTER_MAX_PAGES,
  ROSTER_PAGE_SIZE,
  canListMembers,
  loadDriverRoster,
} from './driver-roster';
import type { WebSession } from './session';

/**
 * Who the registration form offers (task 095): the members of this
 * organization who have no driver row here in any status, read whole from
 * identity-service's `GET /v1/users` and fleet-service's `GET /v1/drivers`
 * through the gateway — or no list at all. Never a list missing someone
 * because a page was not read.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'admin',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
};

const ENV = {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
};

beforeEach(() => {
  Object.assign(process.env, ENV);
});

interface Member {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  status: string;
}

const member = (n: number, extra: Partial<Member> = {}): Member => ({
  id: `USR_${n}`,
  username: `user.${n}`,
  firstName: 'عضو',
  lastName: `شماره ${n}`,
  status: 'ACTIVE',
  ...extra,
});

const driver = (userId: string, status = 'ACTIVE') => ({
  id: `DRV_${userId}`,
  userId,
  status,
});

type Pages = { items: unknown[] }[];

/**
 * A gateway holding `members` and `drivers` as pages, followed by cursor
 * (`P<n>`); `fail` answers one path with a status instead.
 */
function gateway(members: Pages, drivers: Pages, fail: Record<string, number> = {}) {
  const asked: URL[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url);
    const pages = url.pathname === '/v1/users' ? members : drivers;
    const index = Number((url.searchParams.get('cursor') ?? 'P0').slice(1));
    const failure = fail[`${url.pathname}#${index}`];
    if (failure) {
      return new Response(JSON.stringify({ code: 'X', message: 'x' }), {
        status: failure,
        headers: { 'content-type': 'application/json' },
      });
    }
    const page = pages[index]!;
    const hasMore = index < pages.length - 1;
    return new Response(
      JSON.stringify({
        items: page.items,
        nextCursor: hasMore ? `P${index + 1}` : null,
        hasMore,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { impl, asked };
}

async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe('who may be offered the member list', () => {
  it('is whoever identity-service lets list members: organization and union administrators', () => {
    expect(canListMembers(['ORGANIZATION_ADMIN'])).toBe(true);
    expect(canListMembers(['UNION_ADMIN'])).toBe(true);
    expect(canListMembers(['SYSTEM_ADMIN'])).toBe(true);
    expect(canListMembers(['FLEET_MANAGER'])).toBe(false);
    expect(canListMembers(['OPERATOR', 'DRIVER'])).toBe(false);
    expect(canListMembers(['AUDITOR', 'ORGANIZATION_ADMIN'])).toBe(false);
  });

  it('a fleet manager gets the id field, and nothing is read for them', async () => {
    const { impl, asked } = gateway([{ items: [member(1)] }], [{ items: [] }]);
    const roster = await withFetch(impl, () => loadDriverRoster(SESSION, ['FLEET_MANAGER']));
    expect(roster).toEqual({ kind: 'UNLISTED', reason: 'NOT_ALLOWED', names: null });
    expect(asked).toHaveLength(0);

    const unreadable = await withFetch(impl, () => loadDriverRoster(SESSION, null));
    expect(unreadable).toEqual({ kind: 'UNLISTED', reason: 'NOT_ALLOWED', names: null });
  });
});

describe('the roster of an administrator', () => {
  const ADMIN = ['ORGANIZATION_ADMIN'];

  it('reads every page of both lists and offers members with no driver row, in any status', async () => {
    const { impl, asked } = gateway(
      [
        { items: [member(1), member(2)] },
        // A page the identity filter emptied: more pages still follow.
        { items: [] },
        { items: [member(3), member(4), member(5), member(6, { status: 'SUSPENDED' })] },
      ],
      [
        { items: [driver('USR_1')] },
        { items: [driver('USR_3', 'SUSPENDED')] },
        { items: [driver('USR_4', 'DEACTIVATED')] },
      ],
    );
    const roster = await withFetch(impl, () => loadDriverRoster(SESSION, ADMIN));

    expect(roster.kind).toBe('LISTED');
    if (roster.kind !== 'LISTED') return;
    // USR_1, 3, 4 hold a driver row (any status); USR_6 is not an ACTIVE user.
    expect(roster.candidates.map((person) => person.userId)).toEqual(['USR_2', 'USR_5']);
    expect(roster.candidates[0]).toEqual({
      userId: 'USR_2',
      name: 'عضو شماره 2',
      username: 'user.2',
    });
    // Names cover every member, drivers included, for the list's name column.
    expect([...roster.names.keys()].sort()).toEqual(
      ['USR_1', 'USR_2', 'USR_3', 'USR_4', 'USR_5', 'USR_6'].sort(),
    );

    const users = asked.filter((url) => url.pathname === '/v1/users');
    const drivers = asked.filter((url) => url.pathname === '/v1/drivers');
    expect(users.map((url) => url.searchParams.get('cursor'))).toEqual([null, 'P1', 'P2']);
    expect(drivers.map((url) => url.searchParams.get('cursor'))).toEqual([null, 'P1', 'P2']);
    for (const url of [...users, ...drivers]) {
      expect(url.searchParams.get('limit')).toBe(String(ROSTER_PAGE_SIZE));
      // No filter: every member, every driver whatever its status.
      expect(url.searchParams.has('status')).toBe(false);
      expect(url.searchParams.has('q')).toBe(false);
      expect(url.searchParams.has('role')).toBe(false);
    }
  });

  it('orders the offer by name', async () => {
    const { impl } = gateway(
      [
        {
          items: [
            member(1, { firstName: 'یاسر', lastName: 'م' }),
            member(2, { firstName: 'آرش', lastName: 'ب' }),
            member(3, { firstName: '', lastName: '', username: 'zz.only' }),
          ],
        },
      ],
      [{ items: [] }],
    );
    const roster = await withFetch(impl, () => loadDriverRoster(SESSION, ADMIN));
    if (roster.kind !== 'LISTED') throw new Error(roster.kind);
    expect(roster.candidates.map((person) => person.name)).toEqual(['آرش ب', 'یاسر م', 'zz.only']);
  });

  it('is an empty offer — not a missing one — when every member already is a driver', async () => {
    const { impl } = gateway(
      [{ items: [member(1)] }, { items: [member(2)] }],
      [{ items: [driver('USR_2')] }, { items: [driver('USR_1', 'DEACTIVATED')] }],
    );
    const roster = await withFetch(impl, () => loadDriverRoster(SESSION, ADMIN));
    expect(roster.kind).toBe('LISTED');
    if (roster.kind === 'LISTED') expect(roster.candidates).toEqual([]);
  });

  it.each([403, 404, 500, 503])(
    'gives no list when a member page answers %s, even after a good first page',
    async (status) => {
      const { impl } = gateway([{ items: [member(1)] }, { items: [member(2)] }], [{ items: [] }], {
        '/v1/users#1': status,
      });
      const roster = await withFetch(impl, () => loadDriverRoster(SESSION, ADMIN));
      expect(roster).toEqual({ kind: 'UNLISTED', reason: 'UNAVAILABLE', names: null });
    },
  );

  it('gives no list — but keeps the names — when a driver page cannot be read', async () => {
    const { impl } = gateway(
      [{ items: [member(1), member(2)] }],
      [{ items: [driver('USR_1')] }, { items: [] }],
      { '/v1/drivers#1': 503 },
    );
    const roster = await withFetch(impl, () => loadDriverRoster(SESSION, ADMIN));
    expect(roster.kind).toBe('UNLISTED');
    if (roster.kind !== 'UNLISTED') return;
    expect(roster.reason).toBe('UNAVAILABLE');
    // Offering USR_2 now could offer someone page 2 says is a driver; the names stand.
    expect([...(roster.names?.keys() ?? [])]).toEqual(['USR_1', 'USR_2']);
  });

  it(`gives up as INCOMPLETE past ${ROSTER_MAX_PAGES} pages rather than offer part of the list`, async () => {
    const many = Array.from({ length: ROSTER_MAX_PAGES + 1 }, (_, n) => ({ items: [member(n)] }));
    const { impl, asked } = gateway(many, [{ items: [] }]);
    const roster = await withFetch(impl, () => loadDriverRoster(SESSION, ADMIN));
    expect(roster).toEqual({ kind: 'UNLISTED', reason: 'INCOMPLETE', names: null });
    expect(asked.filter((url) => url.pathname === '/v1/users')).toHaveLength(ROSTER_MAX_PAGES);

    const manyDrivers = Array.from({ length: ROSTER_MAX_PAGES + 1 }, () => ({ items: [] }));
    const second = gateway([{ items: [member(1)] }], manyDrivers);
    const roster2 = await withFetch(second.impl, () => loadDriverRoster(SESSION, ADMIN));
    expect(roster2.kind).toBe('UNLISTED');
    if (roster2.kind === 'UNLISTED') expect(roster2.reason).toBe('INCOMPLETE');
  });

  it('treats "more pages" with no cursor to ask for them as incomplete', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ items: [member(1)], nextCursor: null, hasMore: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const roster = await withFetch(impl, () => loadDriverRoster(SESSION, ADMIN));
    expect(roster).toEqual({ kind: 'UNLISTED', reason: 'INCOMPLETE', names: null });
  });
});
