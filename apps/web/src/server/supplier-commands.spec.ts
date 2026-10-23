/**
 * @jest-environment node
 */
import { signPayload } from './signed-payload';
import {
  ALREADY_REGISTERED_MESSAGE,
  BUSINESS_RULE_MESSAGE,
  INVALID_INPUT_MESSAGE,
  STALE_MESSAGE,
} from '@/lib/supplier-commands';

import {
  approveQualification,
  canActAsSupplier,
  canDecideAbout,
  canRegisterSupplier,
  isOwnCase,
  offerableCapabilities,
  openSupplierBaseline,
  registerSupplier,
  rejectQualification,
  reinstateSupplier,
  sealSupplierBaseline,
  submitQualification,
  supplierActor,
  suspendSupplier,
  type SupplierActor,
} from './supplier-commands';
import type { WebSession } from './session';

/**
 * The supplier commands against a fake gateway: the path, the method and the
 * body of every call, that no `Idempotency-Key` is sent, how every way an answer
 * can come back is told, and who the forms are drawn for.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

function tokenOf(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
}

function tokenFor(organizationId: string | null, roles: string[], memberships?: string[]): string {
  return tokenOf({
    ...(organizationId === null
      ? {}
      : {
          org_id: organizationId,
          org_roles: roles.filter((r) => r !== 'SYSTEM_ADMIN').map((r) => `${organizationId}:${r}`),
        }),
    org_ids: memberships ?? (organizationId === null ? [] : [organizationId]),
    realm_access: { roles: roles.includes('SYSTEM_ADMIN') ? ['SYSTEM_ADMIN'] : [] },
  });
}

const session = (accessToken = 'access-token-value'): WebSession => ({
  subject: 'user-1',
  username: 'u',
  organizationId: 'ORG-A',
  accessToken,
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
});

const actorOf = (organizationId: string | null, roles: string[], memberships?: string[]) =>
  supplierActor(tokenFor(organizationId, roles, memberships)) as SupplierActor;

describe('who is offered which form', () => {
  const SUPPLIER_ORG = 'ORG-SUP';

  it.each([['ORGANIZATION_ADMIN'], ['SUPPLIER'], ['WORKSHOP'], ['CONTRACTOR']])(
    'a %s may register for its own organization and act as its supplier',
    (role) => {
      const actor = actorOf(SUPPLIER_ORG, [role]);
      expect(canRegisterSupplier(actor)).toBe(true);
      expect(canActAsSupplier(actor, SUPPLIER_ORG)).toBe(true);
      expect(canDecideAbout(actor, SUPPLIER_ORG)).toBe(false);
    },
  );

  it('refuses a supplier-side person on another organization’s supplier', () => {
    expect(canActAsSupplier(actorOf('ORG-OTHER', ['SUPPLIER']), SUPPLIER_ORG)).toBe(false);
  });

  it('has no registration for a token with no organization, and none for the platform roles or others', () => {
    expect(canRegisterSupplier(actorOf(null, ['SYSTEM_ADMIN']))).toBe(false);
    expect(canRegisterSupplier(actorOf('ORG-UNION', ['UNION_ADMIN']))).toBe(false);
    // The realm role adds to a membership role; it is not a supplier-side role.
    expect(canRegisterSupplier(actorOf('ORG-UNION', ['SYSTEM_ADMIN', 'FLEET_MANAGER']))).toBe(
      false,
    );
    expect(canRegisterSupplier(actorOf('ORG-A', ['FLEET_MANAGER']))).toBe(false);
    expect(canRegisterSupplier(actorOf('ORG-A', ['DRIVER']))).toBe(false);
  });

  it.each([['UNION_ADMIN'], ['SYSTEM_ADMIN']])(
    'a %s decides about another organization’s supplier and cannot submit for it',
    (role) => {
      const actor = actorOf(
        'ORG-UNION',
        role === 'SYSTEM_ADMIN' ? [role, 'FLEET_MANAGER'] : [role],
      );
      expect(canDecideAbout(actor, SUPPLIER_ORG)).toBe(true);
      expect(canActAsSupplier(actor, SUPPLIER_ORG)).toBe(false);
      expect(isOwnCase(actor, SUPPLIER_ORG)).toBe(false);
    },
  );

  it('lets a platform administrator with no organization decide, because no decision names a tenant', () => {
    expect(canDecideAbout(actorOf(null, ['SYSTEM_ADMIN']), SUPPLIER_ORG)).toBe(true);
  });

  it('refuses a decision to a platform operator who belongs to the supplier’s own organization', () => {
    const acting = actorOf(SUPPLIER_ORG, ['UNION_ADMIN']);
    expect(canDecideAbout(acting, SUPPLIER_ORG)).toBe(false);
    expect(isOwnCase(acting, SUPPLIER_ORG)).toBe(true);
  });

  it('judges self-decision on the whole membership set, not on the organization it acts for', () => {
    // Acting for the union, but also a member of the supplier's organization: the
    // service refuses (the D-2 bypass), so the form is not drawn.
    const actor = actorOf('ORG-UNION', ['UNION_ADMIN'], ['ORG-UNION', SUPPLIER_ORG]);
    expect(canDecideAbout(actor, SUPPLIER_ORG)).toBe(false);
    expect(isOwnCase(actor, SUPPLIER_ORG)).toBe(true);
  });

  it('refuses the oversight role whatever else it holds', () => {
    const auditor = actorOf(SUPPLIER_ORG, ['SUPPLIER', 'AUDITOR']);
    expect(canRegisterSupplier(auditor)).toBe(false);
    expect(canActAsSupplier(auditor, SUPPLIER_ORG)).toBe(false);
    const operator = actorOf('ORG-UNION', ['UNION_ADMIN', 'AUDITOR']);
    expect(canDecideAbout(operator, SUPPLIER_ORG)).toBe(false);
  });

  it('offers nothing for a token that cannot be read', () => {
    expect(supplierActor('not-a-jwt')).toBeNull();
    expect(supplierActor(tokenOf({ org_id: 'ORG-A', org_ids: [] }))).toBeNull();
  });
});

describe('the capabilities a submission may still be sent for', () => {
  it('blocks one awaiting a decision and one approved, and none that was rejected', () => {
    expect(offerableCapabilities([])).toEqual(['GOODS_SUPPLY', 'WORKSHOP_SERVICE', 'CONTRACTING']);
    expect(
      offerableCapabilities([
        { capability: 'GOODS_SUPPLY', state: 'SUBMITTED' },
        { capability: 'WORKSHOP_SERVICE', state: 'APPROVED' },
        { capability: 'CONTRACTING', state: 'REJECTED' },
      ]),
    ).toEqual(['CONTRACTING']);
  });
});

describe('the baseline', () => {
  const BASE = {
    supplierId: 'SUP_1',
    command: 'APPROVE_QUALIFICATION',
    qualificationId: 'QUA_1',
  } as const;

  it('opens for the session and command it was minted for, and carries the qualification', () => {
    const s = session();
    expect(openSupplierBaseline(s, sealSupplierBaseline(s, BASE), 'APPROVE_QUALIFICATION')).toEqual(
      BASE,
    );
  });

  it('does not open for another command, another login, a forgery or a token of another purpose', () => {
    const s = session();
    const token = sealSupplierBaseline(s, BASE);
    expect(openSupplierBaseline(s, token, 'REJECT_QUALIFICATION')).toBeNull();
    expect(
      openSupplierBaseline({ ...s, csrfToken: 'another-login' }, token, 'APPROVE_QUALIFICATION'),
    ).toBeNull();
    expect(openSupplierBaseline(s, `${token}x`, 'APPROVE_QUALIFICATION')).toBeNull();
    expect(openSupplierBaseline(s, undefined, 'APPROVE_QUALIFICATION')).toBeNull();
    const other = signPayload(s, 'asset-lifecycle-baseline', { ...BASE }, 60);
    expect(openSupplierBaseline(s, other, 'APPROVE_QUALIFICATION')).toBeNull();
  });

  it('is refused once its half hour has passed', () => {
    const s = session();
    const token = signPayload(s, 'supplier-baseline', { ...BASE }, -1);
    expect(openSupplierBaseline(s, token, 'APPROVE_QUALIFICATION')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function gateway(status: number, body: unknown, headers: Record<string, string> = {}) {
  const seen: Seen[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return { impl, seen };
}

const problem = (
  code: string,
  message: string,
  details?: { path: string; message: string; code?: string }[],
) => ({
  code,
  message,
  ...(details ? { details } : {}),
  correlationId: 'corr-1',
  timestamp: '2026-10-23T08:00:00.000Z',
});

const S = session();

describe('what is sent to the gateway', () => {
  const OK = { id: 'SUP_1' };

  const CALLS: readonly {
    name: string;
    path: string;
    body: unknown;
    run: (impl: typeof fetch) => Promise<{ kind: string }>;
  }[] = [
    {
      name: 'register',
      path: '/v1/suppliers',
      body: { displayName: 'تعمیرگاه', capabilities: ['GOODS_SUPPLY'] },
      run: (impl) =>
        registerSupplier(S, { displayName: 'تعمیرگاه', capabilities: ['GOODS_SUPPLY'] }, impl),
    },
    {
      name: 'submit a qualification',
      path: '/v1/suppliers/SUP_1/qualifications',
      body: { capability: 'GOODS_SUPPLY', evidence: [{ documentId: 'DOC_1' }] },
      run: (impl) =>
        submitQualification(
          S,
          'SUP_1',
          { capability: 'GOODS_SUPPLY', evidence: [{ documentId: 'DOC_1' }] },
          impl,
        ),
    },
    {
      name: 'approve',
      path: '/v1/suppliers/SUP_1/qualifications/QUA_1/approve',
      body: { note: 'خوب' },
      run: (impl) => approveQualification(S, 'SUP_1', 'QUA_1', { note: 'خوب' }, impl),
    },
    {
      name: 'reject',
      path: '/v1/suppliers/SUP_1/qualifications/QUA_1/reject',
      body: { reason: 'دلیل کافی نیست' },
      run: (impl) => rejectQualification(S, 'SUP_1', 'QUA_1', { reason: 'دلیل کافی نیست' }, impl),
    },
    {
      name: 'suspend',
      path: '/v1/suppliers/SUP_1/suspend',
      body: { reason: 'شکایت تکراری' },
      run: (impl) => suspendSupplier(S, 'SUP_1', { reason: 'شکایت تکراری' }, impl),
    },
    {
      name: 'reinstate',
      path: '/v1/suppliers/SUP_1/reinstate',
      body: { reason: 'شکایت برطرف شد' },
      run: (impl) => reinstateSupplier(S, 'SUP_1', { reason: 'شکایت برطرف شد' }, impl),
    },
  ];

  it.each(CALLS)(
    '$name: POSTs the body to $path with the bearer token and no Idempotency-Key',
    async (call) => {
      const { impl, seen } = gateway(200, OK);
      const result = await call.run(impl);
      expect(result.kind).toBe('CREATED');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(`http://gateway.test:3000${call.path}`);
      expect(seen[0]!.method).toBe('POST');
      expect(seen[0]!.body).toEqual(call.body);
      expect(seen[0]!.headers.get('authorization')).toBe('Bearer access-token-value');
      expect(seen[0]!.headers.has('idempotency-key')).toBe(false);
    },
  );

  it('encodes the supplier and qualification ids into the path', async () => {
    const { impl, seen } = gateway(200, OK);
    await approveQualification(S, '../x?y', 'a/b', {}, impl);
    expect(seen[0]!.url).toBe(
      'http://gateway.test:3000/v1/suppliers/..%2Fx%3Fy/qualifications/a%2Fb/approve',
    );
  });

  it.each(CALLS)(
    '$name: a 2xx that is not a supplier answer is unconfirmed, not saved',
    async (call) => {
      const { impl } = gateway(200, { unexpected: true });
      expect((await call.run(impl)).kind).toBe('UNKNOWN_OUTCOME');
    },
  );

  it.each(CALLS)(
    '$name: a 504 from the gateway is unconfirmed, a 503 and a 500 are unavailable',
    async (call) => {
      expect((await call.run(gateway(504, problem('UPSTREAM_TIMEOUT', 'slow')).impl)).kind).toBe(
        'UNKNOWN_OUTCOME',
      );
      expect(
        await call.run(gateway(503, problem('UPSTREAM_UNAVAILABLE', 'down')).impl),
      ).toMatchObject({ kind: 'UNAVAILABLE', status: 503 });
      expect(await call.run(gateway(500, problem('INTERNAL_ERROR', 'boom')).impl)).toMatchObject({
        kind: 'UNAVAILABLE',
        status: 500,
      });
    },
  );

  it.each(CALLS)('$name: a dropped connection is unconfirmed', async (call) => {
    const impl = (async () => {
      throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } });
    }) as typeof fetch;
    expect((await call.run(impl)).kind).toBe('UNKNOWN_OUTCOME');
  });

  it.each(CALLS)('$name: 403 and 404 are their own outcomes', async (call) => {
    expect((await call.run(gateway(403, problem('FORBIDDEN', 'no')).impl)).kind).toBe('FORBIDDEN');
    expect((await call.run(gateway(404, problem('NOT_FOUND', 'none')).impl)).kind).toBe(
      'NOT_FOUND',
    );
  });
});

describe('what the service says, in fixed Persian words', () => {
  const run = (status: number, body: unknown) =>
    registerSupplier(
      S,
      { displayName: 'x', capabilities: ['GOODS_SUPPLY'] },
      gateway(status, body).impl,
    );

  it('says a second registration (409 ALREADY_EXISTS) in its own words, never the service’s', async () => {
    const result = await run(409, problem('ALREADY_EXISTS', 'Supplier already exists'));
    expect(result).toMatchObject({ kind: 'INVALID', message: ALREADY_REGISTERED_MESSAGE });
    expect(JSON.stringify(result)).not.toContain('already exists');
  });

  it('puts a 400 on the field the service named, and never shows an unknown sentence', async () => {
    const result = await run(
      400,
      problem('VALIDATION_FAILED', 'Request validation failed', [
        { path: 'displayName', message: 'String must contain at least 2 character(s)' },
        { path: 'capabilities', message: 'A capability may be claimed only once' },
        { path: 'something.else', message: 'secret <b>text</b>' },
      ]),
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: {
        displayName: INVALID_INPUT_MESSAGE,
        capabilities: 'هر دسته را فقط یک بار بنویسید',
      },
      message: INVALID_INPUT_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('puts an evidence problem on the evidence field wherever in the list it is', async () => {
    const { impl } = gateway(
      400,
      problem('VALIDATION_FAILED', 'Request validation failed', [
        { path: 'evidence.3.documentId', message: 'Contains unsupported characters' },
        { path: 'evidence', message: 'The same document may be attached only once' },
      ]),
    );
    const result = await submitQualification(
      S,
      'SUP_1',
      { capability: 'GOODS_SUPPLY', evidence: [] },
      impl,
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { evidence: 'این فیلد نویسه کنترلی یا پنهان نمی‌پذیرد' },
      message: null,
    });
  });

  it.each([
    'A qualification for GOODS_SUPPLY is already awaiting a decision',
    'This supplier is already qualified for GOODS_SUPPLY',
    'A qualification for GOODS_SUPPLY already exists for this supplier',
    'Qualification QUA_1 was already approved and cannot be decided again',
    'Qualification QUA_1 was already rejected and cannot be decided again',
    'Qualification QUA_1 cannot move from APPROVED to REJECTED',
    'Qualification QUA_1 was decided by somebody else first',
    'Supplier SUP_1 is already suspended',
    'Supplier SUP_1 is not suspended',
    'Supplier SUP_1 was suspended by somebody else first',
    'Supplier SUP_1 was reinstated by somebody else first',
  ])('says the 422 rule “%s” as a stale record', async (sentence) => {
    const result = await run(422, problem('BUSINESS_RULE_VIOLATION', sentence));
    expect(result).toMatchObject({ kind: 'INVALID', message: STALE_MESSAGE });
  });

  it('says a 422 it does not know by its code, in fixed words', async () => {
    const result = await run(
      422,
      problem('BUSINESS_RULE_VIOLATION', 'A rule nobody wrote down yet'),
    );
    expect(result).toMatchObject({ kind: 'INVALID', message: BUSINESS_RULE_MESSAGE });
    expect(JSON.stringify(result)).not.toContain('nobody');
  });
});
