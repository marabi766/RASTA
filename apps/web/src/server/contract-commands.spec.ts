/**
 * @jest-environment node
 */
import {
  CONTRACT_CODE_TEXT,
  CONTRACT_REFUSAL_FALLBACK,
  CONTRACT_REFUSAL_TEXT,
} from '@/lib/contract-command-fields';
import {
  AMENDMENT_ID,
  CONTRACT_ID,
  CONTRACTOR,
  CONTRACTOR_SIGNED,
  DRAFT,
  EMPLOYER,
  MILESTONE,
  MILESTONE_ID,
  PROPOSED,
  SIGNED,
  SIGNING_POLICY,
  STRANGER,
  policyView,
  tokenFor,
} from '@/test/contract-command-fixtures';

import {
  amendmentSignableSide,
  canCancelContract,
  canChangeMilestone,
  canPlanMilestone,
  canProposeAmendment,
  commandRequest,
  contractCallerOf,
  MAX_POLICY_PAGES,
  fetchSigningPolicy,
  issueContractCommand,
  mightSignAsEmployer,
  signableSide,
  signingRoleUnder,
  type CommandBinding,
  type SigningAuthorityView,
} from './contract-commands';
import type { WebSession } from './session';

/**
 * The contract commands' server side: who is drawn which form — each helper a
 * copy of one of contract-service's checks, every branch here — what each
 * command sends, and which answers confirm it.
 */

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const ENV = {
  WEB_CONTRACT_CANCEL_ROLES: ['ORGANIZATION_ADMIN'],
  WEB_CONTRACT_AMENDMENT_ROLES: ['ORGANIZATION_ADMIN'],
  WEB_CONTRACT_MILESTONE_ROLES: ['ORGANIZATION_ADMIN'],
  WEB_CONTRACT_CANCEL_AFTER_SIGNATURE: false,
};

const employer = (roles: readonly string[] = ['ORGANIZATION_ADMIN'], options = {}) =>
  contractCallerOf(tokenFor(EMPLOYER, roles, options));
const contractor = (roles: readonly string[] = ['CONTRACTOR'], options = {}) =>
  contractCallerOf(tokenFor(CONTRACTOR, roles, options));
const IN_FORCE: SigningAuthorityView = { policy: SIGNING_POLICY };
const NONE: SigningAuthorityView = { policy: null };

