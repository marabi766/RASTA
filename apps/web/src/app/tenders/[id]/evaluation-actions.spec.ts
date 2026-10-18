/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { readFlash } from '@/server/flash';
import { mintOwnerStamp, type OwnerTarget } from '@/server/tender-owner-replay';
import { REPLAY_FIELD } from '@/lib/form-fields';
import {
  AWARD_REFUSAL_TEXT,
  JUSTIFICATION_FIELD,
  REASON_CODE_FIELD,
  REASON_TEXT_FIELD,
  scoreField,
} from '@/lib/tender-evaluation-fields';
import { OWNER_DONE, REASON_FIELD } from '@/lib/tender-owner-fields';
import { AWARD_PENDING_REQUEST, AWARD_RECORD, AWARD_STEP_ID } from '@/test/evaluation-fixtures';
import { OWNER, PENDING_REQUEST, TENDER_ID } from '@/test/owner-fixtures';

import {
  IDLE_OWNER_FORM,
  type OwnerFormState,
  type UnconfirmedOwnerCommand,
} from './owner-form-state';

/**
 * The evaluation's and the award's write path through the owner's action:
 * what each command sends — the bid, the revisions and an award's terms from
 * the stamp, only what was typed from the form — what each answer becomes,
 * and which unconfirmed command may be sent again. Against a fake
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

const BID = 'BID_A';
const SCORING = [
  { criterionCode: 'technical', maxScore: 10, passFail: false, expectedRevision: 2 },
  { criterionCode: 'compliance', maxScore: 1, passFail: true, expectedRevision: 0 },
];
const target = (
  command: OwnerTarget['command'],
  extra: Partial<OwnerTarget> = {},
): OwnerTarget => ({
  tenderId: TENDER_ID,
  command,
  approvalId: null,
  expectedVersion: null,
  bidId: BID,
  ...extra,
});
const QUALIFY = target('QUALIFY');
const DISQUALIFY = target('DISQUALIFY');
const SCORE = target('SCORE', { scoring: SCORING });
const EVALUATE = target('EVALUATE', { bidId: null });
const AWARD = target('AWARD', { award: { justificationRequired: true, execution: null } });
const EXECUTE = target('AWARD', {
  award: { justificationRequired: false, execution: { justification: 'آنچه موافقت شد' } },
});
const REJECT_AWARD = target('REJECT_AWARD', {
  bidId: null,
  approvalId: AWARD_STEP_ID,
  expectedVersion: 3,
});

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

const flashOf = () => {
  const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
  return readFlash(SESSION, url.searchParams.get('flash'), TENDER_ID, OWNER_DONE);
};
const scored = {
  bidId: BID,
  tenderId: TENDER_ID,
  evaluationId: 'EVL_1',
  evaluatorId: 'USR-1',
  recorded: [],
  unchanged: [],
  complete: true,
};

describe('what an evaluator’s command sends', () => {
  it('a score: the bid and the revisions the page read, the scores typed — in either digits — and the key', async () => {
    answer = () => json(200, scored);
    const data = form(
      {
        [scoreField('technical')]: '۸٫۵',
        [scoreField('compliance')]: '1',
        [scoreField('invented')]: '5',
        bidId: 'BID_OTHER',
      },
      SCORE,
    );
    await expect(send(data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: `http://gateway.test:3000/v1/tenders/${TENDER_ID}/bids/${BID}/scores`,
        key: data.get(SUBMISSION_FIELD),
        body: {
          scores: [
            { criterionCode: 'technical', scoreScaled: 850, expectedRevision: 2 },
            { criterionCode: 'compliance', scoreScaled: 100, expectedRevision: 0 },
          ],
        },
      },
    ]);
    expect(flashOf()).toBe('SCORE');
  });

  it('a score out of range, or none at all, is put back on the form unsent, as typed', async () => {
    expect(await send(form({ [scoreField('technical')]: '11' }, SCORE))).toMatchObject({
      kind: 'INVALID',
      command: 'SCORE',
      values: { [scoreField('technical')]: '11', [scoreField('compliance')]: '' },
      fieldErrors: { [scoreField('technical')]: expect.any(String) },
    });
    expect(await send(form({}, SCORE))).toMatchObject({ kind: 'INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('a qualification names the bid of the stamp; a disqualification its reasons, or nothing is sent', async () => {
    answer = () =>
      json(200, { bidId: BID, tenderId: TENDER_ID, decision: 'QUALIFIED', alreadyDecided: false });
    await expect(send(form({ bidId: 'BID_OTHER' }, QUALIFY))).rejects.toThrow('NEXT_REDIRECT');
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/tenders/${TENDER_ID}/bids/${BID}/qualification`,
      body: { decision: 'QUALIFIED' },
    });
    expect(flashOf()).toBe('QUALIFY');
    expect(await send(form({ [REASON_CODE_FIELD]: 'NON_RESPONSIVE' }, DISQUALIFY))).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { [REASON_TEXT_FIELD]: expect.any(String) },
    });
    expect(sent).toHaveLength(1);
    answer = () =>
      json(200, {
        bidId: BID,
        tenderId: TENDER_ID,
        decision: 'DISQUALIFIED',
        alreadyDecided: false,
      });
    await expect(
      send(
        form(
          { [REASON_CODE_FIELD]: 'NON_RESPONSIVE', [REASON_TEXT_FIELD]: ' مدارک ناقص ' },
          DISQUALIFY,
        ),
      ),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(sent[1]?.body).toEqual({
      decision: 'DISQUALIFIED',
      reasonCode: 'NON_RESPONSIVE',
      reasonText: 'مدارک ناقص',
    });
  });

  it('completing the evaluation names nothing', async () => {
    answer = () => json(200, { tenderId: TENDER_ID, status: 'EVALUATED', alreadyEvaluated: false });
    await expect(send(form({}, EVALUATE))).rejects.toThrow('NEXT_REDIRECT');
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/tenders/${TENDER_ID}/evaluate`,
      body: {},
    });
    expect(flashOf()).toBe('EVALUATE');
  });
});

describe('what an award sends', () => {
  it('a choice that needs a justification is not sent without one; with one, it asks for approval', async () => {
    expect(await send(form({ [JUSTIFICATION_FIELD]: '  ' }, AWARD))).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { [JUSTIFICATION_FIELD]: expect.any(String) },
    });
    expect(sent).toHaveLength(0);
    answer = () => json(202, AWARD_PENDING_REQUEST);
    await expect(send(form({ [JUSTIFICATION_FIELD]: ' زمان کوتاه‌تر ' }, AWARD))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/tenders/${TENDER_ID}/award`,
      body: { bidId: BID, justification: 'زمان کوتاه‌تر' },
    });
    expect(flashOf()).toBe('AWARD_REQUESTED');
  });

  it('executing the approved request repeats its justification, whatever the form posts', async () => {
    answer = () => json(200, { ...AWARD_RECORD, alreadyAwarded: false });
    await expect(send(form({ [JUSTIFICATION_FIELD]: 'چیز دیگری' }, EXECUTE))).rejects.toThrow(
      'NEXT_REDIRECT',
    );
    expect(sent[0]?.body).toEqual({ bidId: BID, justification: 'آنچه موافقت شد' });
    expect(flashOf()).toBe('AWARDED');
  });

  it('a winner refused by supplier-service is said in fixed words, and nothing is awarded', async () => {
    answer = () => problem(422, 'BUSINESS_RULE_VIOLATION', 'WINNER_NOT_ELIGIBLE', 'award');
    expect(await send(form({}, EXECUTE))).toMatchObject({
      kind: 'INVALID',
      message: AWARD_REFUSAL_TEXT.WINNER_NOT_ELIGIBLE,
    });
  });

  it('an award decision is a decision on its step; a rejection says why', async () => {
    expect(await send(form({}, REJECT_AWARD))).toMatchObject({ kind: 'INVALID' });
    expect(sent).toHaveLength(0);
    answer = () =>
      json(200, {
        id: AWARD_STEP_ID,
        tenderId: TENDER_ID,
        workflowKey: 'tender.award',
        status: 'REJECTED',
        authorityOrganizationId: OWNER,
        authorityRole: 'ORGANIZATION_ADMIN',
        version: 4,
      });
    await expect(
      send(form({ [REASON_FIELD]: 'رتبهٔ نخست بهتر است' }, REJECT_AWARD)),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(sent[0]).toMatchObject({
      url: `http://gateway.test:3000/v1/approvals/${AWARD_STEP_ID}/decision`,
      body: { expectedVersion: 3, decision: 'REJECT', reason: 'رتبهٔ نخست بهتر است' },
    });
    expect(flashOf()).toBe('REJECT_AWARD');
  });
});

describe('unconfirmed', () => {
  it('a lost award rejected meanwhile is never sent again: no second approval round', async () => {
    answer = () => problem(504, 'UPSTREAM_TIMEOUT');
    const data = form({ [JUSTIFICATION_FIELD]: 'زمان کوتاه‌تر' }, AWARD);
    const lost = (await send(data)) as UnconfirmedOwnerCommand;
    expect(lost).toMatchObject({
      command: 'AWARD',
      viewOnly: true,
      unrepeatable: true,
      replay: null,
      values: null,
    });
    // Were it sent again, the same key and choice would open a new round (202).
    answer = () => json(202, { ...AWARD_PENDING_REQUEST, id: 'TAR_AWARD_2', round: 2 });
    expect(await send(data, lost)).toEqual(lost);
    expect(sent).toHaveLength(1);
  });

  it('a score, unconfirmed, keeps what was typed and is sent again as it was: kept under its key', async () => {
    answer = () => problem(504, 'UPSTREAM_TIMEOUT');
    const data = form({ [scoreField('technical')]: '7' }, SCORE);
    const first = (await send(data)) as UnconfirmedOwnerCommand;
    expect(first).toMatchObject({
      kind: 'UNCONFIRMED',
      command: 'SCORE',
      values: { [scoreField('technical')]: '7', [scoreField('compliance')]: '' },
    });
    expect(first.viewOnly).toBeUndefined();
    answer = () => json(200, scored);
    await expect(send(data, first)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it('a qualification and the completion, unconfirmed, may be sent again: each answers its own repeat', async () => {
    for (const command of [QUALIFY, EVALUATE]) {
      sent = [];
      answer = () => problem(504, 'UPSTREAM_TIMEOUT');
      const data = form({}, command);
      const first = (await send(data)) as UnconfirmedOwnerCommand;
      expect(first.viewOnly).toBeUndefined();
      await send(data, first);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
    }
  });
});
