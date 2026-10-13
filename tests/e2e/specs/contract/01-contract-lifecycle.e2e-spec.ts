import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, errorCode, idempotencyKey, Actor, type ApiResponse } from '../../src/api';
import { ORG, e2eConfig } from '../../src/env';
import { EconomicEventTap, type ObservedEvent } from '../../src/events';
import { enableSignIn, freshToken, membershipClaims } from '../../src/keycloak-accounts';

/**
 * A contract end to end (CON-003, ADR-068, Q-95..Q-100, D-050/D-051), black box through the
 * gateway: Keycloak tokens, api-gateway, construction-service (the tenders that are awarded),
 * supplier-service (the contractors' standing), identity-service (live membership),
 * organization-service (the hierarchy, and the move), contract-service, audit-service and
 * Kafka. Nothing stubbed, and no route or setting that exists only for this test.
 *
 * ## The cast — provisioned per run through the platform's own APIs
 *
 * - **Organizations** (`system.admin`): the **owner** (the employer), under the union so that
 *   `union.admin` may write its approval policies (Q-70 (7)); contractors **C1** and **C2**, who
 *   both bid on all three tenders — C1 wins tender A, C2 wins tenders B and C, so each is a
 *   stranger to the other's contracts — and **C3**, a contractor that bid on nothing. Contract
 *   C exists only for the organization move: its employer signature is made immediately before
 *   the move, so the D-050 review flag does not depend on how long the run took.
 *   `tenantB` (`ORG-DEH-0002`) is the other seeded tenant.
 * - **People** (`system.admin`, identity-service — real memberships): in the owner, all
 *   `ORGANIZATION_ADMIN`: `author`, `p1`, `p2`, `evaluator`, `awarder` (the tender flow),
 *   `plain` (no signing authority), `signer` (also `FLEET_MANAGER`, the role the signing policy
 *   names) and `dual` (also a `CONTRACTOR` member of C1). One `CONTRACTOR` in each of C1, C2, C3,
 *   and a second in C1 (`c1b`).
 * - **Policies**: `project.execution`, `tender.publication`, `tender.award` for the owner in
 *   construction-service (`union.admin` writes, `system.admin` approves), then — later in the
 *   run, once a signature has been refused for want of one — `contract.signature` in
 *   contract-service, naming the owner's own `FLEET_MANAGER` role. Samples; no legal authority
 *   is claimed (ADR-023, Q-02).
 *
 * ## Through the front door — with one labelled exception
 *
 * Every call goes through api-gateway except the three that write and approve the
 * `contract.signature` policy (`signingPolicy` below). The gateway resolves a route from the
 * first path segment only and sends `approval-policies` to construction-service, which has no
 * `contract.signature` workflow; contract-service serves the same path itself, so through the
 * gateway that policy cannot be written and nobody can sign for an employer. Those calls carry
 * real user tokens and go straight to contract-service (`CallOptions.baseUrl`); nothing else does.
 * It is reported as a product gap on the PR, not worked around in the product.
 */

const config = e2eConfig();
const RUN = randomUUID().slice(0, 8);

/** How long the bidding window stays open: both tenders' publication, bids and nothing else. */
const BIDDING_WINDOW_MS = 90_000;

/**
 * The longest the employer's signature on the fresh contract may precede the move that
 * strands its policy. D-050 reviews a signature only while the move's instant is no later than
 * the signature's commit deadline plus CONTRACT_HIERARCHY_CLOCK_SKEW_MARGIN_SECONDS (300 s by
 * default, which CI does not override); the bound is well inside it, and the test asserts it
 * rather than hoping a slow runner stays under it.
 */
const FLAG_WINDOW_BOUND_MS = 120_000;

/** The least that must be left of the window when a step that needs it open starts. */
const WINDOW_MARGIN_MS = 15_000;

/** One poll per second: the gateway allows 300 calls a minute per user. */
const POLL_INTERVAL_MS = 1_000;

const OWNER_ROLE = 'ORGANIZATION_ADMIN';

/** The role the `contract.signature` policy names: held by `signer`, not by `plain`. */
const SIGNING_ROLE = 'FLEET_MANAGER';

const SURNAMES: Record<string, string> = {
  author: 'نگارنده',
  p1: 'بازگشا یکم',
  p2: 'بازگشا دوم',
  evaluator: 'ارزیاب',
  awarder: 'برگزیننده',
  plain: 'بی اختیار',
  signer: 'امضاکننده',
  dual: 'دو سویه',
  c1: 'پیمانکار یکم',
  c1b: 'پیمانکار یکم دوم',
  c2: 'پیمانکار دوم',
  c3: 'پیمانکار سوم',
};

const CRITERIA = [
  {
    code: 'technical',
    label: 'Technical approach (sample)',
    weightBp: 7000,
    scoringMethod: 'MANUAL_SCORE',
    maxScore: 10,
  },
  {
    code: 'compliance',
    label: 'Documents complete (sample)',
    weightBp: 3000,
    scoringMethod: 'PASS_FAIL',
    maxScore: 1,
  },
] as const;

type Contractor = 'c1' | 'c2';
type TenderKey = 'A' | 'B' | 'C';
const TENDERS = ['A', 'B', 'C'] as const;

/** The prices bid, minor units. The winner of each tender is the one with the higher score. */
const PRICE: Record<TenderKey, Record<Contractor, string>> = {
  A: { c1: '4200000000', c2: '4600000000' },
  B: { c1: '3900000000', c2: '3500000000' },
  C: { c1: '3100000000', c2: '2800000000' },
};
const WINNER: Record<TenderKey, Contractor> = { A: 'c1', B: 'c2', C: 'c2' };

/** Scores (scaled) per contractor on each tender: the winner's are the higher. */
const SCORES: Record<TenderKey, Record<Contractor, [number, number]>> = {
  A: { c1: [900, 100], c2: [700, 100] },
  B: { c1: [700, 100], c2: [900, 100] },
  C: { c1: [700, 100], c2: [900, 100] },
};

const AMENDMENT_ONE = '500000000';
const AMENDMENT_TWO = '250000000';

function bidContent(price: string, note: string) {
  return {
    content: {
      priceMinor: price,
      answers: [
        { criterionCode: 'technical', response: `Method statement — ${note}` },
        { criterionCode: 'compliance', response: 'All documents attached to the file' },
      ],
    },
  };
}

interface TenderBody {
  id: string;
  status: string;
  version: number;
  bidClosingAt: string | null;
}

interface RequestBody {
  id: string;
  steps: { approvalId: string }[];
}

interface ContractBody {
  id: string;
  organizationId: string;
  tenderId: string;
  contractorOrganizationId: string;
  amountMinor: string;
  amendmentsTotalMinor: string;
  currentAmountMinor: string;
  status: string;
  employerSignedAt: string | null;
  contractorSignedAt: string | null;
  cancelReasonCode: string | null;
  authorityReviewRequired: boolean;
  version: number;
}

interface AmendmentBody {
  id: string;
  contractId: string;
  amendmentNumber: number;
  deltaMinor: string;
  status: string;
  employerSignedAt: string | null;
  contractorSignedAt: string | null;
  effectiveAt: string | null;
  version: number;
}

interface MilestoneBody {
  id: string;
  contractId: string;
  title: string;
  plannedDate: string;
  plannedShareBp: number | null;
  referenced: boolean;
  version: number;
}

interface PolicyBody {
  id: string;
  status: string;
  version: number;
  workflowKey: string;
}

// ---------------------------------------------------------------------------
// Helpers — thin: each adds headers or polls, and none decides an outcome.
// ---------------------------------------------------------------------------

/** A correlation id this file can later find on the topic. */
function correlation(label: string): string {
  return `e2e-contract-${RUN}-${label}-${randomUUID().slice(0, 8)}`;
}

/** An unsafe call, each with a fresh `Idempotency-Key`: a retry here is a new attempt, never a replay. */
function send(
  actor: Actor,
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body: unknown,
  correlationId?: string,
): Promise<ApiResponse<unknown>> {
  return actor.call(method, path, {
    body,
    idempotencyKey: idempotencyKey(`contract-${RUN}`),
    ...(correlationId ? { correlationId } : {}),
  });
}