describe('who may sign the contract — ContractService.sign', () => {
  it('the contractor, with CONTRACTOR, on a draft its side has not signed', () => {
    expect(signableSide(contractor(), DRAFT, NONE)).toBe('CONTRACTOR');
    expect(signableSide(contractor(['FLEET_MANAGER']), DRAFT, NONE)).toBeNull();
    expect(signableSide(contractor(), CONTRACTOR_SIGNED, NONE)).toBeNull();
  });

  it('the employer, with a role the signing policy in force names for the employer itself', () => {
    expect(signableSide(employer(), DRAFT, IN_FORCE)).toBe('EMPLOYER');
    expect(signableSide(employer(['FLEET_MANAGER']), DRAFT, IN_FORCE)).toBeNull();
    // No policy in force: nobody signs for the employer (SIGNATURE_POLICY_REQUIRED).
    expect(signableSide(employer(), DRAFT, NONE)).toBeNull();
    // Not read: nothing is guessed.
    expect(signableSide(employer(), DRAFT, 'UNREAD')).toBeNull();
    // A step naming another organization is not the employer's authority.
    const elsewhere = {
      policy: {
        ...SIGNING_POLICY,
        steps: [{ authorityOrganizationId: STRANGER, authorityRole: 'ORGANIZATION_ADMIN' }],
      },
    };
    expect(signableSide(employer(), DRAFT, elsewhere)).toBeNull();
    expect(signableSide(employer(), CONTRACTOR_SIGNED, IN_FORCE)).toBe('EMPLOYER');
    expect(
      signableSide(
        employer(),
        { ...DRAFT, employerSignedAt: '2026-10-02T08:00:00.000Z' },
        IN_FORCE,
      ),
    ).toBeNull();
  });

  it('only a draft', () => {
    expect(signableSide(contractor(), { ...DRAFT, status: 'SIGNED' }, NONE)).toBeNull();
    expect(signableSide(employer(), { ...DRAFT, status: 'CANCELLED' }, IN_FORCE)).toBeNull();
  });

  it('never a member of both parties, whichever side it acts for (MEMBER_OF_BOTH_PARTIES)', () => {
    const both = { memberships: [EMPLOYER, CONTRACTOR] };
    expect(signableSide(employer(['ORGANIZATION_ADMIN'], both), DRAFT, IN_FORCE)).toBeNull();
    expect(signableSide(contractor(['CONTRACTOR'], both), DRAFT, NONE)).toBeNull();
  });

  it('never the platform administrator, the oversight role, a token with no platform user, or a stranger', () => {
    expect(
      signableSide(employer(['ORGANIZATION_ADMIN'], { realm: ['SYSTEM_ADMIN'] }), DRAFT, IN_FORCE),
    ).toBeNull();
    expect(signableSide(employer(['ORGANIZATION_ADMIN', 'AUDITOR']), DRAFT, IN_FORCE)).toBeNull();
    expect(
      signableSide(employer(['ORGANIZATION_ADMIN'], { uid: false }), DRAFT, IN_FORCE),
    ).toBeNull();
    expect(
      signableSide(contractCallerOf(tokenFor(STRANGER, ['ORGANIZATION_ADMIN'])), DRAFT, IN_FORCE),
    ).toBeNull();
    expect(signableSide(contractCallerOf('not-a-token'), DRAFT, IN_FORCE)).toBeNull();
  });

  it('signingRoleUnder: the first step for the governed organization whose role is held', () => {
    expect(signingRoleUnder(SIGNING_POLICY, ['FLEET_MANAGER', 'ORGANIZATION_ADMIN'])).toBe(
      'ORGANIZATION_ADMIN',
    );
    expect(signingRoleUnder(SIGNING_POLICY, ['FLEET_MANAGER'])).toBeNull();
  });

  it('the policy is read only for someone who might sign for the employer', () => {
    expect(mightSignAsEmployer(employer(['FLEET_MANAGER']), DRAFT)).toBe(true);
    expect(mightSignAsEmployer(contractor(), DRAFT)).toBe(false);
    expect(
      mightSignAsEmployer(
        employer(['ORGANIZATION_ADMIN'], { memberships: [EMPLOYER, CONTRACTOR] }),
        DRAFT,
      ),
    ).toBe(false);
    expect(mightSignAsEmployer(employer(['ORGANIZATION_ADMIN'], { uid: false }), DRAFT)).toBe(
      false,
    );
  });
});

describe('who may cancel — ContractService.cancel', () => {
  it('the employer, with a role CONTRACT_CANCEL_ROLES names, on an unsigned draft', () => {
    expect(canCancelContract(employer(), DRAFT, ENV)).toBe(true);
    expect(canCancelContract(employer(['FLEET_MANAGER']), DRAFT, ENV)).toBe(false);
    expect(canCancelContract(contractor(['CONTRACTOR', 'ORGANIZATION_ADMIN']), DRAFT, ENV)).toBe(
      false,
    );
    expect(canCancelContract(employer(), DRAFT, { ...ENV, WEB_CONTRACT_CANCEL_ROLES: [] })).toBe(
      false,
    );
  });

  it('not once a side has signed — unless CONTRACT_CANCEL_AFTER_SIGNATURE (SIGNATURE_RECORDED)', () => {
    expect(canCancelContract(employer(), CONTRACTOR_SIGNED, ENV)).toBe(false);
    expect(
      canCancelContract(employer(), CONTRACTOR_SIGNED, {
        ...ENV,
        WEB_CONTRACT_CANCEL_AFTER_SIGNATURE: true,
      }),
    ).toBe(true);
  });

  it('only a draft, and never the platform administrator', () => {
    expect(
      canCancelContract(employer(), SIGNED, { ...ENV, WEB_CONTRACT_CANCEL_AFTER_SIGNATURE: true }),
    ).toBe(false);
    expect(
      canCancelContract(employer(['ORGANIZATION_ADMIN'], { realm: ['SYSTEM_ADMIN'] }), DRAFT, ENV),
    ).toBe(false);
  });
});

