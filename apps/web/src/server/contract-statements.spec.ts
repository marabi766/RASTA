/**
 * @jest-environment node
 */
import {
  lineField,
  STATEMENT_REFUSAL_FALLBACK,
  STATEMENT_REFUSAL_TEXT,
} from '@/lib/statement-fields';
import { DRAFT_MESSAGES, parseDraft } from '@/lib/statement-draft';
import {
  CONTRACT_ID,
  CONTRACTOR,
  DRAFTED,
  EMPLOYER,
  SIGNED_CONTRACT,
  STATEMENT_ID,
  STRANGER,
  SUBMITTED,
  TECHNICALLY_APPROVED,
  approvedStep,
  step,
  tokenFor,
} from '@/test/statement-fixtures';

import {
  canDraftStatement,
  canSubmitStatement,
  decidableStepFor,
  fetchStatement,
  issueDraftStatement,
  issueStepCommand,
  nextStep,
  statementCallerOf,
  stepRequestBody,
  type Statement,
} from './contract-statements';
import type { WebSession } from './session';

/**
 * The statement module: what it reads, who it offers each form to — the copy
 * of contract-service's checks pinned by `contract-statements.contract.spec.ts`
 * — what each form sends, and what every answer becomes.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const SESSION = { accessToken: 'access-token-value' } as WebSession;
const SUBMISSION = 'sub_AAAAAAAAAAAAAAAAAAAA';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1', ...headers },
  });
}

function problem(status: number, code: string, details?: { path: string; code: string }[]) {
  return jsonResponse(status, {
    code,
    message: 'An English sentence the page must never show',
    correlationId: 'corr-1',
    ...(details ? { details: details.map((d) => ({ ...d, message: 'English again' })) } : {}),
  });
}

const caller = (org: string, roles: readonly string[], options = {}) =>
  statementCallerOf(tokenFor(org, roles, options));

describe('reading', () => {
  it('keeps money as decimal strings and refuses a float', async () => {
    const ok = jest.fn(async () => jsonResponse(200, SUBMITTED));
    jest.spyOn(globalThis, 'fetch').mockImplementation(ok as unknown as typeof fetch);
    const read = await fetchStatement(SESSION, CONTRACT_ID, STATEMENT_ID);
    expect(read).toEqual({ kind: 'OK', data: SUBMITTED });
    expect(typeof (read.kind === 'OK' && read.data.netMinor)).toBe('string');

    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((async () =>
        jsonResponse(200, { ...SUBMITTED, netMinor: 1425000000.5 })) as unknown as typeof fetch);
    expect((await fetchStatement(SESSION, CONTRACT_ID, STATEMENT_ID)).kind).toBe('MALFORMED');
  });

  it('a stranger’s statement and a missing one are the same NOT_FOUND', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((async () => problem(404, 'NOT_FOUND')) as unknown as typeof fetch);
    expect(await fetchStatement(SESSION, CONTRACT_ID, 'STM_SOMEONE_ELSES')).toEqual({
      kind: 'NOT_FOUND',
    });
    expect(await fetchStatement(SESSION, CONTRACT_ID, 'STM_MISSING')).toEqual({
      kind: 'NOT_FOUND',
    });
  });

  afterEach(() => jest.restoreAllMocks());
});

describe('who is offered the draft and submit forms', () => {
  const contractor = caller(CONTRACTOR, ['CONTRACTOR']);

  it('the contractor, with CONTRACTOR, on a signed contract', () => {
    expect(canDraftStatement(contractor, SIGNED_CONTRACT)).toBe(true);
    expect(canSubmitStatement(contractor, SIGNED_CONTRACT, DRAFTED)).toBe(true);
  });

  it.each([
    ['the employer, even its administrator', caller(EMPLOYER, ['ORGANIZATION_ADMIN'])],
    ['the contractor organization without CONTRACTOR', caller(CONTRACTOR, ['FLEET_MANAGER'])],
    ['a contractor with the oversight role too', caller(CONTRACTOR, ['CONTRACTOR', 'AUDITOR'])],
    [
      'a contractor who is also the platform administrator',
      caller(CONTRACTOR, ['CONTRACTOR'], { realm: ['SYSTEM_ADMIN'] }),
    ],
    ['a token naming no platform user', caller(CONTRACTOR, ['CONTRACTOR'], { uid: false })],
    ['a stranger organization with CONTRACTOR', caller(STRANGER, ['CONTRACTOR'])],
  ])('not %s', (_name, who) => {
    expect(canDraftStatement(who, SIGNED_CONTRACT)).toBe(false);
    expect(canSubmitStatement(who, SIGNED_CONTRACT, DRAFTED)).toBe(false);
  });

  it('not on a contract that is not signed', () => {
    for (const status of ['DRAFT', 'COMPLETED', 'CANCELLED', 'SETTLED']) {
      expect(canDraftStatement(contractor, { ...SIGNED_CONTRACT, status })).toBe(false);
    }
  });

  it('submit only a draft', () => {
    for (const status of ['SUBMITTED', 'TECHNICALLY_APPROVED', 'APPROVED', 'REJECTED']) {
      expect(canSubmitStatement(contractor, SIGNED_CONTRACT, { status })).toBe(false);
    }
  });

  it('nothing from a token that cannot be read', () => {
    const unreadable = statementCallerOf('not-a-token');
    expect(canDraftStatement(unreadable, SIGNED_CONTRACT)).toBe(false);
  });
});

describe('which step is offered for a decision', () => {
  const technical = caller(EMPLOYER, ['ORGANIZATION_ADMIN']);
  const financial = caller(EMPLOYER, ['FLEET_MANAGER']);

  it('the open chain’s next step, to its organization holding its role', () => {
    expect(decidableStepFor(technical, SUBMITTED, SIGNED_CONTRACT)).toMatchObject({
      chain: 'TECHNICAL',
      stepOrder: 1,
    });
    expect(decidableStepFor(financial, SUBMITTED, SIGNED_CONTRACT)).toBeNull();
    expect(decidableStepFor(financial, TECHNICALLY_APPROVED, SIGNED_CONTRACT)).toMatchObject({
      chain: 'FINANCIAL',
      stepOrder: 1,
    });
    expect(decidableStepFor(technical, TECHNICALLY_APPROVED, SIGNED_CONTRACT)).toBeNull();
  });

  it('a later step only once the earlier one is decided', () => {
    const twoSteps: Statement = {
      ...SUBMITTED,
      approvalChains: {
        ...SUBMITTED.approvalChains!,
        technical: {
          policyId: 'POL_T',
          policyVersion: 1,
          steps: [step(2, 'FLEET_MANAGER'), step(1, 'ORGANIZATION_ADMIN')],
        },
      },
    };
    expect(nextStep(twoSteps)?.stepOrder).toBe(1);
    expect(decidableStepFor(financial, twoSteps, SIGNED_CONTRACT)).toBeNull();
    const afterFirst: Statement = {
      ...twoSteps,
      approvalChains: {
        ...twoSteps.approvalChains!,
        technical: {
          policyId: 'POL_T',
          policyVersion: 1,
          steps: [step(2, 'FLEET_MANAGER'), approvedStep(1, 'ORGANIZATION_ADMIN')],
        },
      },
    };
    expect(decidableStepFor(financial, afterFirst, SIGNED_CONTRACT)).toMatchObject({
      chain: 'TECHNICAL',
      stepOrder: 2,
    });
  });

  it('an approver who is not a party, named by a step, with its role — without reading the contract', () => {
    const consultant = 'ORG-CNS-0001';
    const named: Statement = {
      ...SUBMITTED,
      approvalChains: {
        ...SUBMITTED.approvalChains!,
        technical: {
          policyId: 'POL_T',
          policyVersion: 1,
          steps: [step(1, 'ORGANIZATION_ADMIN', null, consultant)],
        },
      },
    };
    expect(decidableStepFor(caller(consultant, ['ORGANIZATION_ADMIN']), named, null)).toMatchObject(
      {
        chain: 'TECHNICAL',
      },
    );
  });

  it.each([
    ['the step’s organization without its role', caller(EMPLOYER, ['DRIVER'])],
    ['its role in another organization', caller(STRANGER, ['ORGANIZATION_ADMIN'])],
    ['the role with the oversight role too', caller(EMPLOYER, ['ORGANIZATION_ADMIN', 'AUDITOR'])],
    [
      'the platform administrator, even holding the role',
      caller(EMPLOYER, ['ORGANIZATION_ADMIN'], { realm: ['SYSTEM_ADMIN'] }),
    ],
    [
      'the platform administrator alone — no override here',
      caller(EMPLOYER, ['DRIVER'], { realm: ['SYSTEM_ADMIN'] }),
    ],
    ['the contractor', caller(CONTRACTOR, ['CONTRACTOR', 'ORGANIZATION_ADMIN'])],
    [
      'a member of the contractor’s organization acting for the employer (separation of duties)',
      caller(EMPLOYER, ['ORGANIZATION_ADMIN'], { memberships: [EMPLOYER, CONTRACTOR] }),
    ],
    ['a token naming no platform user', caller(EMPLOYER, ['ORGANIZATION_ADMIN'], { uid: false })],
  ])('not %s', (_name, who) => {
    expect(decidableStepFor(who, SUBMITTED, SIGNED_CONTRACT)).toBeNull();
  });

  it('nothing on a draft, an approved or a rejected statement, or a contract no longer signed', () => {
    for (const status of ['DRAFT', 'APPROVED', 'REJECTED']) {
      expect(decidableStepFor(technical, { ...SUBMITTED, status }, SIGNED_CONTRACT)).toBeNull();
    }
    expect(
      decidableStepFor(technical, SUBMITTED, { ...SIGNED_CONTRACT, status: 'COMPLETED' }),
    ).toBeNull();
  });
});

describe('the draft form, read', () => {
  const row = (description: string, amount: string, milestoneId = '') => ({
    description,
    amount,
    milestoneId,
  });

  it('skips empty rows, reads any digits, and sends decimal strings', () => {
    const parsed = parseDraft(
      [row('', ''), row('  آسفالت ', '۱٬۱۰۰٬۰۰۰٬۰۰۰', 'MST_1'), row('جدول', '400000000')],
      ['MST_1'],
    );
    expect(parsed).toEqual({
      ok: true,
      lines: [
        { description: 'آسفالت', amountMinor: '1100000000', milestoneId: 'MST_1' },
        { description: 'جدول', amountMinor: '400000000' },
      ],
      rows: [1, 2],
    });
  });

  it('refuses a zero, a fraction, a negative, a word and an amount past BIGINT', () => {
    for (const amount of ['0', '12.5', '-1', 'ده', '9223372036854775808']) {
      const parsed = parseDraft([row('کار', amount)], null);
      expect(parsed).toEqual({
        ok: false,
        fieldErrors: { [lineField(0, 'amount')]: DRAFT_MESSAGES.amount },
        message: null,
      });
    }
  });

  it('refuses a missing or overlong description and a bidi control', () => {
    expect(parseDraft([row('', '10')], null)).toMatchObject({ ok: false });
    expect(parseDraft([row('x'.repeat(501), '10')], null)).toMatchObject({ ok: false });
    expect(parseDraft([row('کار‮است', '10')], null)).toMatchObject({
      ok: false,
      fieldErrors: { [lineField(0, 'description')]: DRAFT_MESSAGES.characters },
    });
  });

  it('refuses a milestone that is not the contract’s, when it knows them', () => {
    expect(parseDraft([row('کار', '10', 'MST_OTHER')], ['MST_1'])).toMatchObject({ ok: false });
    expect(parseDraft([row('کار', '10', 'MST_OTHER')], null)).toMatchObject({ ok: true });
  });

  it('needs one line', () => {
    expect(parseDraft([row('', '')], null)).toEqual({
      ok: false,
      fieldErrors: {},
      message: DRAFT_MESSAGES.noLine,
    });
  });
});

describe('what a step command sends — from the stamp, never the form', () => {
  it('a submit is the version the page showed', () => {
    expect(
      stepRequestBody({ command: 'SUBMIT', expectedVersion: 4, chain: null, stepOrder: null }),
    ).toEqual({ expectedVersion: 4 });
  });

  it('a decision names its chain, step, decision and version', () => {
    expect(
      stepRequestBody({ command: 'REJECT', expectedVersion: 3, chain: 'FINANCIAL', stepOrder: 2 }),
    ).toEqual({ chain: 'FINANCIAL', stepOrder: 2, decision: 'REJECT', expectedVersion: 3 });
  });

  it('a binding that cannot carry its command carries nothing', () => {
    expect(
      stepRequestBody({ command: 'APPROVE', expectedVersion: 3, chain: null, stepOrder: null }),
    ).toBeNull();
    expect(
      stepRequestBody({ command: 'SUBMIT', expectedVersion: 3, chain: 'TECHNICAL', stepOrder: 1 }),
    ).toBeNull();
  });
});

describe('what every answer becomes', () => {
  const draft = (fetchImpl: jest.Mock) =>
    issueDraftStatement(
      SESSION,
      CONTRACT_ID,
      [{ description: 'آسفالت', amountMinor: '1100000000' }],
      [2],
      SUBMISSION,
      fetchImpl as unknown as typeof fetch,
    );
  const approve = (fetchImpl: jest.Mock) =>
    issueStepCommand(
      SESSION,
      CONTRACT_ID,
      STATEMENT_ID,
      'APPROVE',
      { chain: 'TECHNICAL', stepOrder: 1, decision: 'APPROVE', expectedVersion: 2 },
      SUBMISSION,
      fetchImpl as unknown as typeof fetch,
    );

  it('posts the draft with its key and no deduction, and confirms the new draft', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(201, DRAFTED));
    expect(await draft(fetchImpl)).toMatchObject({ kind: 'CREATED', data: { id: STATEMENT_ID } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://gateway.test:3000/v1/contracts/${CONTRACT_ID}/statements`);
    expect(new Headers(init.headers).get('idempotency-key')).toBe(SUBMISSION);
    expect(JSON.parse(String(init.body))).toEqual({
      lines: [{ description: 'آسفالت', amountMinor: '1100000000' }],
    });
  });

  it('posts a decision to …/decisions and confirms it only when the step shows it', async () => {
    const decided: Statement = {
      ...TECHNICALLY_APPROVED,
    };
    const fetchImpl = jest.fn(async () => jsonResponse(200, decided));
    expect(await approve(fetchImpl)).toMatchObject({ kind: 'CREATED' });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      `http://gateway.test:3000/v1/contracts/${CONTRACT_ID}/statements/${STATEMENT_ID}/decisions`,
    );
    // A 2xx that does not show the step approved is not a confirmation.
    expect(await approve(jest.fn(async () => jsonResponse(200, SUBMITTED)))).toEqual({
      kind: 'UNKNOWN_OUTCOME',
      correlationId: expect.any(String),
    });
  });

  it('separation of duties: said in fixed words, never the service’s', async () => {
    const separated = await approve(
      jest.fn(async () =>
        problem(422, 'BUSINESS_RULE_VIOLATION', [
          { path: 'decision', code: 'ALREADY_DECIDED_STATEMENT' },
        ]),
      ),
    );
    expect(separated).toMatchObject({
      kind: 'INVALID',
      message: STATEMENT_REFUSAL_TEXT.ALREADY_DECIDED_STATEMENT,
    });
    expect(JSON.stringify(separated)).not.toContain('English');

    const member = await approve(
      jest.fn(async () =>
        problem(403, 'FORBIDDEN', [{ path: 'decision', code: 'MEMBER_OF_CONTRACTOR' }]),
      ),
    );
    expect(member).toEqual({
      kind: 'FORBIDDEN',
      correlationId: expect.any(String),
      reasons: ['MEMBER_OF_CONTRACTOR'],
    });
  });

  it('a stale form (the statement moved) is a fixed conflict, not a decision', async () => {
    const stale = await approve(jest.fn(async () => problem(409, 'OPTIMISTIC_LOCK_FAILED')));
    expect(stale).toMatchObject({ kind: 'INVALID' });
    expect(stale.kind === 'INVALID' && stale.message).toMatch(/تغییر کرده است/);
  });

  it('a step decided at the same moment is said as such', async () => {
    const raced = await approve(
      jest.fn(async () => problem(409, 'CONFLICT', [{ path: 'decision', code: 'STEP_DECIDED' }])),
    );
    expect(raced).toMatchObject({ kind: 'INVALID', message: STATEMENT_REFUSAL_TEXT.STEP_DECIDED });
  });

  it('an unknown refusal is one fixed sentence', async () => {
    const odd = await approve(jest.fn(async () => problem(422, 'SOMETHING_NEW')));
    expect(odd).toMatchObject({ kind: 'INVALID', message: STATEMENT_REFUSAL_FALLBACK });
  });

  it('places a line’s field error on the form row it came from', async () => {
    const refused = await draft(
      jest.fn(async () =>
        problem(400, 'VALIDATION_FAILED', [{ path: 'lines.0.amountMinor', code: 'custom' }]),
      ),
    );
    expect(refused).toMatchObject({
      kind: 'INVALID',
      fieldErrors: { [lineField(2, 'amount')]: STATEMENT_REFUSAL_FALLBACK },
    });
  });

  it('a 5xx, a 504 and an in-flight 409 are unconfirmed, never "nothing happened"', async () => {
    expect(await draft(jest.fn(async () => problem(503, 'UPSTREAM_UNAVAILABLE')))).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
    expect(await draft(jest.fn(async () => problem(504, 'UPSTREAM_TIMEOUT')))).toMatchObject({
      kind: 'UNKNOWN_OUTCOME',
    });
    expect(await draft(jest.fn(async () => problem(409, 'CONFLICT', undefined)))).toMatchObject({
      kind: 'INVALID',
    });
    expect(
      await draft(
        jest.fn(async () =>
          jsonResponse(
            409,
            { code: 'CONFLICT', message: 'x', correlationId: 'c' },
            { 'retry-after': '1' },
          ),
        ),
      ),
    ).toMatchObject({ kind: 'IN_PROGRESS' });
  });

  it('a stranger’s contract is NOT_FOUND', async () => {
    expect(await draft(jest.fn(async () => problem(404, 'NOT_FOUND')))).toMatchObject({
      kind: 'NOT_FOUND',
    });
  });
});
