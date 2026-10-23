/**
 * @jest-environment node
 */
import {
  BUSINESS_RULE_MESSAGE,
  INVALID_INPUT_MESSAGE,
  KEY_REUSED_MESSAGE,
  NO_APPLICABLE_STEP_MESSAGE,
  NO_POLICY_MESSAGE,
  OPERATION_TYPE_NOT_ALLOWED_MESSAGE,
  PROJECT_422_PATTERNS,
  STALE_MESSAGE,
  STATE_MESSAGE,
} from '@/lib/project-commands';

import {
  canWriteProjects,
  cancelProject,
  completeProject,
  createProject,
  editDigests,
  fieldDigest,
  grantApproval,
  mayDecide,
  offeredCommands,
  openProjectBaseline,
  rejectApproval,
  requestApproval,
  sealProjectBaseline,
  startProject,
  unchangedFields,
  updateProject,
  type ProjectBaseline,
} from './project-commands';
import { tokenAuthority } from './realm-roles';
import type { WebSession } from './session';
import { signPayload } from './signed-payload';

/**
 * The project commands against a fake gateway: the path, the method and the
 * body of every call, that only the create sends an `Idempotency-Key`, how every
 * way an answer can come back is told, who an authority's decision is drawn
 * for, and what the baseline carries.
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

function tokenFor(organizationId: string | null, roles: string[]): string {
  return tokenOf({
    ...(organizationId === null
      ? {}
      : {
          org_id: organizationId,
          org_roles: roles.filter((r) => r !== 'SYSTEM_ADMIN').map((r) => `${organizationId}:${r}`),
        }),
    org_ids: organizationId === null ? [] : [organizationId],
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

describe('who is drawn the project forms', () => {
  const SETTINGS = { WEB_PROJECT_ROLES: ['ORGANIZATION_ADMIN'] };
  const rolesOf = (organizationId: string | null, roles: string[]) => {
    const authority = tokenAuthority(tokenFor(organizationId, roles));
    return authority && authority.organizationId ? authority.roles : null;
  };

  it('draws them for a configured project role and for the platform administrator, acting for an organization', () => {
    expect(canWriteProjects(rolesOf('ORG-A', ['ORGANIZATION_ADMIN']), SETTINGS)).toBe(true);
    expect(canWriteProjects(rolesOf('ORG-A', ['SYSTEM_ADMIN', 'FLEET_MANAGER']), SETTINGS)).toBe(
      true,
    );
  });

  it('follows the configured set, not a fixed one', () => {
    const settings = { WEB_PROJECT_ROLES: ['ORGANIZATION_ADMIN', 'UNION_ADMIN'] };
    expect(canWriteProjects(rolesOf('ORG-A', ['UNION_ADMIN']), settings)).toBe(true);
    expect(canWriteProjects(rolesOf('ORG-A', ['UNION_ADMIN']), SETTINGS)).toBe(false);
  });

  it('draws them for no one else: another role, a reader, no organization, a token it cannot read', () => {
    expect(canWriteProjects(rolesOf('ORG-A', ['FLEET_MANAGER']), SETTINGS)).toBe(false);
    expect(canWriteProjects(rolesOf('ORG-A', ['CONTRACTOR']), SETTINGS)).toBe(false);
    expect(canWriteProjects(rolesOf(null, ['SYSTEM_ADMIN']), SETTINGS)).toBe(false);
    expect(canWriteProjects(null, SETTINGS)).toBe(false);
  });

  it('refuses the oversight role whatever else it holds', () => {
    expect(canWriteProjects(['ORGANIZATION_ADMIN', 'AUDITOR'], SETTINGS)).toBe(false);
    expect(canWriteProjects(['SYSTEM_ADMIN', 'AUDITOR'], SETTINGS)).toBe(false);
  });

  it('offers nothing to a person who may not write, whatever the status', () => {
    for (const status of ['DRAFT', 'APPROVED', 'IN_PROGRESS', 'PENDING_APPROVAL']) {
      expect(offeredCommands({ status, canWrite: false, policyClosed: false })).toEqual([]);
    }
  });

  it('offers what the status offers, and withholds the request — only — while the system is closed', () => {
    expect(offeredCommands({ status: 'DRAFT', canWrite: true, policyClosed: false })).toEqual([
      'edit',
      'requestApproval',
      'cancel',
    ]);
    expect(offeredCommands({ status: 'DRAFT', canWrite: true, policyClosed: true })).toEqual([
      'edit',
      'cancel',
    ]);
    expect(
      offeredCommands({ status: 'CHANGES_REQUESTED', canWrite: true, policyClosed: true }),
    ).toEqual(['edit', 'cancel']);
    // A closed approval policy changes nothing about starting or completing.
    expect(offeredCommands({ status: 'APPROVED', canWrite: true, policyClosed: true })).toEqual([
      'start',
      'cancel',
    ]);
    expect(offeredCommands({ status: 'IN_PROGRESS', canWrite: true, policyClosed: true })).toEqual([
      'complete',
    ]);
  });
});

const STEP = {
  status: 'PENDING',
  workflowKey: 'project.execution',
  authorityOrganizationId: 'ORG-COUNCIL',
  authorityRole: 'UNION_ADMIN',
};

describe('who is drawn an authority’s decision', () => {
  it('draws it for the organization and role the step names, on a pending project step', () => {
    expect(mayDecide(tokenFor('ORG-COUNCIL', ['UNION_ADMIN']), STEP)).toBe(true);
    expect(
      mayDecide(tokenFor('ORG-COUNCIL', ['UNION_ADMIN']), {
        ...STEP,
        workflowKey: 'project.completion',
      }),
    ).toBe(true);
  });

  it('draws it for no one else: another organization, another role, no organization', () => {
    expect(mayDecide(tokenFor('ORG-OTHER', ['UNION_ADMIN']), STEP)).toBe(false);
    expect(mayDecide(tokenFor('ORG-COUNCIL', ['ORGANIZATION_ADMIN']), STEP)).toBe(false);
    expect(mayDecide(tokenFor(null, ['UNION_ADMIN']), STEP)).toBe(false);
    expect(mayDecide('not-a-jwt', STEP)).toBe(false);
  });

  it('gives the platform administrator no bypass: only a step that names that role', () => {
    const admin = tokenFor('ORG-COUNCIL', ['SYSTEM_ADMIN', 'ORGANIZATION_ADMIN']);
    expect(mayDecide(admin, STEP)).toBe(false);
    expect(mayDecide(admin, { ...STEP, authorityRole: 'SYSTEM_ADMIN' })).toBe(true);
  });

  it('draws nothing on a step that is not pending, and nothing on a tender’s step', () => {
    for (const status of ['QUEUED', 'GRANTED', 'REJECTED', 'SUPERSEDED']) {
      expect(mayDecide(tokenFor('ORG-COUNCIL', ['UNION_ADMIN']), { ...STEP, status })).toBe(false);
    }
    for (const workflowKey of ['tender.publication', 'tender.award', 'tender.cancellation']) {
      expect(mayDecide(tokenFor('ORG-COUNCIL', ['UNION_ADMIN']), { ...STEP, workflowKey })).toBe(
        false,
      );
    }
  });

  it('refuses the oversight role whatever else it holds', () => {
    expect(mayDecide(tokenFor('ORG-COUNCIL', ['UNION_ADMIN', 'AUDITOR']), STEP)).toBe(false);
  });
});

describe('the baseline', () => {
  const BASE: ProjectBaseline = {
    targetId: 'PRJ_1',
    projectId: 'PRJ_1',
    command: 'cancel',
    version: 4,
    status: 'DRAFT',
    digests: null,
  };

  it('opens for the session and command it was minted for, and carries the version', () => {
    const s = session();
    expect(openProjectBaseline(s, sealProjectBaseline(s, BASE), 'cancel')).toEqual(BASE);
  });

  it('does not open for another command, another login, a forgery or a token of another purpose', () => {
    const s = session();
    const token = sealProjectBaseline(s, BASE);
    expect(openProjectBaseline(s, token, 'start')).toBeNull();
    expect(openProjectBaseline({ ...s, csrfToken: 'another-login' }, token, 'cancel')).toBeNull();
    expect(openProjectBaseline(s, `${token}x`, 'cancel')).toBeNull();
    expect(openProjectBaseline(s, undefined, 'cancel')).toBeNull();
    expect(
      openProjectBaseline(s, signPayload(s, 'asset-lifecycle-baseline', { ...BASE }, 60), 'cancel'),
    ).toBeNull();
  });

  it('refuses a command it does not know, a version of zero and a status that is empty', () => {
    const s = session();
    for (const bad of [{ command: 'delete' }, { version: 0 }, { status: '' }]) {
      const token = signPayload(s, 'project-baseline', { ...BASE, ...bad }, 60);
      expect(openProjectBaseline(s, token, 'cancel')).toBeNull();
    }
  });

  it('is refused once its half hour has passed', () => {
    const s = session();
    const token = signPayload(s, 'project-baseline', { ...BASE }, -1);
    expect(openProjectBaseline(s, token, 'cancel')).toBeNull();
  });

  it('stays inside the signed-token limit with the largest scope of work the service takes', () => {
    const s = session();
    const values = {
      title: 'ع'.repeat(200),
      operationType: 'ع'.repeat(100),
      locationDescription: 'ع'.repeat(500),
      scopeOfWork: 'ع'.repeat(5000),
      estimatedCost: '9'.repeat(19),
    };
    const token = sealProjectBaseline(s, {
      ...BASE,
      command: 'edit',
      digests: editDigests(values),
    });
    expect(token.length).toBeLessThan(1200);
    expect(openProjectBaseline(s, token, 'edit')?.digests).toEqual(editDigests(values));
  });

  it('tells which fields still hold the value the page drew', () => {
    const s = session();
    const drawn = {
      title: 'الف',
      operationType: 'ب',
      locationDescription: 'پ',
      scopeOfWork: 'ت',
      estimatedCost: '',
    };
    const baseline = openProjectBaseline(
      s,
      sealProjectBaseline(s, { ...BASE, command: 'edit', digests: editDigests(drawn) }),
      'edit',
    )!;
    expect([...unchangedFields(baseline, { ...drawn, title: 'تغییر' })].sort()).toEqual([
      'estimatedCost',
      'locationDescription',
      'operationType',
      'scopeOfWork',
    ]);
    expect(unchangedFields({ ...baseline, digests: null }, drawn).size).toBe(0);
    expect(fieldDigest('a')).not.toBe(fieldDigest('b'));
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
const SUBMISSION = 'sub_0123456789abcdef0123456789abcdef0123456789';

describe('what is sent to the gateway', () => {
  const OK = { id: 'PRJ_1' };

  const CALLS: readonly {
    name: string;
    method: string;
    path: string;
    body: unknown;
    run: (impl: typeof fetch) => Promise<{ kind: string }>;
  }[] = [
    {
      name: 'edit',
      method: 'PATCH',
      path: '/v1/projects/PRJ_1',
      body: { title: 'عنوان تازه', estimatedCostMinor: null, expectedVersion: 3 },
      run: (impl) =>
        updateProject(S, 'PRJ_1', { title: 'عنوان تازه', estimatedCostMinor: null }, 3, impl),
    },
    {
      name: 'request approval',
      method: 'POST',
      path: '/v1/projects/PRJ_1/approvals',
      body: { expectedVersion: 3 },
      run: (impl) => requestApproval(S, 'PRJ_1', 3, impl),
    },
    {
      name: 'start',
      method: 'POST',
      path: '/v1/projects/PRJ_1/start',
      body: { expectedVersion: 3 },
      run: (impl) => startProject(S, 'PRJ_1', 3, impl),
    },
    {
      name: 'complete',
      method: 'POST',
      path: '/v1/projects/PRJ_1/complete',
      body: { expectedVersion: 3 },
      run: (impl) => completeProject(S, 'PRJ_1', 3, impl),
    },
    {
      name: 'cancel',
      method: 'POST',
      path: '/v1/projects/PRJ_1/cancel',
      body: { reason: 'بودجه تامین نشد', expectedVersion: 3 },
      run: (impl) => cancelProject(S, 'PRJ_1', { reason: 'بودجه تامین نشد' }, 3, impl),
    },
    {
      name: 'grant',
      method: 'POST',
      path: '/v1/approvals/APR_1/decision',
      body: { decisionNumber: '12', decision: 'GRANT', expectedVersion: 3 },
      run: (impl) => grantApproval(S, 'APR_1', { decisionNumber: '12' }, 3, impl),
    },
    {
      name: 'reject',
      method: 'POST',
      path: '/v1/approvals/APR_1/decision',
      body: { reason: 'برآورد نادرست است', decision: 'REJECT', expectedVersion: 3 },
      run: (impl) => rejectApproval(S, 'APR_1', { reason: 'برآورد نادرست است' }, 3, impl),
    },
  ];

  it.each(CALLS)(
    '$name: sends $method to $path with the version, the bearer token and no Idempotency-Key',
    async (call) => {
      const { impl, seen } = gateway(200, OK);
      expect((await call.run(impl)).kind).toBe('CREATED');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe(`http://gateway.test:3000${call.path}`);
      expect(seen[0]!.method).toBe(call.method);
      expect(seen[0]!.body).toEqual(call.body);
      expect(seen[0]!.headers.get('authorization')).toBe('Bearer access-token-value');
      expect(seen[0]!.headers.has('idempotency-key')).toBe(false);
    },
  );

  it('create: POSTs the body to /v1/projects with the submission id as the Idempotency-Key', async () => {
    const { impl, seen } = gateway(201, OK);
    const body = {
      title: 'پل',
      operationType: 'خاکبرداری',
      locationDescription: 'کیلومتر ۱۲',
      scopeOfWork: 'شرح',
      estimatedCostMinor: '1500000',
    };
    expect((await createProject(S, body, SUBMISSION, impl)).kind).toBe('CREATED');
    expect(seen[0]!.url).toBe('http://gateway.test:3000/v1/projects');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.body).toEqual(body);
    expect(seen[0]!.headers.get('idempotency-key')).toBe(SUBMISSION);
  });

  it('encodes the ids into the path', async () => {
    const { impl, seen } = gateway(200, OK);
    await startProject(S, '../x?y', 1, impl);
    expect(seen[0]!.url).toBe('http://gateway.test:3000/v1/projects/..%2Fx%3Fy/start');
    await grantApproval(S, 'a/b', {}, 1, impl);
    expect(seen[1]!.url).toBe('http://gateway.test:3000/v1/approvals/a%2Fb/decision');
  });

  it.each(CALLS)('$name: a 2xx that is not an answer is unconfirmed, not saved', async (call) => {
    expect((await call.run(gateway(200, { unexpected: true }).impl)).kind).toBe('UNKNOWN_OUTCOME');
  });

  it.each(CALLS)('$name: a 504 is unconfirmed, a 503 and a 500 are unavailable', async (call) => {
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
  });

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
  const create = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    createProject(
      S,
      {
        title: 'پل',
        operationType: 'خاکبرداری',
        locationDescription: 'کیلومتر ۱۲',
        scopeOfWork: 'شرح',
      },
      SUBMISSION,
      gateway(status, body, headers).impl,
    );
  const start = (status: number, body: unknown) =>
    startProject(S, 'PRJ_1', 1, gateway(status, body).impl);

  it('puts a 400 on the field the service named, and never shows an unknown sentence', async () => {
    const result = await create(
      400,
      problem('VALIDATION_FAILED', 'Request validation failed', [
        { path: 'title', message: 'String must contain at least 2 character(s)' },
        { path: 'estimatedCostMinor', message: 'The amount exceeds the largest storable value' },
        { path: 'operationType', message: 'operationType must be one of: a', code: 'NOT_ALLOWED' },
        { path: 'something.else', message: 'secret <b>text</b>' },
      ]),
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: {
        title: INVALID_INPUT_MESSAGE,
        estimatedCost: INVALID_INPUT_MESSAGE,
        operationType: OPERATION_TYPE_NOT_ALLOWED_MESSAGE,
      },
      message: INVALID_INPUT_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('says a stale version (409 OPTIMISTIC_LOCK_FAILED) as stale, never the service’s sentence', async () => {
    const result = await start(
      409,
      problem(
        'OPTIMISTIC_LOCK_FAILED',
        'Project was modified by another request; reload and retry',
      ),
    );
    expect(result).toMatchObject({ kind: 'INVALID', message: STALE_MESSAGE });
    expect(JSON.stringify(result)).not.toContain('modified');
  });

  it('says a reused submission id (409 IDEMPOTENCY_KEY_REUSED) in its own words', async () => {
    const result = await create(409, problem('IDEMPOTENCY_KEY_REUSED', 'Key reuse'));
    expect(result).toMatchObject({ kind: 'INVALID', message: KEY_REUSED_MESSAGE });
  });

  it('tells a request still being processed (409 CONFLICT with Retry-After) from a conflict', async () => {
    expect(
      await create(409, problem('CONFLICT', 'in flight'), { 'retry-after': '1' }),
    ).toMatchObject({
      kind: 'IN_PROGRESS',
      retryAfterSeconds: 1,
    });
    expect((await create(409, problem('CONFLICT', 'in flight'))).kind).toBe('INVALID');
  });

  it('says the closed system — no active policy — as its own sentence, not as a failure', async () => {
    const result = await requestApproval(
      S,
      'PRJ_1',
      1,
      gateway(
        422,
        problem(
          'BUSINESS_RULE_VIOLATION',
          'There is no active approval policy for project.execution in this organization. ' +
            'The platform never approves by default; a policy setter must activate one first.',
        ),
      ).impl,
    );
    expect(result).toMatchObject({ kind: 'INVALID', message: NO_POLICY_MESSAGE });
  });

  it('says a policy with no step for the estimate as its own sentence', async () => {
    const result = await requestApproval(
      S,
      'PRJ_1',
      1,
      gateway(
        422,
        problem(
          'BUSINESS_RULE_VIOLATION',
          "The active approval policy for project.execution has no step for this project's estimate. " +
            'The platform never approves by default.',
        ),
      ).impl,
    );
    expect(result).toMatchObject({ kind: 'INVALID', message: NO_APPLICABLE_STEP_MESSAGE });
  });

  it.each([
    ['Project PRJ_1 cannot move from DRAFT to IN_PROGRESS'],
    ['Project PRJ_1 is cancelled and cannot change state'],
    [
      'Project PRJ_1 is APPROVED and can no longer be edited; only a project in DRAFT or CHANGES_REQUESTED can change',
    ],
  ])('says the lifecycle refusal “%s” as a state refusal', async (sentence) => {
    const result = await start(422, problem('BUSINESS_RULE_VIOLATION', sentence));
    expect(result).toMatchObject({ kind: 'INVALID', message: STATE_MESSAGE });
  });

  it('says a 422 it does not know by its code, in fixed words', async () => {
    const result = await start(
      422,
      problem('BUSINESS_RULE_VIOLATION', 'A rule nobody wrote down yet'),
    );
    expect(result).toMatchObject({ kind: 'INVALID', message: BUSINESS_RULE_MESSAGE });
    expect(JSON.stringify(result)).not.toContain('nobody');
  });

  it('has a distinct fixed sentence for every business rule the service documents', () => {
    const texts = PROJECT_422_PATTERNS.map(([, text]) => text);
    expect(texts.every((text) => text.length > 10)).toBe(true);
    // The three state refusals share one sentence on purpose; every other rule has its own.
    expect(new Set(texts).size).toBe(texts.length - 2);
  });
});
