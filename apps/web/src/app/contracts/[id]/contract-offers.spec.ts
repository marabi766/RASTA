/**
 * @jest-environment node
 */
import { verifyContractStamp } from '@/server/contract-command-replay';
import { contractCallerOf } from '@/server/contract-commands';
import type { AmendmentPage, MilestonePage, ReadResult } from '@/server/contracts';
import type { WebSession } from '@/server/session';
import {
  AMENDMENT_ID,
  CONTRACTOR,
  CONTRACTOR_SIGNED,
  DRAFT,
  EMPLOYER,
  MILESTONE,
  MILESTONE_ID,
  PROPOSED,
  SIGNED,
  policyView,
  tokenFor,
} from '@/test/contract-command-fixtures';

import { contractCommandOffers } from './contract-offers';

/**
 * Which contract forms the page draws for whom — the eligibility copies put
 * together, each offer stamped with the object, version and side it shows —
 * and when the employer's signing policy is read: only when an employer's
 * signature could be offered at all.
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
  WEB_CONTRACT_CANCEL_REASON_CODES: ['TERMS_NOT_AGREED', 'CLIENT_CODE'],
  WEB_CONTRACT_AMENDMENT_REASON_CODES: ['SCOPE_CHANGE'],
  WEB_SESSION_MAX_AGE_SECONDS: 43_200,
};

function sessionFor(token: string): WebSession {
  return {
    subject: 'user-1',
    username: 'person',
    organizationId: EMPLOYER,
    accessToken: token,
    accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 600,
    refreshToken: 'refresh',
    csrfToken: 'csrf',
    issuedAt: 1_900_000_000,
  };
}

const ok = <T>(data: T) => ({ kind: 'OK' as const, data });
const amendments = (items = [PROPOSED]): ReadResult<AmendmentPage> =>
  ok({ items, nextCursor: null, hasMore: false });
const milestones = (items = [MILESTONE]): ReadResult<MilestonePage> =>
  ok({ items, nextCursor: null, hasMore: false });

let policyReads = 0;
let policyAnswer: () => Response;

beforeEach(() => {
  policyReads = 0;
  policyAnswer = () =>
    new Response(JSON.stringify({ items: [policyView()], nextCursor: null, hasMore: false }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'corr' },
    });
  jest.spyOn(globalThis, 'fetch').mockImplementation((async () => {
    policyReads += 1;
    return policyAnswer();
  }) as unknown as typeof fetch);
});

afterEach(() => jest.restoreAllMocks());

async function offersFor(
  token: string,
  contract = DRAFT,
  amendmentPage: ReadResult<AmendmentPage> | null = amendments([]),
  milestonePage: ReadResult<MilestonePage> | null = milestones([]),
) {
  const session = sessionFor(token);
  const offers = await contractCommandOffers(
    session,
    contractCallerOf(token),
    contract,
    amendmentPage,
    milestonePage,
    ENV,
  );
  return { session, offers };
}

const commandsOf = (offered: readonly { command: string }[]) =>
  offered.map(({ command }) => command);

describe('a draft', () => {
  it('the employer’s administrator: signature for the employer and the cancellation, the configured reasons offered', async () => {
    const { session, offers } = await offersFor(tokenFor(EMPLOYER, ['ORGANIZATION_ADMIN']));
    expect(commandsOf(offers.contract)).toEqual(['SIGN', 'CANCEL']);
    expect(offers.contract[0]?.side).toBe('EMPLOYER');
    expect(offers.contract[1]?.reasons).toEqual([
      { code: 'TERMS_NOT_AGREED', label: 'توافق نشدن بر شرایط' },
      // A code the client configured, with no Persian word here, is offered as itself.
      { code: 'CLIENT_CODE', label: 'CLIENT_CODE' },
    ]);
    expect(offers.signingNote).toBeNull();
    expect(policyReads).toBe(1);
    // The stamp binds the version and the side the page showed.
    const sign = offers.contract[0]!;
    expect(
      verifyContractStamp(
        session,
        sign.submission.replay.token,
        { contractId: DRAFT.id, slot: 'CONTRACT', subjectId: null },
        sign.submission.id,
      ),
    ).toMatchObject({ command: 'SIGN', expectedVersion: DRAFT.version, side: 'EMPLOYER' });
  });

  it('an employer with no signing policy in force is told so, and may still cancel', async () => {
    policyAnswer = () =>
      new Response(JSON.stringify({ items: [], nextCursor: null, hasMore: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const { offers } = await offersFor(tokenFor(EMPLOYER, ['ORGANIZATION_ADMIN']));
    expect(commandsOf(offers.contract)).toEqual(['CANCEL']);
    expect(offers.signingNote).toBe('NO_POLICY');
  });

  it('an unreadable policy is no signature, and says so', async () => {
    policyAnswer = () => new Response('{}', { status: 503 });
    const { offers } = await offersFor(tokenFor(EMPLOYER, ['ORGANIZATION_ADMIN']));
    expect(commandsOf(offers.contract)).toEqual(['CANCEL']);
    expect(offers.signingNote).toBe('UNREAD');
  });

  it('the contractor: its signature only, and the policy is never read', async () => {
    const { offers } = await offersFor(tokenFor(CONTRACTOR, ['CONTRACTOR']));
    expect(commandsOf(offers.contract)).toEqual(['SIGN']);
    expect(offers.contract[0]?.side).toBe('CONTRACTOR');
    expect(policyReads).toBe(0);
  });

  it('once the contractor has signed: the employer signs, and may no longer cancel', async () => {
    const { offers } = await offersFor(
      tokenFor(EMPLOYER, ['ORGANIZATION_ADMIN']),
      CONTRACTOR_SIGNED,
    );
    expect(commandsOf(offers.contract)).toEqual(['SIGN']);
  });
});

describe('a signed contract', () => {
  it('the employer’s administrator: propose, sign the amendment, plan, change the milestone', async () => {
    const { session, offers } = await offersFor(
      tokenFor(EMPLOYER, ['ORGANIZATION_ADMIN']),
      SIGNED,
      amendments(),
      milestones(),
    );
    expect(offers.contract).toEqual([]);
    expect(commandsOf(offers.newAmendment)).toEqual(['PROPOSE_AMENDMENT']);
    expect(commandsOf(offers.amendments[AMENDMENT_ID]!)).toEqual(['SIGN_AMENDMENT']);
    expect(commandsOf(offers.newMilestone)).toEqual(['PLAN_MILESTONE']);
    const change = offers.milestones[MILESTONE_ID]![0]!;
    expect(change.defaults).toEqual({
      title: MILESTONE.title,
      plannedDate: '2026-12-20',
      plannedShareBp: '25.5',
    });
    expect(
      verifyContractStamp(
        session,
        change.submission.replay.token,
        { contractId: SIGNED.id, slot: 'MILESTONE', subjectId: MILESTONE_ID },
        change.submission.id,
      ),
    ).toMatchObject({
      command: 'CHANGE_MILESTONE',
      expectedVersion: MILESTONE.version,
      side: null,
    });
    const plan = offers.newMilestone[0]!;
    expect(
      verifyContractStamp(
        session,
        plan.submission.replay.token,
        { contractId: SIGNED.id, slot: 'NEW_MILESTONE', subjectId: null },
        plan.submission.id,
      ),
    ).toMatchObject({ expectedVersion: null });
  });

  it('the contractor: only the amendment’s signature; no policy read', async () => {
    const { offers } = await offersFor(
      tokenFor(CONTRACTOR, ['CONTRACTOR']),
      SIGNED,
      amendments(),
      milestones(),
    );
    expect(offers.newAmendment).toEqual([]);
    expect(offers.newMilestone).toEqual([]);
    expect(offers.amendments[AMENDMENT_ID]?.[0]?.side).toBe('CONTRACTOR');
    expect(offers.milestones[MILESTONE_ID]).toEqual([]);
    expect(policyReads).toBe(0);
  });

  it('a referenced milestone is not changed; an employer with nothing to sign does not read the policy', async () => {
    const { offers } = await offersFor(
      tokenFor(EMPLOYER, ['ORGANIZATION_ADMIN']),
      SIGNED,
      amendments([{ ...PROPOSED, employerSignedAt: '2026-10-04T08:00:00.000Z' }]),
      milestones([{ ...MILESTONE, referenced: true }]),
    );
    expect(offers.milestones[MILESTONE_ID]).toEqual([]);
    expect(offers.amendments[AMENDMENT_ID]).toEqual([]);
    expect(policyReads).toBe(0);
  });

  it('an employer without the configured roles is offered nothing, though it reads the contract', async () => {
    const { offers } = await offersFor(
      tokenFor(EMPLOYER, ['FLEET_MANAGER']),
      SIGNED,
      amendments(),
      milestones(),
    );
    expect(offers.newAmendment).toEqual([]);
    expect(offers.newMilestone).toEqual([]);
    expect(offers.milestones[MILESTONE_ID]).toEqual([]);
    // Its role is not the policy's either.
    expect(offers.amendments[AMENDMENT_ID]).toEqual([]);
  });

  it('every slot is drawn even when the reads behind it failed', async () => {
    const { offers } = await offersFor(
      tokenFor(EMPLOYER, ['ORGANIZATION_ADMIN']),
      SIGNED,
      null,
      null,
    );
    expect(offers.amendments).toEqual({});
    expect(offers.milestones).toEqual({});
    expect(offers.context.pageHref).toBe(`/contracts/${SIGNED.id}`);
  });
});
