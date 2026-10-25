/**
 * @jest-environment node
 */
import { CSRF_FIELD } from '@/server/csrf';
import { SUBMISSION_FIELD, mintSubmissionId } from '@/server/submission';
import type { WebSession } from '@/server/session';
import { readFlash } from '@/server/flash';
import {
  BINDING_FIELD,
  mintOwnerStamp,
  ownerBindingText,
  type OwnerTarget,
} from '@/server/tender-owner-replay';
import {
  JUSTIFICATION_FIELD,
  REASON_CODE_FIELD,
  REASON_TEXT_FIELD,
} from '@/lib/tender-evaluation-fields';
import { REPLAY_FIELD } from '@/lib/form-fields';
import {
  OPENING_REFUSAL_TEXT,
  OWNER_CODE_TEXT,
  OWNER_DONE,
  OWNER_RESENT_NOTE,
  REASON_FIELD,
  REPEATABLE_OWNER_COMMANDS,
  ownerDoneText,
  UNREPEATABLE_OWNER_COMMANDS,
  type OwnerCommand,
} from '@/lib/tender-owner-fields';
import { APPROVAL_ID, OWNER, PENDING_REQUEST, PROPOSED_AT, TENDER_ID } from '@/test/owner-fixtures';

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
/** A withdrawal drawn while the proposal made at `PROPOSED_AT` stood. */
const WITHDRAW: OwnerTarget = { ...OPEN, command: 'WITHDRAW_PROPOSAL', proposedAt: PROPOSED_AT };

interface Sent {
  readonly url: string;
  readonly key: string | null;
  readonly body: unknown;
}
let sent: Sent[] = [];
/** The bytes of each request body, as sent (`sent[i].body` is their parse). */
let rawBodies: string[] = [];
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
  if (target) {
    data.set(REPLAY_FIELD, mintOwnerStamp(SESSION, target, submission).token);
    // The body a stamp binds by digest is posted beside it, as the page draws it.
    const binding = ownerBindingText(target);
    if (binding !== null) data.set(BINDING_FIELD, binding);
  }
  return data;
}

