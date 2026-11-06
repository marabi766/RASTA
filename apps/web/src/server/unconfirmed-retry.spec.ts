/**
 * @jest-environment node
 */
import type { z } from 'zod';

import { actingAccessToken } from '@/test/session-token';

import type { WebSession } from './session';
import { isUnresolvedState, keepUnconfirmed, keepUnconfirmedWith } from './unconfirmed-retry';
import { writeThroughGateway } from './write';

/**
 * FU-173 (PR-830 r2 F1): the one rule every write action applies — a retry of a
 * send whose outcome is unknown stays unconfirmed until a success confirms it.
 * The second half drives the real writer: what a write sent during such a retry
 * answers, whatever the runner around it does with a refusal.
 */

process.env.API_GATEWAY_URL ??= 'http://gateway.test:3000';
process.env.OIDC_ISSUER_URL ??= 'http://keycloak.test/realms/rasta';
process.env.OIDC_CLIENT_ID ??= 'rasta-web';
process.env.WEB_PUBLIC_ORIGIN ??= 'http://localhost:3200';
process.env.WEB_SESSION_SECRET ??= 'a-secret-that-is-long-enough-to-be-a-key';

type State =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'FAILED'; readonly status: number; readonly correlationId: string }
  | { readonly kind: 'INVALID'; readonly submissionId: string }
  | { readonly kind: 'REFUSED'; readonly reason: string }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'EDITING'; readonly submissionId: string }
  | { readonly kind: 'IN_PROGRESS'; readonly submissionId: string; readonly correlationId: string }
  | { readonly kind: 'UNCONFIRMED'; readonly correlationId: string };

const FIRST: State = { kind: 'UNCONFIRMED', correlationId: 'COR-FIRST' };
const STILL: State = { kind: 'IN_PROGRESS', submissionId: 'sub_X', correlationId: 'COR-WAIT' };
const keep = (previous: State, next: State) => keepUnconfirmed(previous, async () => next);

describe('the rule', () => {
  const refusals: readonly State[] = [
    { kind: 'FAILED', status: 429, correlationId: 'COR-RETRY' },
    { kind: 'FAILED', status: 503, correlationId: 'COR-RETRY' },
    { kind: 'INVALID', submissionId: 'sub_X' },
    { kind: 'REFUSED', reason: 'NO_SESSION' },
    { kind: 'NOT_FOUND' },
    { kind: 'IDLE' },
  ];

  it.each(refusals)(
    'a retry of an unconfirmed send answered $kind stays UNCONFIRMED, under the first correlation id',
    async (next) => {
      expect(await keep(FIRST, next)).toEqual(FIRST);
    },
  );

  it.each(refusals)(
    'a retry of a send still in progress answered $kind is UNCONFIRMED',
    async (next) => {
      expect(await keep(STILL, next)).toEqual({ kind: 'UNCONFIRMED', correlationId: 'COR-WAIT' });
    },
  );

  it('passes on what is still unresolved, and the person’s own "edit and send as new"', async () => {
    const editing: State = { kind: 'EDITING', submissionId: 'sub_NEW' };
    expect(await keep(FIRST, STILL)).toBe(STILL);
    expect(await keep(FIRST, editing)).toBe(editing);
  });

  it('an unconfirmed retry keeps the first send’s correlation id', async () => {
    expect(await keep(FIRST, { kind: 'UNCONFIRMED', correlationId: 'COR-RETRY' })).toEqual(FIRST);
  });

  it('leaves a first send, and a send after any settled state, as it is', async () => {
    const failed: State = { kind: 'FAILED', status: 429, correlationId: 'COR' };
    for (const previous of [
      { kind: 'IDLE' },
      failed,
      { kind: 'INVALID', submissionId: 'sub_X' },
      { kind: 'REFUSED', reason: 'CSRF' },
    ] as const) {
      expect(await keep(previous, failed)).toBe(failed);
    }
  });

  it('a success still redirects: the confirmation passes through', async () => {
    const confirmed = new Error('NEXT_REDIRECT:/done');
    await expect(
      keepUnconfirmed(FIRST, async () => {
        throw confirmed;
      }),
    ).rejects.toBe(confirmed);
  });

  it('takes from the browser’s state only what makes the answer less certain', async () => {
    expect(isUnresolvedState(null)).toBe(false);
    expect(isUnresolvedState('UNCONFIRMED')).toBe(false);
    expect(isUnresolvedState({ kind: 7 })).toBe(false);
    // A correlation id that does not look like one is not shown back.
    const odd = { kind: 'UNCONFIRMED', correlationId: '<b>x</b>' } as State;
    expect(await keep(odd, { kind: 'FAILED', status: 429, correlationId: 'COR-RETRY' })).toEqual({
      kind: 'UNCONFIRMED',
      correlationId: 'COR-RETRY',
    });
  });

  it('builds a richer unconfirmed state with the caller’s own builder', async () => {
    type Rich = State | { readonly kind: 'UNCONFIRMED'; correlationId: string; resume: string };
    const state = await keepUnconfirmedWith<Rich>(
      FIRST,
      async () => ({ kind: 'FAILED', status: 429, correlationId: 'COR-RETRY' }),
      (correlationId) => ({ kind: 'UNCONFIRMED', correlationId, resume: 'TOKEN' }),
    );
    expect(state).toEqual({ kind: 'UNCONFIRMED', correlationId: 'COR-FIRST', resume: 'TOKEN' });
  });
});

