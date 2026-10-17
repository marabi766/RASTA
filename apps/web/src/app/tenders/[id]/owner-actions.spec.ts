/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { readFlash } from '@/server/flash';
import { mintOwnerStamp, type OwnerTarget } from '@/server/tender-owner-replay';
import { REPLAY_FIELD } from '@/lib/form-fields';
import { OPENING_REFUSAL_TEXT, OWNER_CODE_TEXT, REASON_FIELD } from '@/lib/tender-owner-fields';
import { APPROVAL_ID, OWNER, PENDING_REQUEST, TENDER_ID } from '@/test/owner-fixtures';

import {
  IDLE_OWNER_FORM,
  type OwnerFormState,
  type UnconfirmedOwnerCommand,
} from './owner-form-state';

/**
 * The owner's write path — the order of checks every portal write keeps, then
 * what each answer becomes, then the unconfirmed path. Against a fake
 * construction-service behind the real gateway client.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const currentSession = jest.fn();
const missingSessionReason = jest.fn();
const redirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('@/server/current-session', () => ({
  currentSession: () => currentSession(),
  missingSessionReason: () => missingSessionReason(),
}));
jest.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));

const { submitOwnerCommand } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./owner-actions') as typeof import('./owner-actions');

const SESSION = {
  subject: 'user-1',
  username: 'author',
  organizationId: OWNER,
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const PUBLISH: OwnerTarget = {
  tenderId: TENDER_ID,
  command: 'PUBLISH',
  approvalId: null,
  expectedVersion: 4,
};
const REJECT: OwnerTarget = {
  tenderId: TENDER_ID,
  command: 'REJECT',
  approvalId: APPROVAL_ID,
  expectedVersion: 7,
};
const OPEN: OwnerTarget = {
  tenderId: TENDER_ID,
  command: 'OPEN_BIDS',
  approvalId: null,
  expectedVersion: null,
};

interface Sent {
  readonly url: string;
  readonly key: string | null;
  readonly body: unknown;
}
let sent: Sent[] = [];
let answer: (body: Record<string, unknown>) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': `corr-${sent.length}` },
  });
}

function problem(status: number, code: string, reason?: string, path = 'opening'): Response {
  return json(status, {
    code,
    message: 'An English sentence never shown',
    correlationId: `corr-${sent.length}`,
    ...(reason ? { details: [{ path, code: reason, message: 'English' }] } : {}),
  });
}

function form(
  fields: Record<string, string>,
  target: OwnerTarget | null,
  options: { csrf?: string | null; submission?: string } = {},
): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) data.set(CSRF_FIELD, csrf);
  const submission = options.submission ?? mintSubmissionId(SESSION);
  data.set(SUBMISSION_FIELD, submission);
  if (target) data.set(REPLAY_FIELD, mintOwnerStamp(SESSION, target, submission).token);
  return data;
}

beforeEach(() => {
  sent = [];
  currentSession.mockResolvedValue(SESSION);
  missingSessionReason.mockResolvedValue('NO_SESSION');
  redirect.mockClear();
  answer = () => json(202, PENDING_REQUEST);
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url, key: new Headers(init.headers).get('idempotency-key'), body });
    return answer(body);
  }) as unknown as typeof fetch);
});

afterEach(() => jest.restoreAllMocks());

const send = (data: FormData, previous: OwnerFormState = IDLE_OWNER_FORM, tenderId = TENDER_ID) =>
  submitOwnerCommand(tenderId, previous, data);

describe('the order of checks — nothing is sent until every one passes', () => {
  it('no session (ended, or only unavailable), a missing CSRF token, a submission id this server did not mint, no stamp or another tender’s', async () => {
    currentSession.mockResolvedValueOnce(null);
    expect(await send(form({}, PUBLISH))).toEqual({ kind: 'REFUSED', reason: 'NO_SESSION' });
    missingSessionReason.mockResolvedValueOnce('SESSION_UNAVAILABLE');
    currentSession.mockResolvedValueOnce(null);
    expect(await send(form({}, PUBLISH))).toEqual({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(await send(form({}, PUBLISH, { csrf: null }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(await send(form({}, PUBLISH, { submission: 'sub_chosen_by_the_client' }))).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(await send(form({}, null))).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    expect(await send(form({}, PUBLISH), IDLE_OWNER_FORM, 'TND_OTHER')).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(sent).toHaveLength(0);
  });

  it('a rejection without a stated reason is put back on the form, unsent', async () => {
    expect(await send(form({ [REASON_FIELD]: 'کوتاه' }, REJECT))).toMatchObject({
      kind: 'INVALID',
      command: 'REJECT',
      reason: 'کوتاه',
      fieldErrors: { [REASON_FIELD]: expect.any(String) },
    });
    expect(sent).toHaveLength(0);
  });
});

describe('what is sent, and what comes back', () => {
  it('a publication sends the version the page signed — whatever the form posts — and says it was asked', async () => {
    const data = form({ expectedVersion: '99' }, PUBLISH);
    await expect(send(data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: `http://gateway.test:3000/v1/tenders/${TENDER_ID}/publish`,
        key: data.get(SUBMISSION_FIELD),
        body: { expectedVersion: 4 },
      },
    ]);
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(url.searchParams.get('view')).toBe('own');
    expect(
      readFlash(SESSION, url.searchParams.get('flash'), TENDER_ID, ['REQUESTED', 'PUBLISHED']),
    ).toBe('REQUESTED');
  });

  it('the publication executed: the flash says published', async () => {
    answer = () => json(200, { id: TENDER_ID, status: 'PUBLISHED', version: 5 });
    await expect(send(form({}, PUBLISH))).rejects.toThrow('NEXT_REDIRECT');
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(
      readFlash(SESSION, url.searchParams.get('flash'), TENDER_ID, ['REQUESTED', 'PUBLISHED']),
    ).toBe('PUBLISHED');
  });

  it('a rejection sends the step, its version and the trimmed reason', async () => {
    answer = () =>
      json(200, {
        id: APPROVAL_ID,
        tenderId: TENDER_ID,
        workflowKey: 'tender.publication',
        status: 'REJECTED',
        authorityOrganizationId: OWNER,
        authorityRole: 'ORGANIZATION_ADMIN',
        version: 8,
      });
    await expect(send(form({ [REASON_FIELD]: '  معیارها کامل نیست  ' }, REJECT))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/approvals/${APPROVAL_ID}/decision`,
      body: { expectedVersion: 7, decision: 'REJECT', reason: 'معیارها کامل نیست' },
    });
  });

  it('the opening: the second person required is said in fixed words; a stale page too', async () => {
    answer = () => problem(422, 'BUSINESS_RULE_VIOLATION', 'SECOND_PERSON_REQUIRED');
    expect(await send(form({}, OPEN))).toMatchObject({
      kind: 'INVALID',
      message: OPENING_REFUSAL_TEXT.SECOND_PERSON_REQUIRED,
    });
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/tenders/${TENDER_ID}/open-bids`,
      body: {},
    });
    answer = () => problem(409, 'OPTIMISTIC_LOCK_FAILED');
    expect(await send(form({}, PUBLISH))).toMatchObject({
      kind: 'INVALID',
      message: OWNER_CODE_TEXT.OPTIMISTIC_LOCK_FAILED,
    });
  });

  it('a 403 keeps its command and closed reasons; a 404 is NOT_FOUND', async () => {
    answer = () => problem(403, 'FORBIDDEN', 'CONFLICT_OF_INTEREST');
    expect(await send(form({}, OPEN))).toMatchObject({
      kind: 'FORBIDDEN',
      command: 'OPEN_BIDS',
      reasons: ['CONFLICT_OF_INTEREST'],
    });
    answer = () => problem(404, 'NOT_FOUND');
    expect(await send(form({}, PUBLISH))).toEqual({ kind: 'NOT_FOUND' });
  });
});

describe('unconfirmed', () => {
  it('a 504 is unconfirmed, with the stamp and the reason sent; a retry sends the same key and body', async () => {
    answer = () => problem(504, 'UPSTREAM_TIMEOUT');
    const data = form({ [REASON_FIELD]: 'معیارها کامل نیست' }, REJECT);
    const first = (await send(data)) as UnconfirmedOwnerCommand;
    expect(first).toMatchObject({
      kind: 'UNCONFIRMED',
      command: 'REJECT',
      reason: 'معیارها کامل نیست',
    });
    answer = () => problem(409, 'OPTIMISTIC_LOCK_FAILED');
    const second = await send(data, first);
    expect(sent[1]).toEqual(sent[0]);
    expect(second).toMatchObject({
      kind: 'UNCONFIRMED',
      correlationId: first.correlationId,
      retryRefused: true,
    });
  });
});