describe('amendments — AmendmentService', () => {
  it('the employer proposes, with a role CONTRACT_AMENDMENT_ROLES names, on a signed contract', () => {
    expect(canProposeAmendment(employer(), SIGNED, ENV)).toBe(true);
    expect(canProposeAmendment(employer(), DRAFT, ENV)).toBe(false);
    expect(canProposeAmendment(contractor(), SIGNED, ENV)).toBe(false);
    expect(canProposeAmendment(employer(['FLEET_MANAGER']), SIGNED, ENV)).toBe(false);
    expect(
      canProposeAmendment(employer(), SIGNED, {
        ...ENV,
        WEB_CONTRACT_AMENDMENT_ROLES: ['FLEET_MANAGER'],
      }),
    ).toBe(false);
  });

  it('either side signs a proposed amendment of a signed contract, by the contract’s own machinery', () => {
    expect(amendmentSignableSide(employer(), SIGNED, PROPOSED, IN_FORCE)).toBe('EMPLOYER');
    expect(amendmentSignableSide(employer(), SIGNED, PROPOSED, NONE)).toBeNull();
    expect(amendmentSignableSide(contractor(), SIGNED, PROPOSED, NONE)).toBe('CONTRACTOR');
    expect(amendmentSignableSide(contractor(['FLEET_MANAGER']), SIGNED, PROPOSED, NONE)).toBeNull();
  });

  it('not a side that has signed, not an effective one, not on a contract that is not signed', () => {
    const employerSigned = { ...PROPOSED, employerSignedAt: '2026-10-04T08:00:00.000Z' };
    expect(amendmentSignableSide(employer(), SIGNED, employerSigned, IN_FORCE)).toBeNull();
    expect(amendmentSignableSide(contractor(), SIGNED, employerSigned, NONE)).toBe('CONTRACTOR');
    expect(
      amendmentSignableSide(contractor(), SIGNED, { ...PROPOSED, status: 'EFFECTIVE' }, NONE),
    ).toBeNull();
    expect(
      amendmentSignableSide(contractor(), { ...SIGNED, status: 'COMPLETED' }, PROPOSED, NONE),
    ).toBeNull();
    expect(
      amendmentSignableSide(
        contractor(['CONTRACTOR'], { memberships: [EMPLOYER, CONTRACTOR] }),
        SIGNED,
        PROPOSED,
        NONE,
      ),
    ).toBeNull();
  });
});

describe('milestones — MilestoneService', () => {
  it('the employer plans, with a role CONTRACT_MILESTONE_ROLES names, on a signed contract', () => {
    expect(canPlanMilestone(employer(), SIGNED, ENV)).toBe(true);
    expect(canPlanMilestone(employer(), DRAFT, ENV)).toBe(false);
    expect(canPlanMilestone(contractor(), SIGNED, ENV)).toBe(false);
    expect(canPlanMilestone(employer(['FLEET_MANAGER']), SIGNED, ENV)).toBe(false);
  });

  it('changes one no statement refers to (MILESTONE_REFERENCED)', () => {
    expect(canChangeMilestone(employer(), SIGNED, MILESTONE, ENV)).toBe(true);
    expect(canChangeMilestone(employer(), SIGNED, { ...MILESTONE, referenced: true }, ENV)).toBe(
      false,
    );
    expect(canChangeMilestone(contractor(), SIGNED, MILESTONE, ENV)).toBe(false);
  });
});

const bind = (
  overrides: Partial<CommandBinding> & Pick<CommandBinding, 'command'>,
): CommandBinding => ({
  subjectId: null,
  expectedVersion: 3,
  side: null,
  ...overrides,
});

