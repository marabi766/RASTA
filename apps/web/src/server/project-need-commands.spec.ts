/**
 * @jest-environment node
 */
import { INVALID_INPUT_MESSAGE, STALE_MESSAGE } from '@/lib/project-commands';
import {
  NEED_BUSINESS_RULE_MESSAGE,
  NEED_KEY_REUSED_MESSAGE,
  NEED_PROJECT_LOCKED_MESSAGE,
  NEED_STATE_MESSAGE,
} from '@/lib/project-need-commands';

import {
  addNeed,
  checkNeedStamp,
  mayAddNeed,
  mintNeedSubmission,
  needEditDigests,
  needFieldDigest,
  needStampTerms,
  offeredNeedCommands,
  openNeedBaseline,
  sealNeedBaseline,
  submitNeed,
  unchangedNeedFields,
  updateNeed,
  withdrawNeed,
  type NeedBaseline,
} from './project-need-commands';
import type { WebSession } from './session';
import { signPayload } from './signed-payload';

/**
 * The need commands against a fake gateway: the path, the method and the body of
 * every call, that only adding sends an `Idempotency-Key` (and no replay deadline,
 * which the endpoint does not read), how every documented answer is told in fixed
 * words, who is drawn which form, and what the baseline and the add stamp carry.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const session = (): WebSession => ({
  subject: 'user-1',
  username: 'u',
  organizationId: 'ORG-A',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
});
const S = session();

describe('who is drawn which form', () => {
  it('offers nothing to a person who may not write, whatever the statuses', () => {
    for (const projectStatus of ['DRAFT', 'CHANGES_REQUESTED', 'APPROVED']) {
      for (const needStatus of ['DRAFT', 'SUBMITTED', 'WITHDRAWN']) {
        expect(offeredNeedCommands({ projectStatus, needStatus, canWrite: false })).toEqual([]);
      }
      expect(mayAddNeed({ projectStatus, canWrite: false })).toBe(false);
    }
  });

  it('offers a draft need edit, submit and withdraw, a submitted one withdraw, a withdrawn one nothing', () => {
    for (const projectStatus of ['DRAFT', 'CHANGES_REQUESTED']) {
      const offered = (needStatus: string) =>
        offeredNeedCommands({ projectStatus, needStatus, canWrite: true });
      expect(offered('DRAFT')).toEqual(['edit', 'submit', 'withdraw']);
      expect(offered('SUBMITTED')).toEqual(['withdraw']);
      expect(offered('WITHDRAWN')).toEqual([]);
      expect(offered('SOMETHING_NEW')).toEqual([]);
      expect(mayAddNeed({ projectStatus, canWrite: true })).toBe(true);
    }
  });

  it('offers nothing while the project is not editable', () => {
    for (const projectStatus of [
      'PENDING_APPROVAL',
      'APPROVED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
      '',
      'SOMETHING_NEW',
    ]) {
      expect(offeredNeedCommands({ projectStatus, needStatus: 'DRAFT', canWrite: true })).toEqual(
        [],
      );
      expect(mayAddNeed({ projectStatus, canWrite: true })).toBe(false);
    }
  });
});

describe('the baseline', () => {
  const BASE: NeedBaseline = {
    needId: 'NED_1',
    projectId: 'PRJ_1',
    command: 'withdraw',
    version: 4,
    status: 'DRAFT',
    digests: null,
  };

  it('opens for the session and command it was minted for, and carries the version and both ids', () => {
    expect(openNeedBaseline(S, sealNeedBaseline(S, BASE), 'withdraw')).toEqual(BASE);
  });

  it('does not open for another command, another login, a forgery or a token of another purpose', () => {
    const token = sealNeedBaseline(S, BASE);
    expect(openNeedBaseline(S, token, 'submit')).toBeNull();
    expect(openNeedBaseline({ ...S, csrfToken: 'another-login' }, token, 'withdraw')).toBeNull();
    expect(openNeedBaseline(S, `${token}x`, 'withdraw')).toBeNull();
    expect(openNeedBaseline(S, undefined, 'withdraw')).toBeNull();
    // A project's baseline is no need's, even with the same fields.
    expect(
      openNeedBaseline(S, signPayload(S, 'project-baseline', { ...BASE }, 60), 'withdraw'),
    ).toBeNull();
  });

  it('refuses a command it does not know, a version of zero, a status that is empty and an add', () => {
    for (const bad of [{ command: 'delete' }, { command: 'add' }, { version: 0 }, { status: '' }]) {
      const token = signPayload(S, 'project-need-baseline', { ...BASE, ...bad }, 60);
      expect(openNeedBaseline(S, token, 'withdraw')).toBeNull();
    }
  });

  it('is refused once its half hour has passed', () => {
    const token = signPayload(S, 'project-need-baseline', { ...BASE }, -1);
    expect(openNeedBaseline(S, token, 'withdraw')).toBeNull();
  });

  it('stays inside the signed-token limit with the largest description the service takes', () => {
    const values = {
      title: 'ع'.repeat(200),
      description: 'ع'.repeat(2000),
      quantity: '9'.repeat(14) + '.9999',
      unit: 'ع'.repeat(50),
      estimatedCost: '9'.repeat(19),
    };
    const token = sealNeedBaseline(S, {
      ...BASE,
      command: 'edit',
      digests: needEditDigests(values),
    });
    expect(token.length).toBeLessThan(1200);
    expect(openNeedBaseline(S, token, 'edit')?.digests).toEqual(needEditDigests(values));
  });

  it('tells which fields still hold the value the page drew', () => {
    const drawn = { title: 'الف', description: 'ب', quantity: '2', unit: 'پ', estimatedCost: '' };
    const baseline = openNeedBaseline(
      S,
      sealNeedBaseline(S, { ...BASE, command: 'edit', digests: needEditDigests(drawn) }),
      'edit',
    )!;
    expect([...unchangedNeedFields(baseline, { ...drawn, title: 'تغییر' })].sort()).toEqual([
      'description',
      'estimatedCost',
      'quantity',
      'unit',
    ]);
    expect(unchangedNeedFields({ ...baseline, digests: null }, drawn).size).toBe(0);
    expect(needFieldDigest('a')).not.toBe(needFieldDigest('b'));
  });
});

describe('the add stamp', () => {
  it('opens for this login, this submission id and this project, until the end of the window', () => {
    const now = Date.now();
    const { id, replay } = mintNeedSubmission(S, 'PRJ_1', now);
    expect(checkNeedStamp(S, replay, id, 'PRJ_1', now)).toBe('OK');
    expect(needStampTerms(S, replay, id, 'PRJ_1', now)).toMatchObject({ issuedAt: now });
    // The default window: one hour less ten minutes.
    expect(checkNeedStamp(S, replay, id, 'PRJ_1', now + 3_000_000)).toBe('OK');
    expect(checkNeedStamp(S, replay, id, 'PRJ_1', now + 3_000_001)).toBe('EXPIRED');
  });

  it('is nobody else’s: another project, id, login, a forgery, or the project create’s own stamp', () => {
    const { id, replay } = mintNeedSubmission(S, 'PRJ_1');
    expect(checkNeedStamp(S, replay, id, 'PRJ_2')).toBeNull();
    expect(checkNeedStamp(S, replay, 'sub_other', 'PRJ_1')).toBeNull();
    expect(checkNeedStamp({ ...S, csrfToken: 'another-login' }, replay, id, 'PRJ_1')).toBeNull();
    expect(checkNeedStamp(S, `${replay}x`, id, 'PRJ_1')).toBeNull();
    expect(checkNeedStamp(S, undefined, id, 'PRJ_1')).toBeNull();
    const created = signPayload(
      S,
      'project-create-replay',
      { submissionId: id, issuedAt: Date.now(), deadline: Date.now() + 1000 },
      60,
    );
    expect(checkNeedStamp(S, created, id, 'PRJ_1')).toBeNull();
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

const SUBMISSION = 'sub_0123456789abcdef0123456789abcdef0123456789';

describe('what is sent to the gateway', () => {
  const OK = { id: 'NED_1' };
  const CALLS: readonly {
    name: string;
    method: string;
    path: string;
    body: unknown;
    keyed: boolean;
    run: (impl: typeof fetch) => Promise<{ kind: string }>;
  }[] = [
    {
      name: 'add',
      method: 'POST',
      path: '/v1/projects/PRJ_1/needs',
      body: { title: 'بتن', description: 'شرح', quantity: '2.5' },
      keyed: true,
      run: (impl) =>
        addNeed(
          S,
          'PRJ_1',
          { title: 'بتن', description: 'شرح', quantity: '2.5' },
          SUBMISSION,
          impl,
        ),
    },
    {
      name: 'edit',
      method: 'PATCH',
      path: '/v1/projects/PRJ_1/needs/NED_1',
      body: { title: 'بتن شمالی', quantity: null, expectedVersion: 3 },
      keyed: false,
      run: (impl) =>
        updateNeed(S, 'PRJ_1', 'NED_1', { title: 'بتن شمالی', quantity: null }, 3, impl),
    },
    {
      name: 'submit',
      method: 'POST',
      path: '/v1/projects/PRJ_1/needs/NED_1/submit',
      body: { expectedVersion: 3 },
      keyed: false,
      run: (impl) => submitNeed(S, 'PRJ_1', 'NED_1', 3, impl),
    },
    {
      name: 'withdraw',
      method: 'POST',
      path: '/v1/projects/PRJ_1/needs/NED_1/withdraw',
      body: { reason: 'دیگر لازم نیست', expectedVersion: 3 },
      keyed: false,
      run: (impl) => withdrawNeed(S, 'PRJ_1', 'NED_1', { reason: 'دیگر لازم نیست' }, 3, impl),
    },
  ];

  it.each(CALLS)('$name goes to $method $path with its body', async (call) => {
    const { impl, seen } = gateway(call.method === 'POST' && call.name === 'add' ? 201 : 200, OK);
    expect(await call.run(impl)).toMatchObject({ kind: 'CREATED', data: OK });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`http://gateway.test:3000${call.path}`);
    expect(seen[0]!.method).toBe(call.method);
    expect(seen[0]!.body).toEqual(call.body);
  });

  it.each(CALLS)('$name sends an Idempotency-Key only when it is the add', async (call) => {
    const { impl, seen } = gateway(200, OK);
    await call.run(impl);
    expect(seen[0]!.headers.get('idempotency-key')).toBe(call.keyed ? SUBMISSION : null);
    // The add endpoint reads no replay deadline, so none is sent for any call.
    expect(seen[0]!.headers.get('idempotency-replay-deadline')).toBeNull();
  });

  it('encodes a project or need id that carries a path character', async () => {
    const { impl, seen } = gateway(200, OK);
    await submitNeed(S, 'PRJ/1', 'NED 1', 3, impl);
    expect(seen[0]!.url).toBe('http://gateway.test:3000/v1/projects/PRJ%2F1/needs/NED%201/submit');
  });

  it('takes an answer without an id as unconfirmed: the write may have happened', async () => {
    const { impl } = gateway(200, { nothing: true });
    expect(await submitNeed(S, 'PRJ_1', 'NED_1', 3, impl)).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
  });
});

describe('how every documented answer is told', () => {
  const run = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    updateNeed(S, 'PRJ_1', 'NED_1', { title: 'عنوان' }, 3, gateway(status, body, headers).impl);

  it('maps a validation detail onto its field, in fixed words for an unknown rule', async () => {
    const result = await run(
      400,
      problem('VALIDATION_ERROR', 'Request validation failed', [
        { path: 'quantity', message: 'A quantity is a positive decimal string' },
        { path: 'estimatedCostMinor', message: 'The amount exceeds the largest storable value' },
        { path: 'unexpected', message: 'Unrecognized key(s) in object' },
      ]),
    );
    expect(result).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { quantity: INVALID_INPUT_MESSAGE, estimatedCost: INVALID_INPUT_MESSAGE },
      message: INVALID_INPUT_MESSAGE,
    });
  });

  it('says a stale version in its own words, by the code and not the sentence', async () => {
    expect(await run(409, problem('OPTIMISTIC_LOCK_FAILED', 'anything'))).toMatchObject({
      kind: 'INVALID',
      message: STALE_MESSAGE,
    });
  });

  it('says a reused key in the needs’ own words', async () => {
    const result = await addNeed(
      S,
      'PRJ_1',
      { title: 'عنوان', description: 'شرح' },
      SUBMISSION,
      gateway(409, problem('IDEMPOTENCY_KEY_REUSED', 'x')).impl,
    );
    expect(result).toMatchObject({ kind: 'INVALID', message: NEED_KEY_REUSED_MESSAGE });
  });

  it('tells a first request still in flight (409 with Retry-After) from a conflict', async () => {
    const add = (headers: Record<string, string>) =>
      addNeed(
        S,
        'PRJ_1',
        { title: 'عنوان', description: 'شرح' },
        SUBMISSION,
        gateway(409, problem('CONFLICT', 'in flight'), headers).impl,
      );
    expect(await add({ 'retry-after': '1' })).toMatchObject({ kind: 'IN_PROGRESS' });
    expect(await add({})).toMatchObject({ kind: 'INVALID' });
  });

  it.each([
    ['Need NED_1 was withdrawn and cannot change state', NEED_STATE_MESSAGE],
    ['Need NED_1 cannot move from SUBMITTED to SUBMITTED', NEED_STATE_MESSAGE],
    [
      'Need NED_1 is SUBMITTED and can no longer be edited; withdraw it and add a new one',
      NEED_STATE_MESSAGE,
    ],
    [
      'Project PRJ_1 is APPROVED and can no longer be edited; only a project in DRAFT or CHANGES_REQUESTED can change',
      NEED_PROJECT_LOCKED_MESSAGE,
    ],
    ['A sentence this portal does not know', NEED_BUSINESS_RULE_MESSAGE],
  ])('says the 422 “%s” in fixed words', async (sentence, expected) => {
    const result = await run(422, problem('BUSINESS_RULE_VIOLATION', sentence));
    expect(result).toMatchObject({ kind: 'INVALID', message: expected });
    // The service's own sentence is never shown.
    expect(JSON.stringify(result)).not.toContain(sentence);
  });

  it('keeps 403 and 404 apart and carries nothing of the service’s sentence', async () => {
    expect(await run(403, problem('FORBIDDEN', 'No'))).toMatchObject({ kind: 'FORBIDDEN' });
    expect(await run(404, problem('NOT_FOUND', 'ProjectNeed NED_1 not found'))).toMatchObject({
      kind: 'NOT_FOUND',
    });
  });

  it.each([500, 502, 503])('keeps a %i as unavailable, with its status', async (status) => {
    expect(await run(status, problem('INTERNAL_ERROR', 'boom'))).toMatchObject({
      kind: 'UNAVAILABLE',
      status,
    });
  });

  it('takes a gateway timeout as unconfirmed, not as a refusal', async () => {
    expect(await run(504, problem('UPSTREAM_TIMEOUT', 'slow'))).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
  });
});
