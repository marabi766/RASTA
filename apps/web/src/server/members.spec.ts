/**
 * @jest-environment node
 */
import {
  fetchMembers,
  memberName,
  parseRevokeMembershipForm,
  parseUpdateMemberRolesForm,
  revokeMembership,
  revokeMembershipFormValues,
  updateMemberRoles,
  updateMemberRolesFormValues,
} from './members';
import type { WebSession } from './session';

/**
 * Reading members, and parsing the two changes an administrator may make.
 *
 * The cases that matter here are the ones where a mistake is silent: a
 * checkbox group read with `get` instead of `getAll` (one role survives, the
 * rest vanish), a role the caller may not grant being dropped from the posted
 * set (the service then reads it as a removal), and a membership id that never
 * reaches the path.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'admin',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
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

function withFetch<T>(handler: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

interface Seen {
  url: string;
  method: string | undefined;
  body: unknown;
}

function answering(body: unknown, status = 200) {
  const seen: Seen[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: status === 204 ? {} : { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, seen };
}

const MEMBER = {
  id: 'USR_2',
  membershipId: 'MBR_2',
  username: 'colleague',
  firstName: 'همکار',
  lastName: 'نمونه',
  status: 'ACTIVE',
  roles: ['FLEET_MANAGER'],
};

// ---------------------------------------------------------------------------

describe('fetchMembers', () => {
  it('returns a page and asks for the tenant-scoped list endpoint', async () => {
    const { impl, seen } = answering({ items: [MEMBER], nextCursor: null, hasMore: false });

    const result = await withFetch(impl, () => fetchMembers(SESSION, { q: 'همکار' }));

    expect(result).toMatchObject({ kind: 'OK' });
    expect(seen[0]!.url).toContain('/v1/users?');
    expect(seen[0]!.url).toContain('q=');
  });

  it('keeps membershipId, which is what every row action needs', async () => {
    const { impl } = answering({ items: [MEMBER], nextCursor: null, hasMore: false });
    const result = await withFetch(impl, () => fetchMembers(SESSION));

    expect(result.kind === 'OK' && result.data.items[0]!.membershipId).toBe('MBR_2');
  });

  it('tolerates a row whose membership vanished, rather than refusing the page', async () => {
    const { impl } = answering({
      items: [{ ...MEMBER, membershipId: null }],
      nextCursor: null,
      hasMore: false,
    });
    const result = await withFetch(impl, () => fetchMembers(SESSION));

    expect(result.kind === 'OK' && result.data.items[0]!.membershipId).toBeNull();
  });

  it('renders a refusal as an outcome, not an exception', async () => {
    const { impl } = answering({ code: 'INSUFFICIENT_ROLE' }, 403);
    await expect(withFetch(impl, () => fetchMembers(SESSION))).resolves.toEqual({
      kind: 'FORBIDDEN',
    });
  });

  it('does not render a body it could not trust as data', async () => {
    const { impl } = answering({ items: [{ id: 5 }] });
    const result = await withFetch(impl, () => fetchMembers(SESSION));
    expect(result.kind).toBe('MALFORMED');
  });
});

describe('memberName', () => {
  it('prefers the full name', () => {
    expect(memberName(MEMBER)).toBe('همکار نمونه');
  });

  it('falls back to the username when no name is recorded', () => {
    expect(memberName({ ...MEMBER, firstName: '', lastName: '' })).toBe('colleague');
  });
});

// ---------------------------------------------------------------------------

describe('updateMemberRolesFormValues', () => {
  function form(entries: Array<[string, string]>): FormData {
    const data = new FormData();
    for (const [key, value] of entries) data.append(key, value);
    return data;
  }

  it('reads every checked role, not just the first', () => {
    // `get` would return only `FLEET_MANAGER` and silently drop the rest,
    // which the service then reads as a request to remove them.
    const values = updateMemberRolesFormValues(
      form([
        ['membershipId', 'MBR_2'],
        ['roles', 'FLEET_MANAGER'],
        ['roles', 'DRIVER'],
        ['roles', 'OPERATOR'],
        ['reason', 'تغییر مسئولیت'],
      ]),
    );

    expect(values.roles).toEqual(['FLEET_MANAGER', 'DRIVER', 'OPERATOR']);
  });

  it('reads an empty role set as empty rather than as a blank string', () => {
    const values = updateMemberRolesFormValues(
      form([
        ['membershipId', 'MBR_2'],
        ['reason', 'تغییر مسئولیت'],
      ]),
    );
    expect(values.roles).toEqual([]);
  });
});

describe('parseUpdateMemberRolesForm', () => {
  const base = { membershipId: 'MBR_2', roles: ['DRIVER'], reason: 'جابه‌جایی مسئولیت' };

  it('accepts a complete form', () => {
    expect(parseUpdateMemberRolesForm(base)).toMatchObject({ ok: true });
  });

  it('refuses an empty role set in Persian', () => {
    const parsed = parseUpdateMemberRolesForm({ ...base, roles: [] });
    expect(parsed).toMatchObject({
      ok: false,
      fieldErrors: { roles: 'دست‌کم یک نقش را انتخاب کنید' },
    });
  });

  it('refuses a missing reason, which the service requires too', () => {
    const parsed = parseUpdateMemberRolesForm({ ...base, reason: '' });
    expect(parsed).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
  });

  it('collapses a role posted twice', () => {
    const parsed = parseUpdateMemberRolesForm({ ...base, roles: ['DRIVER', 'DRIVER'] });
    expect(parsed).toMatchObject({ ok: true, request: { roles: ['DRIVER'] } });
  });

  it('refuses a form with no membership to act on', () => {
    const parsed = parseUpdateMemberRolesForm({ ...base, membershipId: '' });
    expect(parsed).toMatchObject({ ok: false, fieldErrors: { membershipId: expect.any(String) } });
  });
});

describe('updateMemberRoles', () => {
  it('puts the membership in the path and leaves it out of the body', async () => {
    const { impl, seen } = answering({ id: 'MBR_2' }, 200);

    await withFetch(impl, () =>
      updateMemberRoles(
        SESSION,
        { membershipId: 'MBR_2', roles: ['DRIVER'], reason: 'جابه‌جایی مسئولیت' },
        'sub_aaaaaaaaaaaaaaaaaaaa',
      ),
    );

    expect(seen[0]!.url).toContain('/v1/memberships/MBR_2/roles');
    expect(seen[0]!.body).toEqual({ roles: ['DRIVER'], reason: 'جابه‌جایی مسئولیت' });
  });

  it('reports the ladder refusal as FORBIDDEN, for the form to render', async () => {
    const { impl } = answering({ code: 'INSUFFICIENT_ROLE', message: 'no' }, 403);

    const result = await withFetch(impl, () =>
      updateMemberRoles(
        SESSION,
        { membershipId: 'MBR_2', roles: ['SYSTEM_ADMIN'], reason: 'تلاش' },
        'sub_aaaaaaaaaaaaaaaaaaaa',
      ),
    );

    expect(result.kind).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------

describe('revokeMembership', () => {
  it('parses a reason the service will accept', () => {
    expect(
      parseRevokeMembershipForm({ membershipId: 'MBR_2', reason: 'پایان همکاری' }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a reason too short to mean anything', () => {
    expect(parseRevokeMembershipForm({ membershipId: 'MBR_2', reason: 'x' })).toMatchObject({
      ok: false,
    });
  });

  it('reads the form', () => {
    const data = new FormData();
    data.set('membershipId', 'MBR_2');
    data.set('reason', 'پایان همکاری');
    expect(revokeMembershipFormValues(data)).toEqual({
      membershipId: 'MBR_2',
      reason: 'پایان همکاری',
    });
  });

  it('accepts the 204 the service actually answers with', async () => {
    // The endpoint is `@HttpCode(204)`. A schema expecting a body would fail
    // on the service doing exactly what its contract says.
    const { impl, seen } = answering(null, 204);

    const result = await withFetch(impl, () =>
      revokeMembership(
        SESSION,
        { membershipId: 'MBR_2', reason: 'پایان همکاری' },
        'sub_aaaaaaaaaaaaaaaaaaaa',
      ),
    );

    expect(result.kind).toBe('CREATED');
    expect(seen[0]!.url).toContain('/v1/memberships/MBR_2/revoke');
    expect(seen[0]!.body).toEqual({ reason: 'پایان همکاری' });
  });
});