describe('what a write sent during the retry answers (the real writer)', () => {
  const session = {
    accessToken: actingAccessToken('ORG-DEH-0001'),
    organizationId: 'ORG-DEH-0001',
  } as WebSession;
  const schema = {
    safeParse: (value: unknown) =>
      typeof value === 'object' && value !== null && 'id' in value
        ? { success: true as const, data: value }
        : { success: false as const, error: new Error('shape') },
  } as unknown as z.ZodTypeAny;
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    jest.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        }),
    ) as unknown as typeof fetch;
  const write = (fetchImpl: typeof fetch) =>
    writeThroughGateway(session, {
      path: '/v1/things',
      body: {},
      submissionId: 'sub_AAAAAAAAAAAAAAAAAAAA',
      schema,
      mapping: { paths: {} },
      fetchImpl,
    });
  const duringRetry = <T>(send: () => Promise<T>) => {
    let seen: T | undefined;
    return keepUnconfirmed(FIRST, async () => {
      seen = await send();
      return { kind: 'IDLE' } as State;
    }).then(() => seen as T);
  };

  const refusals: ReadonlyArray<readonly [string, number, unknown]> = [
    ['429 RATE_LIMIT_EXCEEDED', 429, { code: 'RATE_LIMIT_EXCEEDED', message: 'slow down' }],
    ['409 OPTIMISTIC_LOCK_FAILED', 409, { code: 'OPTIMISTIC_LOCK_FAILED', message: 'stale' }],
    ['403 FORBIDDEN', 403, { code: 'FORBIDDEN', message: 'no' }],
    ['404 NOT_FOUND', 404, { code: 'NOT_FOUND', message: 'gone' }],
    ['400 VALIDATION_FAILED', 400, { code: 'VALIDATION_FAILED', message: 'bad' }],
    ['503', 503, {}],
  ];

  it.each(refusals)(
    '%s during a retry is UNKNOWN_OUTCOME, never a refusal',
    async (_name, status, body) => {
      // Outside a retry the writer answers it as a refusal …
      expect((await write(answer(status, body))).kind).not.toBe('UNKNOWN_OUTCOME');
      // … during one, it proves nothing about the first send.
      expect((await duringRetry(() => write(answer(status, body)))).kind).toBe('UNKNOWN_OUTCOME');
    },
  );

  it('a success during a retry is the confirmation, and "in progress" stays itself', async () => {
    expect((await duringRetry(() => write(answer(201, { id: 'X' })))).kind).toBe('CREATED');
    const busy = answer(409, { code: 'CONFLICT', message: 'busy' }, { 'retry-after': '1' });
    expect((await duringRetry(() => write(busy))).kind).toBe('IN_PROGRESS');
  });
});