describe('what each command sends', () => {
  const base = `/v1/contracts/${CONTRACT_ID}`;

  it('a signature: the version the page showed, for the side it was drawn for', () => {
    expect(commandRequest(CONTRACT_ID, bind({ command: 'SIGN', side: 'EMPLOYER' }), null)).toEqual({
      method: 'POST',
      path: `${base}/sign`,
      body: { expectedVersion: 3 },
    });
    expect(commandRequest(CONTRACT_ID, bind({ command: 'SIGN' }), null)).toBeNull();
    expect(
      commandRequest(
        CONTRACT_ID,
        bind({
          command: 'SIGN_AMENDMENT',
          subjectId: AMENDMENT_ID,
          side: 'CONTRACTOR',
          expectedVersion: 1,
        }),
        null,
      ),
    ).toEqual({
      method: 'POST',
      path: `${base}/amendments/${AMENDMENT_ID}/sign`,
      body: { expectedVersion: 1 },
    });
    expect(
      commandRequest(CONTRACT_ID, bind({ command: 'SIGN_AMENDMENT', side: 'CONTRACTOR' }), null),
    ).toBeNull();
  });

  it('a cancellation: the reason, the note when there is one, and the version', () => {
    expect(
      commandRequest(CONTRACT_ID, bind({ command: 'CANCEL' }), {
        reasonCode: 'OTHER',
        note: 'یادداشت',
      }),
    ).toEqual({
      method: 'POST',
      path: `${base}/cancel`,
      body: { reasonCode: 'OTHER', note: 'یادداشت', expectedVersion: 3 },
    });
    expect(
      commandRequest(CONTRACT_ID, bind({ command: 'CANCEL' }), { reasonCode: 'OTHER' })?.body,
    ).toEqual({
      reasonCode: 'OTHER',
      expectedVersion: 3,
    });
    expect(commandRequest(CONTRACT_ID, bind({ command: 'CANCEL' }), null)).toBeNull();
    expect(
      commandRequest(CONTRACT_ID, bind({ command: 'CANCEL', expectedVersion: null }), {
        reasonCode: 'OTHER',
      }),
    ).toBeNull();
  });

  it('a proposal: the amount as a decimal string, the reason and the contract’s version', () => {
    const input = { deltaMinor: '2000000', reasonCode: 'SCOPE_CHANGE', reasonText: 'متن' };
    expect(commandRequest(CONTRACT_ID, bind({ command: 'PROPOSE_AMENDMENT' }), input)).toEqual({
      method: 'POST',
      path: `${base}/amendments`,
      body: { ...input, expectedVersion: 3 },
    });
    expect(
      commandRequest(CONTRACT_ID, bind({ command: 'PROPOSE_AMENDMENT' }), { reasonCode: 'OTHER' }),
    ).toBeNull();
  });

  it('a plan takes no version and leaves an empty share out; a change sends every field, a cleared share as null', () => {
    const input = { title: 'فاز', plannedDate: '2026-12-20', plannedShareBp: null };
    expect(
      commandRequest(
        CONTRACT_ID,
        bind({ command: 'PLAN_MILESTONE', expectedVersion: null }),
        input,
      ),
    ).toEqual({
      method: 'POST',
      path: `${base}/milestones`,
      body: { title: 'فاز', plannedDate: '2026-12-20' },
    });
    expect(commandRequest(CONTRACT_ID, bind({ command: 'PLAN_MILESTONE' }), input)).toBeNull();
    expect(
      commandRequest(CONTRACT_ID, bind({ command: 'PLAN_MILESTONE', expectedVersion: null }), {
        ...input,
        plannedShareBp: 2550,
      })?.body,
    ).toEqual({ title: 'فاز', plannedDate: '2026-12-20', plannedShareBp: 2550 });
    expect(
      commandRequest(
        CONTRACT_ID,
        bind({ command: 'CHANGE_MILESTONE', subjectId: MILESTONE_ID, expectedVersion: 1 }),
        input,
      ),
    ).toEqual({
      method: 'PATCH',
      path: `${base}/milestones/${MILESTONE_ID}`,
      body: { title: 'فاز', plannedDate: '2026-12-20', plannedShareBp: null, expectedVersion: 1 },
    });
    expect(
      commandRequest(CONTRACT_ID, bind({ command: 'CHANGE_MILESTONE', expectedVersion: 1 }), input),
    ).toBeNull();
  });
});

const SESSION = {
  subject: 'user-1',
  username: 'employer',
  organizationId: EMPLOYER,
  accessToken: 'access-token-value',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf',
  issuedAt: 1_900_000_000,
} satisfies WebSession;

let calls: { url: string; method: string; body: unknown }[] = [];
let reply: (url: string) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr-1' },
  });
}

function refusal(status: number, code: string, reason?: string): Response {
  return json(status, {
    code,
    message: 'An English sentence never shown',
    correlationId: 'corr-1',
    ...(reason ? { details: [{ path: 'signature', code: reason, message: 'English' }] } : {}),
  });
}

beforeEach(() => {
  calls = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return reply(url);
  }) as unknown as typeof fetch);
});

afterEach(() => jest.restoreAllMocks());

