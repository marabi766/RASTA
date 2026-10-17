/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { readFlash } from '@/server/flash';
import { mintStatementStamp, type StatementTarget } from '@/server/statement-replay';
import { REPLAY_FIELD } from '@/lib/form-fields';
import { lineField, STATEMENT_CODE_TEXT, STATEMENT_REFUSAL_TEXT } from '@/lib/statement-fields';
import {
  CONTRACT_ID,
  DRAFTED,
  STATEMENT_ID,
  SUBMITTED,
  TECHNICALLY_APPROVED,
} from '@/test/statement-fixtures';

import { IDLE_STATEMENT_FORM, type UnconfirmedStatement } from './statement-form-state';

/**
 * The statement commands' write path — the order of checks every portal write
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

const { submitStatementDraft, submitStatementCommand } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./statement-actions') as typeof import('./statement-actions');

const SESSION = {
  subject: 'user-1',
  username: 'approver',
  organizationId: 'ORG-DEH-0001',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

const APPROVE_TECHNICAL: StatementTarget = {
  contractId: CONTRACT_ID,
  statementId: STATEMENT_ID,
  command: 'APPROVE',
  expectedVersion: SUBMITTED.version,
  chain: 'TECHNICAL',
  stepOrder: 1,
};

interface Sent {
  readonly url: string;
  readonly key: string | null;
  readonly body: unknown;
}

let sent: Sent[] = [];
let answer: (body: Record<string, unknown>) => Response;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-correlation-id': `corr-${sent.length}`,
      ...headers,
    },
  });
}

function problem(status: number, code: string, reason?: string): Response {
  return json(status, {
    code,
    message: 'An English sentence never shown',
    correlationId: `corr-${sent.length}`,
    ...(reason ? { details: [{ path: 'decision', code: reason, message: 'English' }] } : {}),
  });
}

function form(
  fields: Record<string, string>,
  target: StatementTarget | null,
  options: { csrf?: string | null; submission?: string } = {},
): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  const csrf = options.csrf === undefined ? SESSION.csrfToken : options.csrf;
  if (csrf !== null) data.set(CSRF_FIELD, csrf);
  const submission = options.submission ?? mintSubmissionId(SESSION);
  data.set(SUBMISSION_FIELD, submission);
  if (target) data.set(REPLAY_FIELD, mintStatementStamp(SESSION, target, submission).token);
  return data;
}

const DRAFT_FIELDS = {
  [lineField(0, 'description')]: 'آسفالت',
  [lineField(0, 'amount')]: '۱٬۱۰۰٬۰۰۰٬۰۰۰',
  [lineField(1, 'description')]: '',
  [lineField(1, 'amount')]: '',
};

beforeEach(() => {
  sent = [];
  currentSession.mockResolvedValue(SESSION);
  missingSessionReason.mockResolvedValue('NO_SESSION');
  redirect.mockClear();
  answer = () => json(200, TECHNICALLY_APPROVED);
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url, key: new Headers(init.headers).get('idempotency-key'), body });
    return answer(body);
  }) as unknown as typeof fetch);
});

afterEach(() => jest.restoreAllMocks());

const decide = (data: FormData, previous = IDLE_STATEMENT_FORM) =>
  submitStatementCommand(CONTRACT_ID, STATEMENT_ID, previous, data);

describe('the order of checks — nothing is sent until every one passes', () => {
  it('no session: ended, or only unavailable for now', async () => {
    currentSession.mockResolvedValue(null);
    expect(await decide(form({}, APPROVE_TECHNICAL))).toEqual({
      kind: 'REFUSED',
      reason: 'NO_SESSION',
    });
    missingSessionReason.mockResolvedValue('SESSION_UNAVAILABLE');
    expect(await decide(form({}, APPROVE_TECHNICAL))).toEqual({
      kind: 'REFUSED',
      reason: 'SESSION_UNAVAILABLE',
    });
    expect(sent).toHaveLength(0);
  });

  it('a missing CSRF token, a submission id this server did not mint', async () => {
    expect(await decide(form({}, APPROVE_TECHNICAL, { csrf: null }))).toEqual({
      kind: 'REFUSED',
      reason: 'CSRF',
    });
    expect(
      await decide(form({}, APPROVE_TECHNICAL, { submission: 'sub_chosen_by_the_client' })),
    ).toEqual({ kind: 'REFUSED', reason: 'SUBMISSION' });
    expect(sent).toHaveLength(0);
  });

  it('no stamp, or a stamp for another statement or another contract', async () => {
    expect(await decide(form({}, null))).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    expect(await decide(form({}, { ...APPROVE_TECHNICAL, statementId: 'STM_OTHER' }))).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(
      await submitStatementCommand(
        'CTR_OTHER',
        STATEMENT_ID,
        IDLE_STATEMENT_FORM,
        form({}, APPROVE_TECHNICAL),
      ),
    ).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    expect(sent).toHaveLength(0);
  });

  it('a draft’s stamp on a statement, a statement’s stamp on the draft form', async () => {
    expect(
      await submitStatementDraft(
        CONTRACT_ID,
        IDLE_STATEMENT_FORM,
        form(DRAFT_FIELDS, APPROVE_TECHNICAL),
      ),
    ).toEqual({ kind: 'REFUSED', reason: 'REPLAY' });
    expect(sent).toHaveLength(0);
  });
});

describe('a decision', () => {
  it('sends the step, the decision and the version the page signed — whatever the form posts', async () => {
    const data = form(
      { chain: 'FINANCIAL', stepOrder: '9', decision: 'REJECT', expectedVersion: '99' },
      APPROVE_TECHNICAL,
    );
    await expect(decide(data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: `http://gateway.test:3000/v1/contracts/${CONTRACT_ID}/statements/${STATEMENT_ID}/decisions`,
        key: data.get(SUBMISSION_FIELD),
        body: { chain: 'TECHNICAL', stepOrder: 1, decision: 'APPROVE', expectedVersion: 2 },
      },
    ]);
  });

  it('confirmed: back to the statement with a confirmation this session earned for it', async () => {
    await expect(decide(form({}, APPROVE_TECHNICAL))).rejects.toThrow('NEXT_REDIRECT');
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(url.pathname).toBe(`/contracts/${CONTRACT_ID}/statements/${STATEMENT_ID}`);
    expect(readFlash(SESSION, url.searchParams.get('flash'), STATEMENT_ID, ['APPROVE'])).toBe(
      'APPROVE',
    );
  });

  it('a stale form — drawn at version 2, the statement now at 3 — is refused in fixed words', async () => {
    // The fake service applies `expectedVersion` as contract-service does.
    const current = 3;
    answer = (body) =>
      body.expectedVersion !== current
        ? problem(409, 'OPTIMISTIC_LOCK_FAILED')
        : json(200, TECHNICALLY_APPROVED);
    expect(await decide(form({}, APPROVE_TECHNICAL))).toMatchObject({
      kind: 'INVALID',
      message: STATEMENT_CODE_TEXT.OPTIMISTIC_LOCK_FAILED,
    });
  });

  it('separation of duties: the same person on two steps, the submitter — fixed words, never echoed', async () => {
    for (const reason of ['ALREADY_DECIDED_STATEMENT', 'SUBMITTER_MAY_NOT_DECIDE']) {
      answer = () => problem(422, 'BUSINESS_RULE_VIOLATION', reason);
      const state = await decide(form({}, APPROVE_TECHNICAL));
      expect(state).toMatchObject({ kind: 'INVALID', message: STATEMENT_REFUSAL_TEXT[reason] });
      expect(JSON.stringify(state)).not.toContain('English');
    }
    answer = () => problem(403, 'FORBIDDEN', 'MEMBER_OF_CONTRACTOR');
    expect(await decide(form({}, APPROVE_TECHNICAL))).toMatchObject({
      kind: 'FORBIDDEN',
      reasons: ['MEMBER_OF_CONTRACTOR'],
    });
  });

  it('the approved-total cap is said as such', async () => {
    answer = () => problem(422, 'BUSINESS_RULE_VIOLATION', 'APPROVED_TOTAL_EXCEEDS_CAP');
    expect(await decide(form({}, APPROVE_TECHNICAL))).toMatchObject({
      kind: 'INVALID',
      message: STATEMENT_REFUSAL_TEXT.APPROVED_TOTAL_EXCEEDS_CAP,
    });
  });
});

describe('a submit', () => {
  it('sends only the version it showed, to …/submit', async () => {
    answer = () => json(200, SUBMITTED);
    await expect(
      decide(
        form(
          {},
          {
            ...APPROVE_TECHNICAL,
            command: 'SUBMIT',
            expectedVersion: 1,
            chain: null,
            stepOrder: null,
          },
        ),
      ),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/contracts/${CONTRACT_ID}/statements/${STATEMENT_ID}/submit`,
      body: { expectedVersion: 1 },
    });
  });
});

describe('a draft', () => {
  const DRAFT: StatementTarget = { command: 'DRAFT', contractId: CONTRACT_ID };

  it('an unreadable row is refused before anything is sent, the rows kept', async () => {
    const state = await submitStatementDraft(
      CONTRACT_ID,
      IDLE_STATEMENT_FORM,
      form({ [lineField(0, 'description')]: 'آسفالت', [lineField(0, 'amount')]: '12.5' }, DRAFT),
    );
    expect(state).toMatchObject({
      kind: 'INVALID',
      command: 'DRAFT',
      fieldErrors: { [lineField(0, 'amount')]: expect.any(String) },
    });
    expect(state.kind === 'INVALID' && state.rows[0]?.amount).toBe('12.5');
    expect(sent).toHaveLength(0);
  });

  it('confirmed: to the new statement, with its confirmation', async () => {
    answer = () => json(201, DRAFTED);
    await expect(
      submitStatementDraft(CONTRACT_ID, IDLE_STATEMENT_FORM, form(DRAFT_FIELDS, DRAFT)),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(sent[0]!.body).toEqual({
      lines: [{ description: 'آسفالت', amountMinor: '1100000000' }],
    });
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(url.pathname).toBe(`/contracts/${CONTRACT_ID}/statements/${DRAFTED.id}`);
    expect(readFlash(SESSION, url.searchParams.get('flash'), DRAFTED.id, ['DRAFT'])).toBe('DRAFT');
  });

  describe('sent and not confirmed', () => {
    async function unconfirmedDraft(): Promise<{ state: UnconfirmedStatement; data: FormData }> {
      answer = () => problem(503, 'UPSTREAM_UNAVAILABLE');
      const data = form(DRAFT_FIELDS, DRAFT);
      const state = (await submitStatementDraft(
        CONTRACT_ID,
        IDLE_STATEMENT_FORM,
        data,
      )) as UnconfirmedStatement;
      return { state, data };
    }

    /** The unconfirmed view's form: the kept lines, the kept key, the kept stamp. */
    function retryForm(state: UnconfirmedStatement): FormData {
      const data = new FormData();
      data.set(CSRF_FIELD, SESSION.csrfToken);
      data.set(SUBMISSION_FIELD, state.submissionId);
      data.set(REPLAY_FIELD, state.replay?.token ?? '');
      state.lines.forEach((line, index) => {
        data.set(lineField(index, 'description'), line.description);
        data.set(lineField(index, 'amount'), line.amountMinor);
        data.set(lineField(index, 'milestoneId'), line.milestoneId ?? '');
      });
      return data;
    }

    it('is unconfirmed, with the lines as sent, the key and the stamp', async () => {
      const { state, data } = await unconfirmedDraft();
      expect(state).toMatchObject({
        kind: 'UNCONFIRMED',
        command: 'DRAFT',
        submissionId: data.get(SUBMISSION_FIELD),
        lines: [{ description: 'آسفالت', amountMinor: '1100000000' }],
        replay: { token: data.get(REPLAY_FIELD) },
      });
    });

    it('a retry is the same key and the same body', async () => {
      const { state } = await unconfirmedDraft();
      answer = () => json(201, DRAFTED);
      await expect(submitStatementDraft(CONTRACT_ID, state, retryForm(state))).rejects.toThrow(
        'NEXT_REDIRECT',
      );
      expect(sent).toHaveLength(2);
      expect(sent[1]!.key).toBe(sent[0]!.key);
      expect(sent[1]!.body).toEqual(sent[0]!.body);
    });

    it('a refused retry proves nothing: the original request stays, with a note', async () => {
      const { state } = await unconfirmedDraft();
      answer = () => problem(422, 'BUSINESS_RULE_VIOLATION', 'CONTRACT_NOT_SIGNED');
      expect(await submitStatementDraft(CONTRACT_ID, state, retryForm(state))).toEqual({
        ...state,
        retryRefused: true,
      });
    });

    it('a retry with the session ended, or only unavailable', async () => {
      const { state } = await unconfirmedDraft();
      currentSession.mockResolvedValue(null);
      expect(await submitStatementDraft(CONTRACT_ID, state, retryForm(state))).toEqual({
        ...state,
        sessionEnded: true,
      });
      missingSessionReason.mockResolvedValue('SESSION_UNAVAILABLE');
      expect(await submitStatementDraft(CONTRACT_ID, state, retryForm(state))).toEqual({
        ...state,
        retryUnknown: true,
      });
    });

    it('a retry past the deadline is not sent, and the view becomes read-only for good', async () => {
      const { state } = await unconfirmedDraft();
      const late = retryForm(state);
      jest.useFakeTimers({ now: Date.now() + 2 * 60 * 60 * 1000 });
      try {
        expect(await submitStatementDraft(CONTRACT_ID, state, late)).toEqual({
          ...state,
          replay: null,
          viewOnly: true,
          replayExpired: true,
        });
      } finally {
        jest.useRealTimers();
      }
      expect(sent).toHaveLength(1);
    });
  });
});
