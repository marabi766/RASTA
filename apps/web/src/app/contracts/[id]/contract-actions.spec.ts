/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { readFlash } from '@/server/flash';
import { mintContractStamp, type ContractTarget } from '@/server/contract-command-replay';
import { REPLAY_FIELD } from '@/lib/form-fields';
import {
  CONTRACT_CODE_TEXT,
  CONTRACT_COMMANDS,
  CONTRACT_REFUSAL_TEXT,
} from '@/lib/contract-command-fields';
import { INPUT_MESSAGES } from '@/lib/contract-command-input';
import type { ContractScope } from '@/lib/unresolved-contract-command';
import {
  AMENDMENT_ID,
  CONTRACT_ID,
  CONTRACTOR_SIGNED,
  DRAFT,
  MILESTONE,
  MILESTONE_ID,
  PROPOSED,
} from '@/test/contract-command-fixtures';

import { IDLE_CONTRACT_FORM, type UnconfirmedContractCommand } from './contract-form-state';
import { actingAccessToken } from '@/test/session-token';

/**
 * The contract commands' write path — the order of checks every portal write
 * keeps, then what each answer becomes, then the unconfirmed path: a retry
 * sends the same key and the same body, and nothing a retry is answered with
 * but a confirmation settles the first request. Against a fake contract-service
 * behind the real gateway client, so what is asserted is what would be sent.
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

const { submitContractCommand } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./contract-actions') as typeof import('./contract-actions');

const SESSION = {
  subject: 'user-1',
  username: 'contractor',
  organizationId: 'ORG-CON-0001',
  accessToken: actingAccessToken('ORG-CON-0001'),
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const CONTRACT_SLOT: ContractScope = { contractId: CONTRACT_ID, slot: 'CONTRACT', subjectId: null };
const SIGN: ContractTarget = {
  command: 'SIGN',
  contractId: CONTRACT_ID,
  subjectId: null,
  expectedVersion: 1,
  side: 'CONTRACTOR',
};
const CANCEL: ContractTarget = { ...SIGN, command: 'CANCEL', side: null };

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly key: string | null;
  readonly body: unknown;
}

let sent: Sent[] = [];
let answer: () => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': `corr-${sent.length}` },
  });
}

function problem(status: number, code: string, reason?: string): Response {
  return json(status, {
    code,
    message: 'An English sentence never shown',
    correlationId: `corr-${sent.length}`,
    ...(reason ? { details: [{ path: 'signature', code: reason, message: 'English' }] } : {}),
  });
}

function form(
  fields: Record<string, string>,
  target: ContractTarget | null,
  options: { csrf?: string | null; submission?: string } = {},
): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) data.set(CSRF_FIELD, csrf);
  const submission = options.submission ?? mintSubmissionId(SESSION);
  data.set(SUBMISSION_FIELD, submission);
  if (target) data.set(REPLAY_FIELD, mintContractStamp(SESSION, target, submission).token);
  return data;
}

beforeEach(() => {
  sent = [];
  currentSession.mockResolvedValue(SESSION);
  missingSessionReason.mockResolvedValue('NO_SESSION');
  redirect.mockClear();
  answer = () => json(200, CONTRACTOR_SIGNED);
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      key: new Headers(init.headers).get('idempotency-key'),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return answer();
  }) as unknown as typeof fetch);
});

afterEach(() => jest.restoreAllMocks());

const command = (scope: ContractScope, data: FormData, previous = IDLE_CONTRACT_FORM) =>
  submitContractCommand(scope, previous, data);

describe('the gates, in order — nothing is sent past the first that refuses', () => {
  it('no session', async () => {
    currentSession.mockResolvedValue(null);
    expect(await command(CONTRACT_SLOT, form({}, SIGN))).toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    missingSessionReason.mockResolvedValue('SESSION_UNAVAILABLE');
    expect(await command(CONTRACT_SLOT, form({}, SIGN))).toEqual({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(sent).toEqual([]);
  });

  it('CSRF, then the submission id, then the stamp', async () => {
    expect(await command(CONTRACT_SLOT, form({}, SIGN, { csrf: 'forged' }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(
      await command(CONTRACT_SLOT, form({}, SIGN, { submission: 'sub_not_this_login' })),
    ).toEqual({
      kind: 'REFUSED',
      reason: 'SUBMISSION',
    });
    expect(await command(CONTRACT_SLOT, form({}, null))).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(sent).toEqual([]);
  });

  it('a stamp for another contract, another slot or another object is refused unsent', async () => {
    const other = { ...CONTRACT_SLOT, contractId: 'CTR_OTHER' };
    expect(await command(other, form({}, SIGN))).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    const amendmentSign: ContractTarget = {
      ...SIGN,
      command: 'SIGN_AMENDMENT',
      subjectId: AMENDMENT_ID,
    };
    const amendmentSlot: ContractScope = {
      contractId: CONTRACT_ID,
      slot: 'AMENDMENT',
      subjectId: AMENDMENT_ID,
    };
    expect(await command(CONTRACT_SLOT, form({}, amendmentSign))).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(
      await command({ ...amendmentSlot, subjectId: 'AMD_OTHER' }, form({}, amendmentSign)),
    ).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    expect(sent).toEqual([]);
  });

  it('a slot that is not one, or one missing its object, is refused unsent', async () => {
    const crafted = {
      contractId: CONTRACT_ID,
      slot: 'EVERYTHING',
      subjectId: null,
    } as unknown as ContractScope;
    expect(await command(crafted, form({}, SIGN))).toEqual({ kind: 'REFUSED', reason: 'COMMAND' });
    expect(
      await command(
        { contractId: CONTRACT_ID, slot: 'AMENDMENT', subjectId: null },
        form({}, SIGN),
      ),
    ).toEqual({ kind: 'REFUSED', reason: 'COMMAND' });
    expect(sent).toEqual([]);
  });

  it('a typed body the form refuses is never sent', async () => {
    const state = await command(CONTRACT_SLOT, form({ reasonCode: '' }, CANCEL));
    expect(state).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { reasonCode: INPUT_MESSAGES.reasonCode },
    });
    expect(sent).toEqual([]);
  });
});

describe('what is sent comes from the stamp, never from the posted form', () => {
  it('a signature: the side and version the page drew, under the submission id', async () => {
    const data = form({ expectedVersion: '99', side: 'EMPLOYER', command: 'CANCEL' }, SIGN);
    await expect(command(CONTRACT_SLOT, data)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(sent).toEqual([
      {
        url: `http://gateway.test:3000/v1/contracts/${CONTRACT_ID}/sign`,
        method: 'POST',
        key: data.get(SUBMISSION_FIELD),
        body: { expectedVersion: 1 },
      },
    ]);
  });

  it('a confirmed command returns to the contract with a confirmation signed for it', async () => {
    await expect(command(CONTRACT_SLOT, form({}, SIGN))).rejects.toThrow(/NEXT_REDIRECT/);
    const url = new URL(String(redirect.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.pathname).toBe(`/contracts/${CONTRACT_ID}`);
    expect(readFlash(SESSION, url.searchParams.get('flash'), CONTRACT_ID, CONTRACT_COMMANDS)).toBe(
      'SIGN',
    );
  });

  it('a cancellation: the reason typed, and the version from the stamp', async () => {
    answer = () =>
      json(200, { ...DRAFT, status: 'CANCELLED', cancelReasonCode: 'OTHER', version: 2 });
    await expect(
      command(CONTRACT_SLOT, form({ reasonCode: 'OTHER', note: '' }, CANCEL)),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/contracts/${CONTRACT_ID}/cancel`,
      body: { reasonCode: 'OTHER', expectedVersion: 1 },
    });
  });

  it('a milestone change: PATCH to the milestone the stamp names', async () => {
    answer = () => json(200, { ...MILESTONE, title: 'فاز دو', version: 2 });
    const target: ContractTarget = {
      command: 'CHANGE_MILESTONE',
      contractId: CONTRACT_ID,
      subjectId: MILESTONE_ID,
      expectedVersion: 1,
      side: null,
    };
    const scope: ContractScope = {
      contractId: CONTRACT_ID,
      slot: 'MILESTONE',
      subjectId: MILESTONE_ID,
    };
    await expect(
      command(
        scope,
        form({ title: 'فاز دو', plannedDate: '2026-12-20', plannedShareBp: '25.5' }, target),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/contracts/${CONTRACT_ID}/milestones/${MILESTONE_ID}`,
      method: 'PATCH',
      body: {
        title: 'فاز دو',
        plannedDate: '2026-12-20',
        plannedShareBp: 2550,
        expectedVersion: 1,
      },
    });
  });
});

describe('each answer', () => {
  it('a policy refusal is said in fixed words, on the form', async () => {
    answer = () => problem(422, 'BUSINESS_RULE_VIOLATION', 'SIGNATURE_POLICY_REQUIRED');
    expect(await command(CONTRACT_SLOT, form({}, SIGN))).toMatchObject({
      kind: 'INVALID',
      message: CONTRACT_REFUSAL_TEXT.SIGNATURE_POLICY_REQUIRED,
    });
  });

  it('separation of duties is a 403 with its closed reason', async () => {
    answer = () => problem(403, 'FORBIDDEN', 'SAME_PERSON_BOTH_SIDES');
    expect(await command(CONTRACT_SLOT, form({}, SIGN))).toMatchObject({
      kind: 'FORBIDDEN',
      reasons: ['SAME_PERSON_BOTH_SIDES'],
    });
  });

  it('a stale form is a conflict, said by its code', async () => {
    answer = () => problem(409, 'OPTIMISTIC_LOCK_FAILED');
    expect(await command(CONTRACT_SLOT, form({}, SIGN))).toMatchObject({
      kind: 'INVALID',
      message: CONTRACT_CODE_TEXT.OPTIMISTIC_LOCK_FAILED,
    });
  });

  it('gone is gone', async () => {
    answer = () => problem(404, 'NOT_FOUND');
    expect(await command(CONTRACT_SLOT, form({}, SIGN))).toEqual({ kind: 'NOT_FOUND' });
  });

  it('no answer is unconfirmed, keeping what was sent and the stamp', async () => {
    answer = () => problem(504, 'UPSTREAM_TIMEOUT');
    const data = form(
      { deltaMinor: '۲٬۰۰۰٬۰۰۰', reasonCode: 'SCOPE_CHANGE', reasonText: 'متن' },
      {
        command: 'PROPOSE_AMENDMENT',
        contractId: CONTRACT_ID,
        subjectId: null,
        expectedVersion: 2,
        side: null,
      },
    );
    const state = await command(
      { contractId: CONTRACT_ID, slot: 'NEW_AMENDMENT', subjectId: null },
      data,
    );
    expect(state).toMatchObject({
      kind: 'UNCONFIRMED',
      command: 'PROPOSE_AMENDMENT',
      submissionId: data.get(SUBMISSION_FIELD),
      input: { deltaMinor: '2000000', reasonCode: 'SCOPE_CHANGE', reasonText: 'متن' },
      replay: { token: data.get(REPLAY_FIELD) },
    });
  });
});

describe('a retry of an unconfirmed command', () => {
  const amendmentSlot: ContractScope = {
    contractId: CONTRACT_ID,
    slot: 'AMENDMENT',
    subjectId: AMENDMENT_ID,
  };
  const target: ContractTarget = {
    command: 'SIGN_AMENDMENT',
    contractId: CONTRACT_ID,
    subjectId: AMENDMENT_ID,
    expectedVersion: 1,
    side: 'CONTRACTOR',
  };
  const submission = mintSubmissionId(SESSION);
  const previous: UnconfirmedContractCommand = {
    kind: 'UNCONFIRMED',
    command: 'SIGN_AMENDMENT',
    correlationId: 'corr-first',
    submissionId: submission,
    input: null,
    replay: {
      token: mintContractStamp(SESSION, target, submission).token,
      until: Date.now() + 60_000,
    },
  };
  const retry = () => form({}, target, { submission });

  it('is the same request under the same key; confirmed, it redirects', async () => {
    answer = () => json(200, { ...PROPOSED, contractorSignedAt: '2026-10-04T08:00:00.000Z' });
    await expect(command(amendmentSlot, retry(), previous)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(sent[0]).toMatchObject({ key: submission, body: { expectedVersion: 1 } });
  });

  it('refused, it settles nothing about the first request', async () => {
    answer = () => problem(409, 'ALREADY_EXISTS', 'SIDE_ALREADY_SIGNED');
    expect(await command(amendmentSlot, retry(), previous)).toEqual({
      ...previous,
      retryRefused: true,
    });
  });

  it('with the session ended, or past the deadline, it says so and keeps the original', async () => {
    currentSession.mockResolvedValue(null);
    expect(await command(amendmentSlot, retry(), previous)).toEqual({
      ...previous,
      sessionEnded: true,
    });
    currentSession.mockResolvedValue(SESSION);
    expect(await command(amendmentSlot, form({}, null, { submission }), previous)).toEqual({
      ...previous,
      replay: null,
      viewOnly: true,
      replayExpired: true,
    });
  });

  it('unanswered again, it is still unknown', async () => {
    answer = () => problem(503, 'SERVICE_UNAVAILABLE');
    expect(await command(amendmentSlot, retry(), previous)).toEqual({
      ...previous,
      retryUnknown: true,
    });
  });
});