describe('the signing policy in force', () => {
  const page = (items: unknown[], hasMore = false) =>
    json(200, { items, nextCursor: hasMore ? 'c' : null, hasMore });

  it('asks for the employer’s ACTIVE contract.signature policies and keeps the one that governs it', async () => {
    reply = () =>
      page([
        policyView({ ...SIGNING_POLICY, id: 'POL_WRITTEN', organizationId: STRANGER }),
        policyView(),
      ]);
    const read = await fetchSigningPolicy(SESSION, EMPLOYER);
    expect(read).toEqual({ kind: 'OK', data: SIGNING_POLICY });
    expect(calls[0]?.url).toBe(
      'http://gateway.test:3000/v1/contract-approval-policies?workflowKey=contract.signature&status=ACTIVE&limit=200',
    );
  });

  it('none in force is an answer only once the last page is read', async () => {
    reply = () => page([]);
    expect(await fetchSigningPolicy(SESSION, EMPLOYER)).toEqual({ kind: 'OK', data: null });
  });

  /** Page n (from 1) of a list whose governing policy, if any, is on page `governingOn`. */
  const pages =
    (count: number, governingOn: number | null) =>
    (url: string): Response => {
      const cursor = new URL(url).searchParams.get('cursor');
      const n = cursor === null ? 1 : Number(cursor.replace('page-', ''));
      const written = Array.from({ length: 3 }, (_, i) =>
        policyView({ ...SIGNING_POLICY, id: `POL_W_${n}_${i}`, organizationId: STRANGER }),
      );
      const items = n === governingOn ? [...written, policyView()] : written;
      const more = n < count;
      return json(200, { items, nextCursor: more ? `page-${n + 1}` : null, hasMore: more });
    };

  it('follows the pages to the policy that governs the employer, beyond the first (review r1, 1)', async () => {
    reply = pages(5, 3);
    expect(await fetchSigningPolicy(SESSION, EMPLOYER)).toEqual({
      kind: 'OK',
      data: SIGNING_POLICY,
    });
    expect(calls.map((call) => new URL(call.url).searchParams.get('cursor'))).toEqual([
      null,
      'page-2',
      'page-3',
    ]);
  });

  it('says none only after every page; a list longer than the bound is incomplete, never none', async () => {
    reply = pages(4, null);
    expect(await fetchSigningPolicy(SESSION, EMPLOYER)).toEqual({ kind: 'OK', data: null });
    expect(calls).toHaveLength(4);
    calls = [];
    reply = pages(MAX_POLICY_PAGES + 1, MAX_POLICY_PAGES + 1);
    expect((await fetchSigningPolicy(SESSION, EMPLOYER)).kind).toBe('INCOMPLETE');
    expect(calls).toHaveLength(MAX_POLICY_PAGES);
  });

  it('more with no cursor, or a cursor back to a page already read, is incomplete', async () => {
    reply = () => json(200, { items: [], nextCursor: null, hasMore: true });
    expect((await fetchSigningPolicy(SESSION, EMPLOYER)).kind).toBe('INCOMPLETE');
    reply = () => json(200, { items: [], nextCursor: 'same', hasMore: true });
    expect((await fetchSigningPolicy(SESSION, EMPLOYER)).kind).toBe('INCOMPLETE');
  });

  it('a later page that fails fails the read', async () => {
    reply = (url) =>
      new URL(url).searchParams.get('cursor') === null
        ? json(200, { items: [], nextCursor: 'page-2', hasMore: true })
        : refusal(503, 'SERVICE_UNAVAILABLE');
    expect((await fetchSigningPolicy(SESSION, EMPLOYER)).kind).toBe('UNAVAILABLE');
  });

  it('a refusal or a failure is not an answer', async () => {
    reply = () => refusal(403, 'INSUFFICIENT_ROLE');
    expect((await fetchSigningPolicy(SESSION, EMPLOYER)).kind).toBe('FORBIDDEN');
    reply = () => refusal(503, 'SERVICE_UNAVAILABLE');
    expect((await fetchSigningPolicy(SESSION, EMPLOYER)).kind).toBe('UNAVAILABLE');
    reply = () => json(200, { items: 'nope' });
    expect((await fetchSigningPolicy(SESSION, EMPLOYER)).kind).toBe('MALFORMED');
  });
});