beforeEach(() => {
  sent = [];
  rawBodies = [];
  currentSession.mockResolvedValue(SESSION);
  missingSessionReason.mockResolvedValue('NO_SESSION');
  redirect.mockClear();
  answer = () => json(202, PENDING_REQUEST);
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ url, key: new Headers(init.headers).get('idempotency-key'), body });
    rawBodies.push(String(init.body ?? ''));
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
      values: { [REASON_FIELD]: 'کوتاه' },
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

  it('a withdrawal names the proposal its form was drawn with — from the stamp, whatever the form posts (PR-350 r1 F1)', async () => {
    answer = () => json(200, { tenderId: TENDER_ID, withdrawnProposal: 'USR-AUTHOR' });
    const data = form({ proposedAt: '2026-10-21T00:00:00.000Z' }, WITHDRAW);
    await expect(send(data)).rejects.toThrow('NEXT_REDIRECT');
    expect(sent).toEqual([
      {
        url: `http://gateway.test:3000/v1/tenders/${TENDER_ID}/open-bids/proposal/withdraw`,
        key: data.get(SUBMISSION_FIELD),
        body: { proposedAt: PROPOSED_AT },
      },
    ]);
    const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
    expect(
      readFlash(SESSION, url.searchParams.get('flash'), TENDER_ID, ['WITHDRAW_PROPOSAL']),
    ).toBe('WITHDRAW_PROPOSAL');
  });

  it('a withdrawal of a proposal replaced since is 409 PROPOSAL_SUPERSEDED, said in Persian; the same form sent again names the same proposal, never the newer one', async () => {
    // Someone withdrew this proposal and another was made since the page was drawn.
    answer = () => problem(409, 'CONFLICT', 'PROPOSAL_SUPERSEDED');
    const data = form({}, WITHDRAW);
    const refused = await send(data);
    expect(refused).toMatchObject({
      kind: 'INVALID',
      command: 'WITHDRAW_PROPOSAL',
      message: OPENING_REFUSAL_TEXT.PROPOSAL_SUPERSEDED,
    });
    expect(OPENING_REFUSAL_TEXT.PROPOSAL_SUPERSEDED).toMatch(/[\u0600-\u06FF]/);

    // Sent again — the same form, its key and its stamp: the proposal it was drawn with, read from
    // nowhere but the stamp (no read of the bids at submission).
    expect(await send(data, refused)).toMatchObject({ kind: 'INVALID' });
    expect(sent.map((request) => request.body)).toEqual([
      { proposedAt: PROPOSED_AT },
      { proposedAt: PROPOSED_AT },
    ]);
    expect(sent.every((request) => request.url.endsWith('/open-bids/proposal/withdraw'))).toBe(
      true,
    );
    expect(new Set(sent.map((request) => request.key))).toEqual(
      new Set([data.get(SUBMISSION_FIELD)]),
    );
  });

  it('a withdrawal form without a proposal, or one whose stamp predates the binding, is refused unsent', async () => {
    const unnamed = { ...OPEN, command: 'WITHDRAW_PROPOSAL' as const };
    expect(await send(form({ proposedAt: PROPOSED_AT }, unnamed))).toEqual({
      kind: 'REFUSED',
      reason: 'REPLAY',
    });
    expect(sent).toHaveLength(0);
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
  it('a decision whose answer was lost is view-only from the start: its reason is not kept, nothing is re-sent', async () => {
    answer = () => problem(504, 'UPSTREAM_TIMEOUT');
    const data = form({ [REASON_FIELD]: 'معیارها کامل نیست' }, REJECT);
    const first = (await send(data)) as UnconfirmedOwnerCommand;
    expect(first).toMatchObject({
      kind: 'UNCONFIRMED',
      command: 'REJECT',
      values: null,
      replay: null,
      viewOnly: true,
      unrepeatable: true,
    });
    expect(await send(data, first)).toEqual(first);
    expect(sent).toHaveLength(1);
  });

  it('every command the service keeps no result for — the decisions, a bid’s decision and the evaluation — unconfirmed, is view-only and never sent again', async () => {
    const bid = { ...OPEN, bidId: 'BID_1' };
    const step = { ...REJECT, approvalId: 'APR_AWARD' };
    const targets: Partial<Record<OwnerCommand, OwnerTarget>> = {
      GRANT: { ...REJECT, command: 'GRANT' },
      REJECT,
      QUALIFY: { ...bid, command: 'QUALIFY' },
      DISQUALIFY: { ...bid, command: 'DISQUALIFY' },
      EVALUATE: { ...OPEN, command: 'EVALUATE' },
      GRANT_AWARD: { ...step, command: 'GRANT_AWARD' },
      REJECT_AWARD: { ...step, command: 'REJECT_AWARD' },
    };
    const fields: Partial<Record<OwnerCommand, Record<string, string>>> = {
      REJECT: { [REASON_FIELD]: 'معیارها کامل نیست' },
      REJECT_AWARD: { [REASON_FIELD]: 'رتبهٔ نخست بهتر است' },
      DISQUALIFY: { [REASON_CODE_FIELD]: 'NON_RESPONSIVE', [REASON_TEXT_FIELD]: 'مدارک ناقص' },
    };
    expect(REPEATABLE_OWNER_COMMANDS).toEqual([
      'PUBLISH',
      'PROPOSE_OPENING',
      'OPEN_BIDS',
      'WITHDRAW_PROPOSAL',
      'AWARD',
      'SCORE',
    ]);
    expect([...UNREPEATABLE_OWNER_COMMANDS].sort()).toEqual(Object.keys(targets).sort());
    for (const command of UNREPEATABLE_OWNER_COMMANDS) {
      sent = [];
      answer = () => problem(504, 'UPSTREAM_TIMEOUT');
      const data = form(fields[command] ?? {}, targets[command]!);
      const first = (await send(data)) as UnconfirmedOwnerCommand;
      expect(first).toMatchObject({
        kind: 'UNCONFIRMED',
        command,
        submissionId: data.get(SUBMISSION_FIELD),
        values: null,
        replay: null,
        viewOnly: true,
        unrepeatable: true,
      });
      // Whatever the form posts again — the same key, a valid stamp — nothing is sent.
      expect(await send(data, first)).toEqual(first);
      expect(sent).toHaveLength(1);
    }
  });

  describe('the commands the service answers again under their key (task 060, PR 350)', () => {
    const bid = { ...OPEN, bidId: 'BID_1' };
    const AWARD: OwnerTarget = {
      ...bid,
      command: 'AWARD',
      award: { justificationRequired: true, execution: null },
    };
    const awardRequest = { ...PENDING_REQUEST, id: 'TAR_AWARD', workflowKey: 'tender.award' };

    interface KeyedCase {
      readonly name: string;
      readonly command: OwnerCommand;
      readonly target: OwnerTarget;
      /** What the form posts besides the stamp — never what is sent for the stamp's own part. */
      readonly fields: Record<string, string>;
      readonly path: string;
      readonly body: unknown;
      /** The first answer, replayed to the re-send. */
      readonly stored: () => Response;
      readonly flash: string;
    }
    const cases: readonly KeyedCase[] = [
      {
        name: 'publish, executed',
        command: 'PUBLISH',
        target: PUBLISH,
        fields: { expectedVersion: '99' },
        path: 'publish',
        body: { expectedVersion: 4 },
        stored: () => json(200, { id: TENDER_ID, status: 'PUBLISHED', version: 5 }),
        flash: 'PUBLISHED_RESENT',
      },
      {
        name: 'publish, a round asked for (a 202 rejected since is still said)',
        command: 'PUBLISH',
        target: PUBLISH,
        fields: {},
        path: 'publish',
        body: { expectedVersion: 4 },
        stored: () => json(202, PENDING_REQUEST),
        flash: 'REQUESTED_RESENT',
      },
      {
        name: 'propose the opening',
        command: 'PROPOSE_OPENING',
        target: { ...OPEN, command: 'PROPOSE_OPENING' },
        fields: {},
        path: 'open-bids/proposal',
        body: {},
        stored: () =>
          json(200, { tenderId: TENDER_ID, proposedBy: 'USR-AUTHOR', alreadyProposed: false }),
        flash: 'PROPOSE_OPENING_RESENT',
      },
      {
        name: 'open the bids',
        command: 'OPEN_BIDS',
        target: OPEN,
        fields: {},
        path: 'open-bids',
        body: {},
        stored: () =>
          json(200, {
            tenderId: TENDER_ID,
            status: 'EVALUATING',
            openedAt: PROPOSED_AT,
            bidCount: 2,
            alreadyOpened: false,
          }),
        flash: 'OPEN_BIDS_RESENT',
      },
      {
        name: 'withdraw the proposal (its signed proposedAt, whatever the form posts)',
        command: 'WITHDRAW_PROPOSAL',
        target: WITHDRAW,
        fields: { proposedAt: '2026-10-21T00:00:00.000Z' },
        path: 'open-bids/proposal/withdraw',
        body: { proposedAt: PROPOSED_AT },
        stored: () => json(200, { tenderId: TENDER_ID, withdrawnProposal: 'USR-AUTHOR' }),
        flash: 'WITHDRAW_PROPOSAL_RESENT',
      },
      {
        name: 'award, a round asked for',
        command: 'AWARD',
        target: AWARD,
        fields: { [JUSTIFICATION_FIELD]: 'کمترین قیمت واجد شرایط' },
        path: 'award',
        body: { bidId: 'BID_1', justification: 'کمترین قیمت واجد شرایط' },
        stored: () => json(202, awardRequest),
        flash: 'AWARD_REQUESTED_RESENT',
      },
    ];

    it.each([null, 'آنچه موافقت شد'])(
      'executing an approved award (approved justification %p): a lost answer keeps the binding, and the retry rebuilt from the returned state sends the same key and body',
      async (approved) => {
        const executes: OwnerTarget = {
          ...bid,
          command: 'AWARD',
          award: { justificationRequired: true, execution: { justification: approved } },
        };
        answer = () => problem(504, 'UPSTREAM_TIMEOUT');
        const data = form({}, executes);
        const lost = (await send(data)) as UnconfirmedOwnerCommand;
        expect(lost).toMatchObject({
          kind: 'UNCONFIRMED',
          command: 'AWARD',
          values: { [BINDING_FIELD]: data.get(BINDING_FIELD) },
        });
        expect(lost.viewOnly).toBeUndefined();

        // The retry form posts the stamp, the key and exactly the returned values.
        const retry = new FormData();
        retry.set(CSRF_FIELD, SESSION.csrfToken);
        retry.set(SUBMISSION_FIELD, lost.submissionId);
        retry.set(REPLAY_FIELD, lost.replay!.token);
        for (const [name, value] of Object.entries(lost.values ?? {})) retry.set(name, value);
        answer = () => json(202, awardRequest);
        await expect(send(retry, lost)).rejects.toThrow('NEXT_REDIRECT');
        const body =
          approved === null ? { bidId: 'BID_1' } : { bidId: 'BID_1', justification: approved };
        expect(sent.map((request) => request.body)).toEqual([body, body]);
        expect(new Set(sent.map((request) => request.key))).toEqual(
          new Set([data.get(SUBMISSION_FIELD)]),
        );
        expect(new Set(rawBodies).size).toBe(1);
      },
    );

    it('the commands are exactly the ones the service replays, plus the score', () => {
      expect([...new Set(cases.map((c) => c.command))].sort()).toEqual(
        REPEATABLE_OWNER_COMMANDS.filter((command) => command !== 'SCORE').sort(),
      );
    });

    it.each(cases)(
      '$name: a lost answer is sent again under the same key with the same bytes, and the replayed answer is said to be one',
      async ({ command, target, fields, path, body, stored, flash }) => {
        answer = () => problem(504, 'UPSTREAM_TIMEOUT');
        const data = form(fields, target);
        const lost = (await send(data)) as UnconfirmedOwnerCommand;
        expect(lost).toMatchObject({
          kind: 'UNCONFIRMED',
          command,
          submissionId: data.get(SUBMISSION_FIELD),
          replay: { token: data.get(REPLAY_FIELD) },
        });
        expect(lost.viewOnly).toBeUndefined();
        expect(lost.unrepeatable).toBeUndefined();

        // The re-send is lost too: still the same request, still re-sendable.
        const again = (await send(data, lost)) as UnconfirmedOwnerCommand;
        expect(again).toMatchObject({ kind: 'UNCONFIRMED', retryUnknown: true });
        expect(again.viewOnly).toBeUndefined();

        // The second re-send is answered with the first answer, replayed.
        answer = stored;
        await expect(send(data, again)).rejects.toThrow('NEXT_REDIRECT');
        expect(sent).toHaveLength(3);
        expect(sent.every((request) => request.url.endsWith(`/tenders/${TENDER_ID}/${path}`))).toBe(
          true,
        );
        expect(sent.map((request) => request.body)).toEqual([body, body, body]);
        expect(new Set(sent.map((request) => request.key))).toEqual(
          new Set([data.get(SUBMISSION_FIELD)]),
        );
        expect(new Set(rawBodies).size).toBe(1);

        const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
        const done = readFlash(SESSION, url.searchParams.get('flash'), TENDER_ID, OWNER_DONE);
        expect(done).toBe(flash);
        expect(ownerDoneText(done!).resent).toBe(true);
      },
    );

    it('a first send that is answered says nothing of a replay', async () => {
      answer = cases[0]!.stored;
      await expect(send(form({}, PUBLISH))).rejects.toThrow('NEXT_REDIRECT');
      const url = new URL(redirect.mock.calls[0]![0], 'http://portal.test');
      const done = readFlash(SESSION, url.searchParams.get('flash'), TENDER_ID, OWNER_DONE);
      expect(done).toBe('PUBLISHED');
      expect(ownerDoneText(done!).resent).toBe(false);
    });

    it('the replayed answer is a historical one: its fixed text says the current state comes from the page’s reads', () => {
      expect(OWNER_RESENT_NOTE).toMatch(/[؀-ۿ]/);
      expect(OWNER_RESENT_NOTE).toContain('خوانده‌های همین صفحه');
      expect(OWNER_RESENT_NOTE).toContain('وضعیت کنونی');
    });

    it.each(cases)(
      '$name: a different request under the key (409 IDEMPOTENCY_KEY_REUSED) is said in fixed Persian words, and nothing is claimed of the first',
      async ({ command, target, fields }) => {
        answer = () => problem(504, 'UPSTREAM_TIMEOUT');
        const data = form(fields, target);
        const lost = (await send(data)) as UnconfirmedOwnerCommand;
        answer = () => problem(409, 'IDEMPOTENCY_KEY_REUSED');
        const refused = await send(data, lost);
        expect(refused).toMatchObject({
          kind: 'UNCONFIRMED',
          command,
          retryRefused: true,
          retryRefusal: OWNER_CODE_TEXT.IDEMPOTENCY_KEY_REUSED,
        });
        expect(OWNER_CODE_TEXT.IDEMPOTENCY_KEY_REUSED).toMatch(/[؀-ۿ]/);
        expect(OWNER_CODE_TEXT.IDEMPOTENCY_KEY_REUSED).not.toContain('An English');
      },
    );

    it('a re-sent withdrawal of a proposal replaced since is 409 PROPOSAL_SUPERSEDED, in fixed words', async () => {
      answer = () => problem(504, 'UPSTREAM_TIMEOUT');
      const data = form({}, WITHDRAW);
      const lost = (await send(data)) as UnconfirmedOwnerCommand;
      answer = () => problem(409, 'CONFLICT', 'PROPOSAL_SUPERSEDED');
      expect(await send(data, lost)).toMatchObject({
        kind: 'UNCONFIRMED',
        retryRefused: true,
        retryRefusal: OPENING_REFUSAL_TEXT.PROPOSAL_SUPERSEDED,
      });
      expect(sent.map((request) => request.body)).toEqual([
        { proposedAt: PROPOSED_AT },
        { proposedAt: PROPOSED_AT },
      ]);
    });

    it('an in-flight first send (409 CONFLICT with Retry-After) is unconfirmed and re-sendable', async () => {
      answer = () =>
        new Response(JSON.stringify({ code: 'CONFLICT', message: 'x', correlationId: 'c' }), {
          status: 409,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        });
      const lost = await send(form({}, OPEN));
      expect(lost).toMatchObject({ kind: 'UNCONFIRMED', command: 'OPEN_BIDS' });
      expect((lost as UnconfirmedOwnerCommand).viewOnly).toBeUndefined();
    });
  });
});