/** Polls at a rate the gateway's per-user limit tolerates; never a fixed sleep. */
async function until<T>(
  description: string,
  check: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}${last ? `; ${last}` : ''}`,
  );
}

/** The closed reason of a refusal: the first `details[].code` of the error body (docs/06 § 6.7). */
function reasonOf(body: unknown): string | undefined {
  const details = (body as { details?: unknown } | null)?.details;
  if (!Array.isArray(details)) return undefined;
  const code = (details[0] as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** A refusal, asserted whole: the status, the platform's `code` and — where named — the closed reason. */
function expectRefusal(
  response: ApiResponse<unknown>,
  expected: { status: number; code: string; reason?: string },
  what = 'the refusal',
): void {
  const body = JSON.stringify(response.body);
  expect(response.status, `${what}: ${body}`).toBe(expected.status);
  expect(errorCode(response.body), `${what}: ${body}`).toBe(expected.code);
  if (expected.reason !== undefined) {
    expect(reasonOf(response.body), `${what}: ${body}`).toBe(expected.reason);
  }
}

const NOT_FOUND = { status: 404, code: 'NOT_FOUND' } as const;

/** The same refusal: status, platform code and message (which never names a record). */
function refusalOf(response: ApiResponse<unknown>): {
  status: number;
  code?: string;
  message?: string;
  details?: unknown;
} {
  // Request ids, timestamps and the echoed path differ by construction and are left out.
  const body = response.body as { message?: string; details?: unknown } | null;
  return {
    status: response.status,
    code: errorCode(response.body),
    message: body?.message,
    details: body?.details,
  };
}

async function tender(owner: Actor, id: string): Promise<TenderBody> {
  const response = await owner.get(`/v1/tenders/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as TenderBody;
}

/** The authority reads its step (for the version) and decides it. */
async function decide(authority: Actor, approvalId: string): Promise<ApiResponse<unknown>> {
  const step = await authority.get(`/v1/approvals/${approvalId}`);
  expect(step.status, JSON.stringify(step.body)).toBe(200);
  return authority.post(`/v1/approvals/${approvalId}/decision`, {
    body: { expectedVersion: (step.body as { version: number }).version, decision: 'GRANT' },
  });
}