describe('which answers confirm a command', () => {
  const send = (binding: CommandBinding, input: Parameters<typeof commandRequest>[2]) =>
    issueContractCommand(
      SESSION,
      commandRequest(CONTRACT_ID, binding, input)!,
      CONTRACT_ID,
      binding,
      input,
      'sub_AAAAAAAAAAAAAAAA',
    );

  it('a signature, only when the side it was for shows signed', async () => {
    const binding = bind({ command: 'SIGN', side: 'CONTRACTOR', expectedVersion: 1 });
    reply = () => json(200, CONTRACTOR_SIGNED);
    expect((await send(binding, null)).kind).toBe('CREATED');
    reply = () => json(200, DRAFT);
    expect((await send(binding, null)).kind).toBe('UNKNOWN_OUTCOME');
    reply = () => json(200, { ...CONTRACTOR_SIGNED, id: 'CTR_OTHER' });
    expect((await send(binding, null)).kind).toBe('UNKNOWN_OUTCOME');
  });

  it('a cancellation, only as cancelled for the reason sent', async () => {
    const binding = bind({ command: 'CANCEL', expectedVersion: 1 });
    reply = () =>
      json(200, { ...DRAFT, status: 'CANCELLED', cancelReasonCode: 'OTHER', version: 2 });
    expect((await send(binding, { reasonCode: 'OTHER' })).kind).toBe('CREATED');
    expect((await send(binding, { reasonCode: 'AWARD_ERROR' })).kind).toBe('UNKNOWN_OUTCOME');
  });

  it('an amendment and its signature, only as sent and as signed', async () => {
    const input = {
      deltaMinor: '2000000',
      reasonCode: 'SCOPE_CHANGE',
      reasonText: 'افزایش محدودهٔ کار',
    };
    reply = () => json(201, PROPOSED);
    expect((await send(bind({ command: 'PROPOSE_AMENDMENT' }), input)).kind).toBe('CREATED');
    expect(
      (await send(bind({ command: 'PROPOSE_AMENDMENT' }), { ...input, deltaMinor: '3' })).kind,
    ).toBe('UNKNOWN_OUTCOME');
    const signing = bind({
      command: 'SIGN_AMENDMENT',
      subjectId: AMENDMENT_ID,
      side: 'EMPLOYER',
      expectedVersion: 1,
    });
    reply = () => json(200, { ...PROPOSED, employerSignedAt: '2026-10-04T08:00:00.000Z' });
    expect((await send(signing, null)).kind).toBe('CREATED');
    reply = () => json(200, PROPOSED);
    expect((await send(signing, null)).kind).toBe('UNKNOWN_OUTCOME');
  });

  it('a milestone, only as sent — the change by PATCH', async () => {
    const input = { title: MILESTONE.title, plannedDate: '2026-12-20', plannedShareBp: 2550 };
    reply = () => json(201, MILESTONE);
    expect(
      (await send(bind({ command: 'PLAN_MILESTONE', expectedVersion: null }), input)).kind,
    ).toBe('CREATED');
    expect(
      (
        await send(bind({ command: 'PLAN_MILESTONE', expectedVersion: null }), {
          ...input,
          plannedShareBp: null,
        })
      ).kind,
    ).toBe('UNKNOWN_OUTCOME');
    const change = bind({
      command: 'CHANGE_MILESTONE',
      subjectId: MILESTONE_ID,
      expectedVersion: 1,
    });
    reply = () => json(200, { ...MILESTONE, version: 2 });
    expect((await send(change, input)).kind).toBe('CREATED');
    expect(calls.at(-1)?.method).toBe('PATCH');
    reply = () => json(200, { ...MILESTONE, id: 'MST_OTHER' });
    expect((await send(change, input)).kind).toBe('UNKNOWN_OUTCOME');
  });

  it('refusals in fixed words — by closed reason, by code, else one sentence; a 5xx is unknown', async () => {
    const binding = bind({ command: 'SIGN', side: 'EMPLOYER', expectedVersion: 1 });
    reply = () => refusal(422, 'BUSINESS_RULE_VIOLATION', 'SIGNATURE_POLICY_REQUIRED');
    expect(await send(binding, null)).toMatchObject({
      kind: 'INVALID',
      message: CONTRACT_REFUSAL_TEXT.SIGNATURE_POLICY_REQUIRED,
    });
    reply = () => refusal(403, 'FORBIDDEN', 'SAME_PERSON_BOTH_SIDES');
    expect(await send(binding, null)).toMatchObject({
      kind: 'FORBIDDEN',
      reasons: ['SAME_PERSON_BOTH_SIDES'],
    });
    reply = () => refusal(409, 'OPTIMISTIC_LOCK_FAILED');
    expect(await send(binding, null)).toMatchObject({
      kind: 'INVALID',
      message: CONTRACT_CODE_TEXT.OPTIMISTIC_LOCK_FAILED,
    });
    reply = () => refusal(422, 'SOMETHING_NEW');
    expect(await send(binding, null)).toMatchObject({
      kind: 'INVALID',
      message: CONTRACT_REFUSAL_FALLBACK,
    });
    reply = () => refusal(503, 'SERVICE_UNAVAILABLE');
    expect((await send(binding, null)).kind).toBe('UNKNOWN_OUTCOME');
  });
});