async function contract(actor: Actor, id: string): Promise<ContractBody> {
  const response = await actor.get(`/v1/contracts/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as ContractBody;
}

async function amendment(actor: Actor, contractId: string, id: string): Promise<AmendmentBody> {
  const response = await actor.get(`/v1/contracts/${contractId}/amendments/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as AmendmentBody;
}

/**
 * Everything another organization could ask about a contract, its amendments and its
 * milestones. Each must be 404 — a 403 would confirm the record exists — and none may change
 * anything (each write body is valid, so the answer is the tenant check, not validation).
 */
async function assertInvisibleToStranger(
  stranger: Actor,
  ids: { contractId: string; amendmentIds?: string[]; milestoneIds?: string[] },
  who: string,
): Promise<void> {
  const probesOf = (target: typeof ids): [string, () => Promise<ApiResponse<unknown>>][] => {
    const c = `/v1/contracts/${target.contractId}`;
    const probes: [string, () => Promise<ApiResponse<unknown>>][] = [
      ['read the contract', () => stranger.get(c)],
      ['list its amendments', () => stranger.get(`${c}/amendments`)],
      ['list its milestones', () => stranger.get(`${c}/milestones`)],
      ['sign it', () => send(stranger, 'POST', `${c}/sign`, {})],
      ['cancel it', () => send(stranger, 'POST', `${c}/cancel`, { reasonCode: 'OTHER' })],
      [
        'propose an amendment',
        () =>
          send(stranger, 'POST', `${c}/amendments`, {
            deltaMinor: '1000',
            reasonCode: 'OTHER',
            reasonText: 'Probe from another organization',
          }),
      ],
      [
        'plan a milestone',
        () =>
          send(stranger, 'POST', `${c}/milestones`, { title: 'Probe', plannedDate: '2027-06-01' }),
      ],
    ];
    (target.amendmentIds ?? []).forEach((id, index) => {
      probes.push(
        [`read amendment ${index + 1}`, () => stranger.get(`${c}/amendments/${id}`)],
        [
          `sign amendment ${index + 1}`,
          () => send(stranger, 'POST', `${c}/amendments/${id}/sign`, {}),
        ],
      );
    });
    (target.milestoneIds ?? []).forEach((id, index) => {
      probes.push(
        [`read milestone ${index + 1}`, () => stranger.get(`${c}/milestones/${id}`)],
        [
          `change milestone ${index + 1}`,
          () => send(stranger, 'PATCH', `${c}/milestones/${id}`, { title: 'Probe change' }),
        ],
      );
    });
    return probes;
  };
  // The same requests against records that do not exist: the answers must be identical in
  // status, code, message and details — nothing tells a stranger the record is there.
  const missing = {
    contractId: `CTR_${RUN}_MISSING`,
    amendmentIds: (ids.amendmentIds ?? []).map((_, index) => `AMD_${RUN}_MISSING_${index}`),
    milestoneIds: (ids.milestoneIds ?? []).map((_, index) => `MLS_${RUN}_MISSING_${index}`),
  };
  const real = probesOf(ids);
  const absent = probesOf(missing);
  for (const [index, [what, probe]] of real.entries()) {
    const response = await probe();
    expectRefusal(response, NOT_FOUND, `${who} tried to ${what}`);
    expect(
      refusalOf(response),
      `${who} tried to ${what}: against a record that is not there`,
    ).toEqual(refusalOf(await absent[index]![1]()));
  }
  const list = await stranger.get('/v1/contracts?limit=100');
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  expect((list.body as { items: { id: string }[] }).items.map((item) => item.id)).not.toContain(
    ids.contractId,
  );
}

// ---------------------------------------------------------------------------

test.describe.serial('a contract, end to end (CON-003)', () => {
  let context: APIRequestContext;
  let tap: EconomicEventTap;

  const org = { owner: '', c1: '', c2: '', c3: '' };
  const supplier = { c1: '', c2: '' };
  let people: Record<
    | 'author'
    | 'p1'
    | 'p2'
    | 'evaluator'
    | 'awarder'
    | 'plain'
    | 'signer'
    | 'dual'
    | 'c1'
    | 'c1b'
    | 'c2'
    | 'c3',
    Actor
  >;

  let projectId = '';
  const tenderId: Record<TenderKey, string> = { A: '', B: '', C: '' };
  const bid: Record<TenderKey, Record<Contractor, string>> = {
    A: { c1: '', c2: '' },
    B: { c1: '', c2: '' },
    C: { c1: '', c2: '' },
  };
  const contractId: Record<TenderKey, string> = { A: '', B: '', C: '' };
  let policyId = '';
  const amendmentId = { one: '', two: '' };
  let milestoneId = '';

  let windowSetAt = 0;
  const inWindow = <T>(step: string, call: () => Promise<T>): Promise<T> => {
    const elapsed = Date.now() - windowSetAt;
    expect(
      BIDDING_WINDOW_MS - elapsed,
      `${elapsed} ms of the ${BIDDING_WINDOW_MS} ms bidding window had passed before ${step}: ` +
        'this runner is too slow for the window — lengthen BIDDING_WINDOW_MS',
    ).toBeGreaterThanOrEqual(WINDOW_MARGIN_MS);
    return call();
  };

  /** Correlated calls whose events (and audit records) are asserted at the end. */
  const evidence: {
    label: string;
    correlationId: string;
    events: string[];
    /** A refusal: the one event, and the audit record, it must leave behind, with its payload. */
    refusal?: { event: string; contractId: string; payload: Record<string, unknown> };
  }[] = [];

  test.beforeAll(async ({ playwright }) => {
    context = await playwright.request.newContext();
    tap = await EconomicEventTap.start(config, config.contractTopic);
  });

  test.afterAll(async () => {
    await tap?.stop();
    await context?.dispose();
  });

  // ---- the cast and the awarded tenders -------------------------------------

  test('the cast: an owner under the union, three contractors, and the people who act', async ({
    systemAdmin,
  }) => {
    test.setTimeout(240_000);

    const organization = async (name: string, type: string, parentId?: string): Promise<string> => {
      const created = await systemAdmin.post('/v1/organizations', {
        body: { name, type, ...(parentId ? { parentId } : {}) },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return (created.body as { id: string }).id;
    };
    org.owner = await organization(`E2E contract owner ${RUN}`, 'MUNICIPALITY', ORG.platform);
    org.c1 = await organization(`E2E contractor one ${RUN}`, 'COMPANY');
    org.c2 = await organization(`E2E contractor two ${RUN}`, 'COMPANY');
    org.c3 = await organization(`E2E contractor three ${RUN}`, 'COMPANY');

    const provision = async (
      label: string,
      organizationId: string,
      roles: string[],
    ): Promise<{ username: string; userId: string }> => {
      const username = `e2e.contract.${RUN}.${label}`;
      const created = await systemAdmin.post('/v1/users', {
        idempotencyKey: `e2e-contract-user-${username}`,
        body: {
          username,
          email: `${username}@example.test`,
          firstName: 'آزمون',
          lastName: SURNAMES[label],
          organizationId,
          roles,
        },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return { username, userId: (created.body as { id: string }).id };
    };

    const accounts = {
      author: await provision('author', org.owner, [OWNER_ROLE]),
      p1: await provision('p1', org.owner, [OWNER_ROLE]),
      p2: await provision('p2', org.owner, [OWNER_ROLE]),
      evaluator: await provision('evaluator', org.owner, [OWNER_ROLE]),
      awarder: await provision('awarder', org.owner, [OWNER_ROLE]),
      plain: await provision('plain', org.owner, [OWNER_ROLE]),
      signer: await provision('signer', org.owner, [OWNER_ROLE, SIGNING_ROLE]),
      dual: await provision('dual', org.owner, [OWNER_ROLE]),
      c1: await provision('c1', org.c1, ['CONTRACTOR']),
      c1b: await provision('c1b', org.c1, ['CONTRACTOR']),
      c2: await provision('c2', org.c2, ['CONTRACTOR']),
      c3: await provision('c3', org.c3, ['CONTRACTOR']),
    };

    // `dual` is an administrator of the employer and also a contractor member of C1: the
    // separation-of-duties refusal for a person who is a member of both parties.
    const second = await systemAdmin.post(`/v1/users/${accounts.dual.userId}/memberships`, {
      idempotencyKey: `e2e-contract-membership-${accounts.dual.username}`,
      body: { organizationId: org.c1, roles: ['CONTRACTOR'] },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    const expectedOrganization = {
      author: org.owner,
      p1: org.owner,
      p2: org.owner,
      evaluator: org.owner,
      awarder: org.owner,
      plain: org.owner,
      signer: org.owner,
      dual: org.owner,
      c1: org.c1,
      c1b: org.c1,
      c2: org.c2,
      c3: org.c3,
    } as const;
    const signedIn = {} as typeof people;
    for (const [key, account] of Object.entries(accounts) as [
      keyof typeof accounts,
      (typeof accounts)['author'],
    ][]) {
      await enableSignIn(account.username);
      // The token names the platform user and acts for the organization it was provisioned
      // into: what every live-identity check and the signer comparison read.
      const token = await until(
        `a token for ${account.username} carrying its membership`,
        async () => {
          const candidate = await freshToken(account.username);
          const claims = membershipClaims(candidate);
          const ready =
            claims.rasta_uid === account.userId &&
            claims.org_id === expectedOrganization[key] &&
            (key !== 'dual' || (claims.org_ids ?? []).includes(org.c1));
          return ready ? candidate : undefined;
        },
        30_000,
      );
      signedIn[key] = new Actor(account.username, context, token, config);
    }
    people = signedIn;
  });

  test('both bidding contractors are qualified for CONTRACTING at supplier-service', async ({
    systemAdmin,
  }) => {
    for (const key of ['c1', 'c2'] as const) {
      const registered = await people[key].post('/v1/suppliers', {
        body: { displayName: `E2E contractor ${key} ${RUN}`, capabilities: ['CONTRACTING'] },
      });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      supplier[key] = (registered.body as { id: string }).id;

      const submitted = await people[key].post(`/v1/suppliers/${supplier[key]}/qualifications`, {
        body: { capability: 'CONTRACTING' },
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);

      const approved = await systemAdmin.post(
        `/v1/suppliers/${supplier[key]}/qualifications/${(submitted.body as { id: string }).id}/approve`,
        { body: {} },
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    }
  });

  /** union.admin writes and submits; system.admin, a different person, approves. */
  async function activateConstructionPolicy(
    union: Actor,
    platform: Actor,
    workflowKey: string,
    approvalType: string,
  ): Promise<void> {
    const created = await union.post('/v1/approval-policies', {
      body: {
        organizationId: org.owner,
        workflowKey,
        label: `E2E sample — ${approvalType}`,
        rationale: 'Written by the E2E suite; a sample, not an adopted procedure',
        isSample: true,
        steps: [
          {
            approvalType,
            authorityOrganizationId: org.owner,
            authorityRole: OWNER_ROLE,
            authorityLabel: 'Owner administrator (sample)',
          },
        ],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body as { id: string }).id;
    const submitted = await union.post(`/v1/approval-policies/${id}/submit`, {
      body: { expectedVersion: 1 },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const approved = await platform.post(`/v1/approval-policies/${id}/approve`, {
      body: { expectedVersion: (submitted.body as { version: number }).version },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'ACTIVE', workflowKey });
  }

  test('a project is approved, and the tender policies are in force', async ({
    platformAdmin,
    systemAdmin,
  }) => {
    for (const [workflowKey, approvalType] of [
      ['project.execution', 'Execution approval (sample)'],
      ['tender.publication', 'Publication approval (sample)'],
      ['tender.award', 'Award approval (sample)'],
    ] as const) {
      await activateConstructionPolicy(platformAdmin, systemAdmin, workflowKey, approvalType);
    }

    const { author, p1 } = people;
    const created = await author.post('/v1/projects', {
      body: {
        title: 'بهسازی راه روستایی',
        operationType: 'road',
        scopeOfWork: 'Resurfacing of the access road',
        locationDescription: 'Access road, east side',
        estimatedCostMinor: '9000000000',
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    projectId = (created.body as { id: string }).id;

    const need = await author.post(`/v1/projects/${projectId}/needs`, {
      body: { title: 'Contractor', description: 'Resurfacing works, two kilometres' },
    });
    expect(need.status, JSON.stringify(need.body)).toBe(201);
    expect(
      (
        await author.post(
          `/v1/projects/${projectId}/needs/${(need.body as { id: string }).id}/submit`,
          { body: { expectedVersion: 1 } },
        )
      ).status,
    ).toBe(200);

    const asked = await author.post(`/v1/projects/${projectId}/approvals`, {
      body: { expectedVersion: (created.body as { version: number }).version },
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const steps = await author.get(`/v1/projects/${projectId}/approvals`);
    const pending = (steps.body as { id: string; status: string }[]).filter(
      (step) => step.status === 'PENDING',
    );
    expect(pending).toHaveLength(1);
    const granted = await decide(p1, pending[0]!.id);
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body).toMatchObject({ project: { status: 'APPROVED' } });
  });

  test('two tenders are drafted, shaped, invited and given criteria', async () => {
    const { author } = people;
    for (const key of TENDERS) {
      const created = await author.post(`/v1/projects/${projectId}/tenders`, {
        body: {
          title: `Access road works ${key}`,
          scopeOfWork: 'Resurfacing of two kilometres of the access road',
        },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      tenderId[key] = (created.body as { id: string }).id;

      let current = await tender(author, tenderId[key]);
      const shaped = await send(author, 'PATCH', `/v1/tenders/${tenderId[key]}`, {
        expectedVersion: current.version,
        procurementNature: 'FORMAL_TENDER',
        visibility: 'RESTRICTED',
        // A provisional window; the real one is set just before publication.
        bidOpeningAt: new Date().toISOString(),
        bidClosingAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      expect(shaped.status, JSON.stringify(shaped.body)).toBe(200);

      for (const invited of [org.c1, org.c2]) {
        const invitation = await send(author, 'POST', `/v1/tenders/${tenderId[key]}/invitations`, {
          organizationId: invited,
        });
        expect(invitation.status, JSON.stringify(invitation.body)).toBe(201);
      }

      current = await tender(author, tenderId[key]);
      const criteria = await send(author, 'PUT', `/v1/tenders/${tenderId[key]}/criteria`, {
        expectedVersion: current.version,
        criteria: CRITERIA,
      });
      expect(criteria.status, JSON.stringify(criteria.body)).toBe(200);
      expect(criteria.body).toMatchObject({ totalWeightBp: 10_000, complete: true });
    }
  });

  test('both tenders are published through their approvals and both contractors bid on both', async () => {
    const { author, p1, c1, c2 } = people;

    // The real window, from now, on both tenders: from here to the last bid only what
    // needs the window open runs, and each call first checks that enough of it is left.
    windowSetAt = Date.now();
    const approved: Record<TenderKey, { version: number; step: string }> = {
      A: { version: 0, step: '' },
      B: { version: 0, step: '' },
      C: { version: 0, step: '' },
    };
    for (const key of TENDERS) {
      const current = await tender(author, tenderId[key]);
      const window = await send(author, 'PATCH', `/v1/tenders/${tenderId[key]}`, {
        expectedVersion: current.version,
        bidOpeningAt: new Date(windowSetAt).toISOString(),
        bidClosingAt: new Date(windowSetAt + BIDDING_WINDOW_MS).toISOString(),
      });
      expect(window.status, JSON.stringify(window.body)).toBe(200);
      approved[key].version = (window.body as TenderBody).version;
    }
    for (const key of TENDERS) {
      const asked = await inWindow(`the publication request of ${key}`, () =>
        send(author, 'POST', `/v1/tenders/${tenderId[key]}/publish`, {
          expectedVersion: approved[key].version,
        }),
      );
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      approved[key].step = (asked.body as RequestBody).steps[0]!.approvalId;
    }
    for (const key of TENDERS) {
      const granted = await inWindow(`the publication approval of ${key}`, () =>
        decide(p1, approved[key].step),
      );
      expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    }
    for (const key of TENDERS) {
      const published = await inWindow(`the publication of ${key}`, () =>
        send(author, 'POST', `/v1/tenders/${tenderId[key]}/publish`, {
          expectedVersion: approved[key].version,
        }),
      );
      expect(published.status, JSON.stringify(published.body)).toBe(200);
      expect(published.body).toMatchObject({ id: tenderId[key], status: 'PUBLISHED' });
    }

    for (const key of TENDERS) {
      for (const [who, contractor] of [
        ['c1', c1],
        ['c2', c2],
      ] as const) {
        const submitted = await inWindow(`the bid of ${who} on ${key}`, () =>
          send(
            contractor,
            'POST',
            `/v1/tenders/${tenderId[key]}/bids`,
            bidContent(PRICE[key][who], `${who} on ${key}`),
          ),
        );
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
        bid[key][who] = (submitted.body as { bidId: string }).bidId;
      }
    }
  });

  test('the deadline closes both tenders and two people open the bids', async () => {
    const { author, p1, p2 } = people;
    const closingAt = Date.parse((await tender(author, tenderId.A)).bidClosingAt!);
    // The sweeper closes a tender within one interval of its deadline (ADR-065 § 3).
    const waitMs = Math.max(0, closingAt - Date.now()) + 60_000;
    test.setTimeout(waitMs + 240_000);

    for (const key of TENDERS) {
      await until(
        `the sweeper to close tender ${key}`,
        async () => ((await tender(author, tenderId[key])).status === 'CLOSED' ? true : undefined),
        waitMs,
      );
    }

    for (const key of TENDERS) {
      const proposed = await send(
        p1,
        'POST',
        `/v1/tenders/${tenderId[key]}/open-bids/proposal`,
        {},
      );
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
      // audit-service may still be catching up with the last receipts: 503 means "not yet".
      const opened = await until(
        `the second person to open the bids of ${key}`,
        async () => {
          const response = await send(p2, 'POST', `/v1/tenders/${tenderId[key]}/open-bids`, {});
          return response.status === 503 ? undefined : response;
        },
        60_000,
      );
      expect(opened.status, JSON.stringify(opened.body)).toBe(200);
      expect(opened.body).toMatchObject({ tenderId: tenderId[key], status: 'EVALUATING' });
    }
  });

  test('the evaluator qualifies and scores the bids and completes both evaluations', async () => {
    const { evaluator } = people;
    for (const key of TENDERS) {
      for (const who of ['c1', 'c2'] as const) {
        const qualified = await send(
          evaluator,
          'POST',
          `/v1/tenders/${tenderId[key]}/bids/${bid[key][who]}/qualification`,
          { decision: 'QUALIFIED' },
        );
        expect(qualified.status, JSON.stringify(qualified.body)).toBe(200);
        const scored = await send(
          evaluator,
          'POST',
          `/v1/tenders/${tenderId[key]}/bids/${bid[key][who]}/scores`,
          {
            scores: [
              { criterionCode: 'technical', scoreScaled: SCORES[key][who][0] },
              { criterionCode: 'compliance', scoreScaled: SCORES[key][who][1] },
            ],
          },
        );
        expect(scored.status, JSON.stringify(scored.body)).toBe(200);
      }
      const evaluated = await send(evaluator, 'POST', `/v1/tenders/${tenderId[key]}/evaluate`, {});
      expect(evaluated.status, JSON.stringify(evaluated.body)).toBe(200);
      expect(evaluated.body).toMatchObject({ status: 'EVALUATED', qualifiedBidCount: 2 });
    }
  });

  test('each tender is awarded to its winner, through the award approval', async () => {
    const { p1, awarder } = people;
    for (const key of TENDERS) {
      const winner = WINNER[key];
      const body = { bidId: bid[key][winner] };
      const asked = await send(awarder, 'POST', `/v1/tenders/${tenderId[key]}/award`, body);
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      expect((await decide(p1, (asked.body as RequestBody).steps[0]!.approvalId)).status).toBe(200);

      const awarded = await until(
        `the award of ${key} to execute against audit-service’s receipts`,
        async () => {
          const response = await send(awarder, 'POST', `/v1/tenders/${tenderId[key]}/award`, body);
          return response.status === 503 ? undefined : response;
        },
        60_000,
      );
      expect(awarded.status, JSON.stringify(awarded.body)).toBe(200);
      expect(awarded.body).toMatchObject({
        tenderId: tenderId[key],
        status: 'AWARDED',
        bidderOrganizationId: org[winner],
      });
    }
  });

  // ---- the draft contracts --------------------------------------------------

  test('each award made exactly one DRAFT contract, which both parties read and no one else does', async ({
    tenantB,
  }) => {
    const { author, c1, c2, c3 } = people;
    const mine = async (key: TenderKey): Promise<ContractBody> =>
      until(
        `the draft contract of tender ${key}`,
        async () => {
          const list = await author.get('/v1/contracts?limit=100');
          expect(list.status, JSON.stringify(list.body)).toBe(200);
          const found = (list.body as { items: ContractBody[] }).items.filter(
            (item) => item.tenderId === tenderId[key],
          );
          return found.length > 0 ? found[0] : undefined;
        },
        90_000,
      );
    for (const key of TENDERS) {
      const draft = await mine(key);
      contractId[key] = draft.id;
      const winner = WINNER[key];
      expect(draft).toMatchObject({
        organizationId: org.owner,
        tenderId: tenderId[key],
        contractorOrganizationId: org[winner],
        amountMinor: PRICE[key][winner],
        amendmentsTotalMinor: '0',
        currentAmountMinor: PRICE[key][winner],
        status: 'DRAFT',
        employerSignedAt: null,
        contractorSignedAt: null,
        cancelReasonCode: null,
        authorityReviewRequired: false,
      });
    }
    expect(new Set(Object.values(contractId)).size).toBe(3);

    // Exactly one per award: the owner's list holds one contract per tender, not two.
    const all = await author.get('/v1/contracts?limit=100');
    const ours = (all.body as { items: ContractBody[] }).items.filter((item) =>
      TENDERS.some((key) => tenderId[key] === item.tenderId),
    );
    expect(ours).toHaveLength(3);

    // Each party reads its own contracts, and is a stranger to the other's.
    expect(await contract(c1, contractId.A)).toMatchObject({ id: contractId.A, status: 'DRAFT' });
    expect(await contract(c2, contractId.B)).toMatchObject({ id: contractId.B, status: 'DRAFT' });
    expect(await contract(c2, contractId.C)).toMatchObject({ id: contractId.C, status: 'DRAFT' });
    const c1List = (await c1.get('/v1/contracts?limit=100')).body as { items: ContractBody[] };
    expect(c1List.items.map((item) => item.id)).toEqual([contractId.A]);
    const c2List = (await c2.get('/v1/contracts?limit=100')).body as { items: ContractBody[] };
    expect(c2List.items.map((item) => item.id).sort()).toEqual([contractId.B, contractId.C].sort());

    // A third organization gets exactly what it gets for a contract that does not exist.
    const missing = `CTR_${RUN}_MISSING`;
    for (const [who, stranger, key] of [
      ['an uninvolved contractor', c3, 'A'],
      ['the other tenant’s administrator', tenantB, 'A'],
      ['the other bidder', c2, 'A'],
      ['the other bidder', c1, 'B'],
      ['the other bidder', c1, 'C'],
    ] as const) {
      const response = await stranger.get(`/v1/contracts/${contractId[key]}`);
      expectRefusal(response, NOT_FOUND, `${who} reading contract ${key}`);
      expect(refusalOf(response), `${who}: against a missing contract`).toEqual(
        refusalOf(await stranger.get(`/v1/contracts/${missing}`)),
      );
    }
    await assertInvisibleToStranger(c3, { contractId: contractId.A }, 'an uninvolved contractor');
    await assertInvisibleToStranger(tenantB, { contractId: contractId.A }, 'another tenant');
    await assertInvisibleToStranger(c2, { contractId: contractId.A }, 'the other bidder');
    await assertInvisibleToStranger(c1, { contractId: contractId.B }, 'the other bidder');
    await assertInvisibleToStranger(c1, { contractId: contractId.C }, 'the other bidder');
    await assertInvisibleToStranger(c3, { contractId: contractId.C }, 'an uninvolved contractor');

    // No route creates a contract, edits its terms or removes one (ADR-068): they answer
    // as a route that does not exist.
    for (const [method, path] of [
      ['POST', '/v1/contracts'],
      ['PATCH', `/v1/contracts/${contractId.A}`],
      ['PUT', `/v1/contracts/${contractId.A}`],
      ['DELETE', `/v1/contracts/${contractId.A}`],
    ] as const) {
      const response = await author.call(method, path, {
        idempotencyKey: idempotencyKey(`contract-${RUN}`),
        body: { amountMinor: '1' },
      });
      expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(404);
    }
    expect(await contract(author, contractId.A)).toMatchObject({ version: 1, status: 'DRAFT' });
  });

  // ---- signing --------------------------------------------------------------

  test('with no signing policy nobody signs for the employer; the contractor’s side does not wait for one', async () => {
    const { signer, c1, c1b, author } = people;

    // The Idempotency-Key is required by the service: without one, nothing is done.
    const keyless = await c1.post(`/v1/contracts/${contractId.A}/sign`, { body: {} });
    expectRefusal(keyless, { status: 400, code: 'VALIDATION_FAILED' }, 'signing without a key');

    // No contract.signature policy is in force: not even a person who will hold the role.
    const noPolicy = correlation('sign-without-policy');
    expectRefusal(
      await send(signer, 'POST', `/v1/contracts/${contractId.A}/sign`, {}, noPolicy),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'SIGNATURE_POLICY_REQUIRED' },
      'the employer signing with no policy in force',
    );
    evidence.push({
      label: 'signature refused for want of a policy',
      correlationId: noPolicy,
      events: ['CONTRACT_SIGNATURE_REFUSED'],
      refusal: {
        event: 'CONTRACT_SIGNATURE_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          organizationId: org.owner,
          side: 'EMPLOYER',
          reason: 'SIGNATURE_POLICY_REQUIRED',
          policyId: null,
        },
      },
    });
    expect(await contract(author, contractId.A)).toMatchObject({
      status: 'DRAFT',
      employerSignedAt: null,
    });

    // The contractor's side is a fixed role of its own organization: it signs.
    const contractorSigns = correlation('contractor-signs');
    const signed = await send(
      c1,
      'POST',
      `/v1/contracts/${contractId.A}/sign`,
      {},
      contractorSigns,
    );
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    expect(signed.body).toMatchObject({
      id: contractId.A,
      status: 'DRAFT',
      employerSignedAt: null,
    });
    expect((signed.body as ContractBody).contractorSignedAt).not.toBeNull();
    evidence.push({
      label: 'contractor signature recorded',
      correlationId: contractorSigns,
      events: ['CONTRACT_SIGNATURE_RECORDED'],
    });

    // The same person again changes nothing; another person for that side is refused.
    const again = await send(c1, 'POST', `/v1/contracts/${contractId.A}/sign`, {});
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toEqual(signed.body);
    expectRefusal(
      await send(c1b, 'POST', `/v1/contracts/${contractId.A}/sign`, {}),
      { status: 409, code: 'ALREADY_EXISTS', reason: 'SIDE_ALREADY_SIGNED' },
      'another contractor person signing the signed side',
    );
  });

  test('a draft one side has signed is not cancelled, and only the employer cancels', async () => {
    const { author, c2 } = people;
    expectRefusal(
      await send(author, 'POST', `/v1/contracts/${contractId.A}/cancel`, { reasonCode: 'OTHER' }),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'SIGNATURE_RECORDED' },
      'cancelling a draft the contractor signed',
    );
    expect(await contract(author, contractId.A)).toMatchObject({ status: 'DRAFT' });

    expectRefusal(
      await send(c2, 'POST', `/v1/contracts/${contractId.B}/cancel`, { reasonCode: 'OTHER' }),
      { status: 403, code: 'FORBIDDEN' },
      'the contractor cancelling the draft',
    );
    expect(await contract(author, contractId.B)).toMatchObject({ status: 'DRAFT' });
  });

  /**
   * The three calls that go to contract-service directly (see the header): the signing policy
   * is written and submitted by `union.admin` and approved by a different person, the platform
   * administrator (CONTRACT_POLICY_FOUR_EYES).
   */
  test('the union writes the contract.signature policy and the platform approves it', async ({
    platformAdmin,
    systemAdmin,
  }) => {
    const direct = { baseUrl: config.contractUrl } as const;
    const created = await platformAdmin.post('/v1/approval-policies', {
      ...direct,
      idempotencyKey: idempotencyKey(`contract-policy-${RUN}`),
      body: {
        organizationId: org.owner,
        workflowKey: 'contract.signature',
        label: 'E2E sample — contract signature',
        rationale: 'Written by the E2E suite; a sample, not an adopted procedure',
        isSample: true,
        steps: [
          {
            authorityOrganizationId: org.owner,
            authorityRole: SIGNING_ROLE,
            authorityLabel: 'Signatory of the owner (sample)',
          },
        ],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    policyId = (created.body as PolicyBody).id;

    const submitted = await platformAdmin.post(`/v1/approval-policies/${policyId}/submit`, {
      ...direct,
      idempotencyKey: idempotencyKey(`contract-policy-${RUN}`),
      body: { expectedVersion: (created.body as PolicyBody).version },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    const approved = await systemAdmin.post(`/v1/approval-policies/${policyId}/approve`, {
      ...direct,
      idempotencyKey: idempotencyKey(`contract-policy-${RUN}`),
      body: { expectedVersion: (submitted.body as PolicyBody).version },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'ACTIVE', workflowKey: 'contract.signature' });
  });

  test('the employer signs under the policy: refusals once each, then SIGNED exactly once, and a replay answers the first response', async ({
    tenantB,
  }) => {
    const { plain, dual, signer, author, c1, c3 } = people;
    const path = `/v1/contracts/${contractId.A}/sign`;

    // An administrator of the employer who does not hold the role the policy names.
    expectRefusal(
      await send(plain, 'POST', path, {}),
      { status: 403, code: 'INSUFFICIENT_ROLE' },
      'a person without the policy’s role signing',
    );
    // A person who is a member of both parties.
    expectRefusal(
      await send(dual, 'POST', path, {}),
      { status: 403, code: 'FORBIDDEN', reason: 'MEMBER_OF_BOTH_PARTIES' },
      'a member of both parties signing',
    );
    // Not a party at all.
    expectRefusal(await send(c3, 'POST', path, {}), NOT_FOUND, 'a stranger signing');
    expectRefusal(await send(tenantB, 'POST', path, {}), NOT_FOUND, 'another tenant signing');
    // Nothing signed yet on the employer's side.
    expect(await contract(author, contractId.A)).toMatchObject({
      status: 'DRAFT',
      employerSignedAt: null,
    });

    // The authorised person signs; the second signature makes the contract SIGNED.
    const key = idempotencyKey(`contract-sign-${RUN}`);
    const signing = correlation('employer-signs');
    const first = await signer.call('POST', path, {
      idempotencyKey: key,
      correlationId: signing,
      body: {},
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ id: contractId.A, status: 'SIGNED' });
    const signed = first.body as ContractBody;
    expect(signed.employerSignedAt).not.toBeNull();
    expect(signed.contractorSignedAt).not.toBeNull();
    evidence.push({
      label: 'employer signature recorded and contract signed',
      correlationId: signing,
      events: ['CONTRACT_SIGNATURE_RECORDED', 'CONTRACT_SIGNED'],
    });

    // Idempotency-Key replay: the first response, nothing done twice.
    const replay = await signer.call('POST', path, { idempotencyKey: key, body: {} });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    // The same key with another body is a different request.
    expectRefusal(
      await signer.call('POST', path, { idempotencyKey: key, body: { expectedVersion: 99 } }),
      { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' },
      'the same key with another body',
    );
    // A fresh key from the same person: nothing changes, and no second CONTRACT_SIGNED.
    const fresh = await send(signer, 'POST', path, {});
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    expect(fresh.body).toEqual(first.body);
    expect(await contract(c1, contractId.A)).toMatchObject({
      status: 'SIGNED',
      version: signed.version,
    });
    expect(await contract(author, contractId.A)).toMatchObject({
      status: 'SIGNED',
      version: signed.version,
    });
    // A signed contract is not a draft: it is not cancelled by any route (Q-95 (4)).
    expectRefusal(
      await send(author, 'POST', `/v1/contracts/${contractId.A}/cancel`, { reasonCode: 'OTHER' }),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'CONTRACT_NOT_DRAFT' },
      'cancelling a signed contract',
    );
  });

  test('a second awarded draft is cancelled, and signing it afterwards is refused', async ({
    tenantB,
  }) => {
    const { author, signer, c2, c3 } = people;
    const path = `/v1/contracts/${contractId.B}/cancel`;

    expectRefusal(
      await send(author, 'POST', path, { reasonCode: 'NOT_A_LISTED_REASON' }),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'CANCEL_REASON_NOT_ALLOWED' },
      'cancelling for a reason outside the closed list',
    );
    expectRefusal(await send(c3, 'POST', path, { reasonCode: 'OTHER' }), NOT_FOUND, 'a stranger');
    expectRefusal(
      await send(tenantB, 'POST', path, { reasonCode: 'OTHER' }),
      NOT_FOUND,
      'tenant B',
    );
    expect(await contract(author, contractId.B)).toMatchObject({ status: 'DRAFT' });

    const key = idempotencyKey(`contract-cancel-${RUN}`);
    const cancelling = correlation('cancel');
    const cancelled = await author.call('POST', path, {
      idempotencyKey: key,
      correlationId: cancelling,
      body: { reasonCode: 'AWARD_ERROR', note: 'The award was made on the wrong lot' },
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({
      id: contractId.B,
      status: 'CANCELLED',
      cancelReasonCode: 'AWARD_ERROR',
    });
    evidence.push({
      label: 'draft cancelled',
      correlationId: cancelling,
      events: ['CONTRACT_CANCELLED'],
    });
    const replay = await author.call('POST', path, {
      idempotencyKey: key,
      body: { reasonCode: 'AWARD_ERROR', note: 'The award was made on the wrong lot' },
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(cancelled.body);
    expectRefusal(
      await send(author, 'POST', path, { reasonCode: 'OTHER' }),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'CONTRACT_NOT_DRAFT' },
      'cancelling a cancelled contract',
    );

    // Neither side signs a cancelled draft.
    for (const [who, person] of [
      ['the employer', signer],
      ['the contractor', c2],
    ] as const) {
      expectRefusal(
        await send(person, 'POST', `/v1/contracts/${contractId.B}/sign`, {}),
        { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'CONTRACT_NOT_DRAFT' },
        `${who} signing a cancelled draft`,
      );
    }
    expect(await contract(c2, contractId.B)).toMatchObject({
      status: 'CANCELLED',
      employerSignedAt: null,
      contractorSignedAt: null,
    });
    await assertInvisibleToStranger(tenantB, { contractId: contractId.B }, 'another tenant');
  });

  // ---- amendments -----------------------------------------------------------

  test('an amendment: proposed, signed by both parties, effective once, its delta counted once', async ({
    tenantB,
  }) => {
    const { author, signer, c1, c1b, c3 } = people;
    const base = `/v1/contracts/${contractId.A}/amendments`;
    const body = {
      deltaMinor: AMENDMENT_ONE,
      reasonCode: 'PRICE_ADJUSTMENT',
      reasonText: 'Additional resurfacing agreed on site',
    };

    // Refusals: not the employer, a reduction, a reason outside the list, a contract
    // that is not signed.
    const byContractor = correlation('contractor-proposes');
    expectRefusal(
      await send(c1, 'POST', base, body, byContractor),
      { status: 403, code: 'FORBIDDEN', reason: 'PROPOSER_NOT_EMPLOYER' },
      'the contractor proposing an amendment',
    );
    evidence.push({
      label: 'contractor proposal refused',
      correlationId: byContractor,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'PROPOSE_AMENDMENT',
          side: 'CONTRACTOR',
          subjectId: null,
          reason: 'NOT_EMPLOYER',
        },
      },
    });
    expectRefusal(
      await send(author, 'POST', base, { ...body, deltaMinor: '-1000' }),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'AMENDMENT_DELTA_NOT_POSITIVE' },
      'a reduction',
    );
    expectRefusal(
      await send(author, 'POST', base, { ...body, reasonCode: 'NOT_A_LISTED_REASON' }),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'AMENDMENT_REASON_NOT_ALLOWED' },
      'an unlisted reason',
    );
    expectRefusal(
      await send(author, 'POST', `/v1/contracts/${contractId.B}/amendments`, body),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'CONTRACT_NOT_SIGNED' },
      'amending a cancelled draft',
    );

    const proposing = correlation('amendment-proposed');
    const proposed = await send(author, 'POST', base, body, proposing);
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    expect(proposed.body).toMatchObject({
      contractId: contractId.A,
      amendmentNumber: 1,
      deltaMinor: AMENDMENT_ONE,
      status: 'PROPOSED',
      employerSignedAt: null,
      contractorSignedAt: null,
      effectiveAt: null,
    });
    amendmentId.one = (proposed.body as AmendmentBody).id;
    evidence.push({
      label: 'amendment proposed',
      correlationId: proposing,
      events: ['CONTRACT_AMENDMENT_PROPOSED'],
    });
    // Proposing adds nothing to the price.
    const before = await contract(author, contractId.A);
    expect(before).toMatchObject({ amendmentsTotalMinor: '0' });

    // Both parties read it; nobody else does.
    expect(await amendment(c1, contractId.A, amendmentId.one)).toMatchObject({
      status: 'PROPOSED',
    });
    for (const [who, stranger] of [
      ['an uninvolved contractor', c3],
      ['another tenant', tenantB],
    ] as const) {
      await assertInvisibleToStranger(
        stranger,
        { contractId: contractId.A, amendmentIds: [amendmentId.one] },
        who,
      );
    }

    // The employer signs under the policy; the contractor’s person signs; the second
    // signature makes it effective.
    const path = `${base}/${amendmentId.one}/sign`;
    const employerSigns = await send(signer, 'POST', path, {});
    expect(employerSigns.status, JSON.stringify(employerSigns.body)).toBe(200);
    expect(employerSigns.body).toMatchObject({ status: 'PROPOSED', effectiveAt: null });
    expect((employerSigns.body as AmendmentBody).employerSignedAt).not.toBeNull();
    expect(await contract(author, contractId.A)).toMatchObject({ amendmentsTotalMinor: '0' });

    expectRefusal(await send(c3, 'POST', path, {}), NOT_FOUND, 'a stranger signing the amendment');

    const effecting = correlation('amendment-effective');
    const key = idempotencyKey(`contract-amendment-${RUN}`);
    const second = await c1.call('POST', path, {
      idempotencyKey: key,
      correlationId: effecting,
      body: {},
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ status: 'EFFECTIVE', deltaMinor: AMENDMENT_ONE });
    expect((second.body as AmendmentBody).effectiveAt).not.toBeNull();
    evidence.push({
      label: 'amendment effective',
      correlationId: effecting,
      events: ['CONTRACT_AMENDMENT_SIGNATURE_RECORDED', 'CONTRACT_AMENDED'],
    });

    // Counted once: the replay, a fresh key and the other side signing again add nothing.
    const replay = await c1.call('POST', path, { idempotencyKey: key, body: {} });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'EFFECTIVE', deltaMinor: AMENDMENT_ONE });
    expect((await send(c1, 'POST', path, {})).status).toBe(200);
    expect((await send(signer, 'POST', path, {})).status).toBe(200);
    const effective = await contract(author, contractId.A);
    expect(effective).toMatchObject({
      status: 'SIGNED',
      amountMinor: PRICE.A.c1,
      amendmentsTotalMinor: AMENDMENT_ONE,
      currentAmountMinor: (BigInt(PRICE.A.c1) + BigInt(AMENDMENT_ONE)).toString(),
    });
    expect(await contract(c1, contractId.A)).toMatchObject({
      amendmentsTotalMinor: AMENDMENT_ONE,
    });
    expectRefusal(
      await send(c1b, 'POST', path, {}),
      { status: 409, code: 'ALREADY_EXISTS', reason: 'SIDE_ALREADY_SIGNED' },
      'another contractor person signing the signed side',
    );

    // An effective amendment is never edited, withdrawn or deleted: the API has no such route.
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const response = await author.call(method, `${base}/${amendmentId.one}`, {
        idempotencyKey: idempotencyKey(`contract-${RUN}`),
        body: { deltaMinor: '1' },
      });
      expect(response.status, `${method}: ${JSON.stringify(response.body)}`).toBe(404);
    }
    expect(await amendment(author, contractId.A, amendmentId.one)).toMatchObject({
      status: 'EFFECTIVE',
      deltaMinor: AMENDMENT_ONE,
    });

    // The list holds it once.
    const listed = await c1.get(`${base}?limit=50`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect((listed.body as { items: AmendmentBody[] }).items.map((item) => item.id)).toEqual([
      amendmentId.one,
    ]);

    // A second amendment stays proposed: it is not counted until both have signed.
    const next = await send(author, 'POST', base, {
      deltaMinor: AMENDMENT_TWO,
      reasonCode: 'SCOPE_CHANGE',
      reasonText: 'Drainage added to the scope',
    });
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    expect(next.body).toMatchObject({ amendmentNumber: 2, status: 'PROPOSED' });
    amendmentId.two = (next.body as AmendmentBody).id;
    expect(await contract(author, contractId.A)).toMatchObject({
      amendmentsTotalMinor: AMENDMENT_ONE,
    });
  });

  // ---- milestones -----------------------------------------------------------

  test('milestones: planned and changed by the employer on a signed contract, read by both parties', async ({
    tenantB,
  }) => {
    const { author, c1, c3 } = people;
    const base = `/v1/contracts/${contractId.A}/milestones`;

    const byContractor = correlation('contractor-plans');
    expectRefusal(
      await send(
        c1,
        'POST',
        base,
        { title: 'Foundations', plannedDate: '2027-03-01' },
        byContractor,
      ),
      { status: 403, code: 'FORBIDDEN', reason: 'EDITOR_NOT_EMPLOYER' },
      'the contractor planning a milestone',
    );
    evidence.push({
      label: 'contractor milestone refused',
      correlationId: byContractor,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'PLAN_MILESTONE',
          side: 'CONTRACTOR',
          subjectId: null,
          reason: 'NOT_EMPLOYER',
        },
      },
    });
    expectRefusal(
      await send(author, 'POST', `/v1/contracts/${contractId.B}/milestones`, {
        title: 'Foundations',
        plannedDate: '2027-03-01',
      }),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'CONTRACT_NOT_SIGNED' },
      'planning on a cancelled draft',
    );
    expect(
      (await send(author, 'POST', base, { title: 'Foundations', plannedDate: '2027-02-30' }))
        .status,
    ).toBe(400);

    const planning = correlation('milestone-planned');
    const planned = await send(
      author,
      'POST',
      base,
      { title: 'Foundations', plannedDate: '2027-03-01', plannedShareBp: 3000 },
      planning,
    );
    expect(planned.status, JSON.stringify(planned.body)).toBe(201);
    expect(planned.body).toMatchObject({
      contractId: contractId.A,
      title: 'Foundations',
      plannedDate: '2027-03-01',
      plannedShareBp: 3000,
      referenced: false,
      version: 1,
    });
    milestoneId = (planned.body as MilestoneBody).id;
    evidence.push({
      label: 'milestone planned',
      correlationId: planning,
      events: ['CONTRACT_MILESTONE_PLANNED'],
    });

    // Both parties read it.
    for (const reader of [author, c1]) {
      const read = await reader.get(`${base}/${milestoneId}`);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body).toMatchObject({ id: milestoneId, title: 'Foundations' });
      const listed = await reader.get(`${base}?limit=50`);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect((listed.body as { items: MilestoneBody[] }).items.map((item) => item.id)).toEqual([
        milestoneId,
      ]);
    }

    // Change: a new version; a stale version is refused; a change that changes nothing writes nothing.
    const changing = correlation('milestone-changed');
    const changed = await author.call('PATCH', `${base}/${milestoneId}`, {
      idempotencyKey: idempotencyKey(`contract-${RUN}`),
      correlationId: changing,
      body: { title: 'Foundations and drainage', expectedVersion: 1 },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ title: 'Foundations and drainage', version: 2 });
    evidence.push({
      label: 'milestone changed',
      correlationId: changing,
      events: ['CONTRACT_MILESTONE_CHANGED'],
    });
    expectRefusal(
      await send(author, 'PATCH', `${base}/${milestoneId}`, { title: 'Stale', expectedVersion: 1 }),
      { status: 409, code: 'OPTIMISTIC_LOCK_FAILED' },
      'changing on a stale version',
    );
    const unchanged = await send(author, 'PATCH', `${base}/${milestoneId}`, {
      title: 'Foundations and drainage',
    });
    expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
    expect(unchanged.body).toMatchObject({ version: 2 });
    const contractorChanges = correlation('contractor-changes');
    expectRefusal(
      await send(
        c1,
        'PATCH',
        `${base}/${milestoneId}`,
        { title: 'Contractor edit' },
        contractorChanges,
      ),
      { status: 403, code: 'FORBIDDEN', reason: 'EDITOR_NOT_EMPLOYER' },
      'the contractor changing a milestone',
    );
    evidence.push({
      label: 'contractor milestone change refused',
      correlationId: contractorChanges,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'CHANGE_MILESTONE',
          side: 'CONTRACTOR',
          subjectId: milestoneId,
          reason: 'NOT_EMPLOYER',
        },
      },
    });

    // There is no delete (Q-100).
    const removal = await author.call('DELETE', `${base}/${milestoneId}`, {
      idempotencyKey: idempotencyKey(`contract-${RUN}`),
    });
    expect(removal.status, JSON.stringify(removal.body)).toBe(404);
    expect((await author.get(`${base}/${milestoneId}`)).status).toBe(200);

    for (const [who, stranger] of [
      ['an uninvolved contractor', c3],
      ['another tenant', tenantB],
    ] as const) {
      await assertInvisibleToStranger(
        stranger,
        { contractId: contractId.A, amendmentIds: [amendmentId.one], milestoneIds: [milestoneId] },
        who,
      );
    }
  });

  // ---- an organization move (D-050 / D-051) ---------------------------------

  test('moving the employer out from under the union that wrote its signing policy suspends the policy, and a pending signature is refused', async ({
    systemAdmin,
    platformAdmin,
  }) => {
    const { signer, c1, c2, author } = people;
    const policyPath = `/v1/approval-policies/${policyId}`;

    // The union is the policy's author and governs the employer: the policy is in force.
    const inForce = await platformAdmin.get(policyPath, { baseUrl: config.contractUrl });
    expect(inForce.status, JSON.stringify(inForce.body)).toBe(200);
    expect(inForce.body).toMatchObject({ id: policyId, status: 'ACTIVE' });

    // D-050 flags an employer signature only while the move's instant is within the signature's
    // commit deadline plus the skew margin. So the signature that is to be flagged is made here,
    // on the fresh contract C, immediately before the move, and the gap between the two is
    // asserted: a slow run fails on its own timing, never on a correct product.
    const pathC = `/v1/contracts/${contractId.C}/sign`;
    const contractorSignsC = await send(c2, 'POST', pathC, {});
    expect(contractorSignsC.status, JSON.stringify(contractorSignsC.body)).toBe(200);

    const signingC = correlation('fresh-employer-signs');
    const signStartedAt = Date.now();
    const employerSignsC = await send(signer, 'POST', pathC, {}, signingC);
    expect(employerSignsC.status, JSON.stringify(employerSignsC.body)).toBe(200);
    expect(employerSignsC.body).toMatchObject({ id: contractId.C, status: 'SIGNED' });
    evidence.push({
      label: 'employer signature on the fresh contract',
      correlationId: signingC,
      events: ['CONTRACT_SIGNATURE_RECORDED', 'CONTRACT_SIGNED'],
    });

    const moved = await systemAdmin.post(`/v1/organizations/${org.owner}/move`, {
      body: { parentId: null, reason: 'E2E: the employer leaves the union that wrote its policy' },
    });
    const signToMoveMs = Date.now() - signStartedAt;
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(
      signToMoveMs,
      `${signToMoveMs} ms from the employer's signature to the end of the move: the signature ` +
        `is only flagged within the commit deadline plus the skew margin (D-050); this runner ` +
        `is too slow for FLAG_WINDOW_BOUND_MS (${FLAG_WINDOW_BOUND_MS} ms)`,
    ).toBeLessThan(FLAG_WINDOW_BOUND_MS);

    // The sweeper (Q-83, D-051) suspends the policy the move stranded; nothing is waited
    // for but that state.
    const suspended = await until(
      'the sweeper to suspend the signing policy the move stranded',
      async () => {
        const read = await platformAdmin.get(policyPath, { baseUrl: config.contractUrl });
        return read.status === 200 && (read.body as PolicyBody).status === 'SUSPENDED'
          ? read
          : undefined;
      },
      120_000,
    );
    expect(suspended.body).toMatchObject({ id: policyId, status: 'SUSPENDED' });
    // The signature made just before the move is flagged for review: a flag is never a
    // revocation — the contract stays SIGNED, its total unchanged — and both parties see it.
    await until(
      'the signature on the fresh contract to be flagged for review',
      async () =>
        (await contract(author, contractId.C)).authorityReviewRequired ? true : undefined,
      60_000,
    );
    for (const party of [author, c2]) {
      expect(await contract(party, contractId.C)).toMatchObject({
        status: 'SIGNED',
        amendmentsTotalMinor: '0',
        authorityReviewRequired: true,
        authorityReviewReason: 'AUTHORITY_CHANGED_DURING_SIGNING',
      });
    }

    // With no policy in force the employer's signature of the pending amendment is refused —
    // and the amendment and the contract stay exactly as they were. A flag is never a revocation.
    const stranded = correlation('amendment-sign-after-move');
    expectRefusal(
      await send(
        signer,
        'POST',
        `/v1/contracts/${contractId.A}/amendments/${amendmentId.two}/sign`,
        {},
        stranded,
      ),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'SIGNATURE_POLICY_REQUIRED' },
      'the employer signing an amendment after its policy was suspended',
    );
    evidence.push({
      label: 'amendment signature refused after the move',
      correlationId: stranded,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'SIGN_AMENDMENT',
          side: 'EMPLOYER',
          subjectId: amendmentId.two,
          reason: 'SIGNATURE_POLICY_REQUIRED',
        },
      },
    });
    expect(await amendment(author, contractId.A, amendmentId.two)).toMatchObject({
      status: 'PROPOSED',
      employerSignedAt: null,
    });
    // Contract A was signed long before the move, so whether it is flagged depends on how long
    // the run took and is not asserted; what is, is that nothing about it was revoked.
    for (const party of [author, c1]) {
      expect(await contract(party, contractId.A)).toMatchObject({
        status: 'SIGNED',
        amendmentsTotalMinor: AMENDMENT_ONE,
      });
    }
  });

  // ---- audit ----------------------------------------------------------------

  test('audit-service holds the decisions and the refusals, once each, under the employer’s tenant, and no event carries an amount', async ({
    systemAdmin,
  }) => {
    test.setTimeout(240_000);

    interface AuditItem {
      organizationId: string | null;
      correlationId: string;
      sourceTopic: string;
      sourceEventName: string;
      action: string;
      resourceType: string;
      resourceId: string | null;
      outcome: string;
    }
    const expectedByContract: Record<TenderKey, Record<string, number>> = {
      A: {
        CONTRACT_DRAFTED: 1,
        CONTRACT_SIGNATURE_RECORDED: 2,
        CONTRACT_SIGNED: 1,
        CONTRACT_SIGNATURE_REFUSED: 1,
        CONTRACT_AMENDMENT_PROPOSED: 2,
        CONTRACT_AMENDMENT_SIGNATURE_RECORDED: 2,
        CONTRACT_AMENDED: 1,
        CONTRACT_MILESTONE_PLANNED: 1,
        CONTRACT_MILESTONE_CHANGED: 1,
      },
      B: { CONTRACT_DRAFTED: 1, CONTRACT_CANCELLED: 1 },
      // The contract signed just before the move: its employer signature flagged, once.
      C: {
        CONTRACT_DRAFTED: 1,
        CONTRACT_SIGNATURE_RECORDED: 2,
        CONTRACT_SIGNED: 1,
        CONTRACT_SIGNATURE_AUTHORITY_FLAGGED: 1,
      },
    };
    // Refusals of a party for want of authority, on contract A: the contractor proposing an
    // amendment, planning a milestone and changing one, and the employer signing after its
    // policy was suspended. Each is in `evidence` with its correlation id.
    const refusals = evidence.filter((entry) => entry.refusal);
    const authorityRefusals = refusals.filter(
      (entry) => entry.refusal!.event === 'CONTRACT_AUTHORITY_REFUSED',
    );
    expect(authorityRefusals).toHaveLength(4);

    const records = await until(
      'audit records of every contract decision and refusal',
      async () => {
        const to = new Date(Date.now() + 60_000);
        const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
        const items: AuditItem[] = [];
        let cursor: string | null = null;
        do {
          const parameters = new URLSearchParams({
            from: from.toISOString(),
            to: to.toISOString(),
            organizationId: org.owner,
            limit: '200',
            ...(cursor ? { cursor } : {}),
          }).toString();
          const response = await systemAdmin.get(`/v1/audit-events?${parameters}`);
          if (response.status !== 200) return undefined;
          const page = response.body as { items: AuditItem[]; nextCursor: string | null };
          items.push(...page.items.filter((item) => item.sourceTopic === config.contractTopic));
          cursor = page.nextCursor;
        } while (cursor);
        const countOf = (key: TenderKey, name: string): number =>
          items.filter(
            (item) => item.resourceId === contractId[key] && item.sourceEventName === name,
          ).length;
        const complete =
          refusals.every((entry) =>
            items.some((item) => item.correlationId === entry.correlationId),
          ) &&
          TENDERS.every((key) =>
            Object.entries(expectedByContract[key]).every(
              ([name, count]) => countOf(key, name) >= count,
            ),
          );
        return complete ? items : undefined;
      },
      180_000,
    );
    // Exactly once where once is the rule: not a second CONTRACT_DRAFTED, CONTRACT_SIGNED or
    // CONTRACT_AMENDED for the replays and the repeated signatures. (A redelivered award is not
    // exercised here: nothing in the black-box surface redelivers one.)
    for (const key of TENDERS) {
      for (const [name, count] of Object.entries(expectedByContract[key])) {
        expect(
          records.filter(
            (item) => item.resourceId === contractId[key] && item.sourceEventName === name,
          ),
          `${name} of contract ${key}`,
        ).toHaveLength(count);
      }
    }
    // Exactly the four authority refusals, no more: one audit record per refusal, found by the
    // correlation id the call carried, naming the refusal's event, its contract and the tenant.
    expect(
      records
        .filter((item) => item.sourceEventName === 'CONTRACT_AUTHORITY_REFUSED')
        .map((item) => item.correlationId)
        .sort(),
      'the CONTRACT_AUTHORITY_REFUSED records of the employer',
    ).toEqual(authorityRefusals.map((entry) => entry.correlationId).sort());
    for (const entry of refusals) {
      const recorded = records.filter((item) => item.correlationId === entry.correlationId);
      expect(recorded, `audit records of "${entry.label}"`).toHaveLength(1);
      expect(recorded[0], entry.label).toMatchObject({
        organizationId: org.owner,
        action: entry.refusal!.event,
        sourceEventName: entry.refusal!.event,
        resourceType: 'Contract',
        resourceId: entry.refusal!.contractId,
      });
    }
    // At most one flag on contract A (whether it falls in the window depends on the run's
    // length); exactly one on C is in `expectedByContract`.
    expect(
      records.filter(
        (item) =>
          item.resourceId === contractId.A &&
          item.sourceEventName === 'CONTRACT_SIGNATURE_AUTHORITY_FLAGGED',
      ).length,
    ).toBeLessThanOrEqual(1);
    for (const record of records) {
      expect(record.organizationId).toBe(org.owner);
    }

    // The correlated calls: the topic says which refusal it was, and carries no amount.
    const seen = async (label: string): Promise<ObservedEvent[]> => {
      const entry = evidence.find((item) => item.label === label)!;
      return tap.awaitCorrelated(entry.correlationId, entry.events);
    };
    const payloadOf = (events: ObservedEvent[], name: string): Record<string, unknown> =>
      events.find((event) => event.eventName === name)!.payload;

    // Each refusal left exactly one event on the topic, with the action, subject and reason
    // that were refused (the audit record above is its one row).
    for (const entry of refusals) {
      const { event, payload } = entry.refusal!;
      const published = (await seen(entry.label)).filter((item) => item.eventName === event);
      expect(published, `${event} of "${entry.label}" on the topic`).toHaveLength(1);
      expect(published[0]!.payload, entry.label).toMatchObject(payload);
    }
    expect(payloadOf(await seen('draft cancelled'), 'CONTRACT_CANCELLED')).toMatchObject({
      contractId: contractId.B,
      reasonCode: 'AWARD_ERROR',
    });
    expect(
      payloadOf(await seen('employer signature recorded and contract signed'), 'CONTRACT_SIGNED'),
    ).toMatchObject({ contractId: contractId.A });

    // Every event of the correlated calls was published under the employer's tenant, keyed by
    // the contract, and none carried an amount, a note or a reason text (ADR-068 § 4).
    const amounts = [
      PRICE.A.c1,
      PRICE.A.c2,
      PRICE.B.c1,
      PRICE.B.c2,
      PRICE.C.c1,
      PRICE.C.c2,
      AMENDMENT_ONE,
      AMENDMENT_TWO,
      'wrong lot',
      'Additional resurfacing',
    ];
    for (const entry of evidence) {
      for (const event of tap.correlated(entry.correlationId)) {
        expect(event.tenantId, entry.label).toBe(org.owner);
        expect(Object.values(contractId), entry.label).toContain(event.key);
        for (const leak of amounts) {
          expect(JSON.stringify(event.payload), entry.label).not.toContain(leak);
        }
      }
    }
  });
});
