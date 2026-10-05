import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect, errorCode, idempotencyKey, Actor, type ApiResponse } from '../../src/api';
import { ORG, e2eConfig } from '../../src/env';
import { EconomicEventTap, type ObservedEvent } from '../../src/events';
import { enableSignIn, freshToken, membershipClaims } from '../../src/keycloak-accounts';

/**
 * A tender end to end (CON-002, ADR-065..067, Q-84, Q-91), black box through
 * the gateway: Keycloak tokens, api-gateway, construction-service,
 * identity-service (live membership), organization-service (the hierarchy, the
 * invited organizations), supplier-service (a contractor's standing, asked at
 * the moment of bidding, qualifying and awarding), audit-service (the receipt
 * chain the bids are opened against, and the audit record) and Kafka. Nothing
 * stubbed, and no route or setting that exists only for this test.
 *
 * ## The cast — provisioned per run through the platform's own APIs
 *
 * Nothing here is seeded for the scenario. Spec 02 owns the policies of
 * `ORG-UNION-YAZD` (a newer policy retires the one in force), and nothing in
 * the seeded tree sits under the union, so the run makes its own:
 *
 * - **Organizations** (`system.admin`, organization-service): the tender
 *   **owner**, under the union so that `union.admin` may write its approval
 *   policies (Q-70 (7)); two bidding contractors **C1**, **C2**; and **C3**, a
 *   contractor that does not bid.
 * - **People** (`system.admin`, identity-service — real memberships, so every
 *   live-identity check reads a real row, and every token carries `rasta_uid`):
 *   in the owner organization, as `ORGANIZATION_ADMIN` (the default project,
 *   opening, evaluation and award role): `author` (drafts, requests publication
 *   and cancellation), `p1` and `p2` (the opening committee, and the second
 *   person on every approval), `evaluator`, `awarder`, and `conflicted` — who
 *   is also a member of C2. One `CONTRACTOR` in each of C1, C2, C3.
 * - **Policies** (`union.admin` writes, `system.admin` approves):
 *   `project.execution`, `tender.publication`, `tender.award`,
 *   `tender.cancellation` for the owner organization. Each step names the owner
 *   organization's `ORGANIZATION_ADMIN`, so the person who makes a request is
 *   also an authority — and the refusal of approving one's own request is the
 *   real rule, not a missing role. Samples (`isSample`); no legal authority is
 *   claimed (ADR-023, Q-02).
 * - `tenantB` (`ORG-DEH-0002`) is the other tenant, probed at every step;
 *   `systemAdmin` reads audit-service.
 *
 * ## Through the front door, with one exception that is a finding
 *
 * `GET /v1/open-tenders` — how a contractor finds a tender — is not routed by
 * api-gateway, and neither is `/v1/criteria-templates` (reported on #223). The
 * contractors are given the tender id the way an invitation would carry it,
 * and the criteria are written out on the tender. Nothing here reaches a
 * service directly.
 */

const config = e2eConfig();
const RUN = randomUUID().slice(0, 8);

/**
 * How long the bidding window stays open once the tender is published.
 *
 * Long enough for publication's approval, two bids and the probes that must
 * happen before the deadline; the deadline itself is then waited for, on the
 * tender's status, never with a sleep.
 */
const BIDDING_WINDOW_MS = 75_000;

/** One poll per second: the gateway allows 300 calls a minute per user. */
const POLL_INTERVAL_MS = 1_000;

const OWNER_ROLE = 'ORGANIZATION_ADMIN';

/** Names are letters only in identity-service's profile rules; one per role in the cast. */
const SURNAMES: Record<string, string> = {
  author: 'نگارنده',
  p1: 'بازگشا یکم',
  p2: 'بازگشا دوم',
  evaluator: 'ارزیاب',
  awarder: 'برگزیننده',
  conflicted: 'ذینفع',
  c1: 'پیمانکار یکم',
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

const PRICE = { c1: '4200000000', c2: '4600000000' } as const;

interface TenderBody {
  id: string;
  status: string;
  version: number;
  visibility: string | null;
  bidClosingAt: string | null;
}

interface RequestBody {
  id: string;
  tenderId: string;
  workflowKey: string;
  status: string;
  tenderVersion: number;
  steps: { approvalId: string; status: string }[];
}

interface ReceiptBody {
  bidId: string;
  tenderId: string;
  status: string;
  revision: number;
  receipt: string;
}

interface OpenedBid {
  bidId: string;
  bidderOrganizationId: string;
  status: string;
  content: { priceMinor: string };
}

// ---------------------------------------------------------------------------
// Helpers — thin: each adds headers or polls, and none decides an outcome.
// ---------------------------------------------------------------------------

/** A correlation id this file can later find in audit-service and on the topic. */
function correlation(label: string): string {
  return `e2e-tender-${RUN}-${label}-${randomUUID().slice(0, 8)}`;
}

/**
 * An unsafe call under `/v1/tenders`: the gateway requires an `Idempotency-Key`
 * on every one (`routes.ts`), so each carries a fresh key — a retry here is a
 * new attempt, never a replay.
 */
function send(
  actor: Actor,
  method: 'POST' | 'PATCH' | 'PUT',
  path: string,
  body: unknown,
  correlationId?: string,
): Promise<ApiResponse<unknown>> {
  return actor.call(method, path, {
    body,
    idempotencyKey: idempotencyKey(`tender-${RUN}`),
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

/** The same refusal: status, platform code and message (which never names a record). */
function refusalOf(response: ApiResponse<unknown>): {
  status: number;
  code?: string;
  message?: string;
} {
  const body = response.body as { message?: string };
  return { status: response.status, code: errorCode(response.body), message: body?.message };
}

async function tender(owner: Actor, id: string): Promise<TenderBody> {
  const response = await owner.get(`/v1/tenders/${id}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as TenderBody;
}

async function requests(
  owner: Actor,
  tenderId: string,
  workflowKey: string,
): Promise<RequestBody[]> {
  const response = await owner.get(
    `/v1/tenders/${tenderId}/approvals?workflowKey=${workflowKey}&limit=50`,
  );
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return (response.body as { items: RequestBody[] }).items;
}

/**
 * The authority reads its step (for the version) and decides it. `reader` reads
 * instead when the decider may not read an award approval's detail at all —
 * the evaluator, whose read is refused under the same rules as its decision.
 */
async function decide(
  authority: Actor,
  approvalId: string,
  decision: 'GRANT' | 'REJECT' = 'GRANT',
  correlationId?: string,
  reader: Actor = authority,
): Promise<ApiResponse<unknown>> {
  const step = await reader.get(`/v1/approvals/${approvalId}`);
  expect(step.status, JSON.stringify(step.body)).toBe(200);
  return authority.post(`/v1/approvals/${approvalId}/decision`, {
    body: { expectedVersion: (step.body as { version: number }).version, decision },
    ...(correlationId ? { correlationId } : {}),
  });
}

/**
 * Everything another tenant could ask about a tender, its bids and its
 * approvals. Each must be 404 — a 403 would confirm the record exists — and
 * none may change anything (each write body is valid, so the answer is the
 * tenant check, not validation).
 */
async function assertInvisibleToStranger(
  stranger: Actor,
  ids: { tenderId: string; bidIds?: string[]; approvalIds?: string[] },
): Promise<void> {
  const t = `/v1/tenders/${ids.tenderId}`;
  const probes: [string, () => Promise<ApiResponse<unknown>>][] = [
    ['read the tender', () => stranger.get(t)],
    ['list its invitations', () => stranger.get(`${t}/invitations`)],
    ['read its criteria', () => stranger.get(`${t}/criteria`)],
    ['list its approval requests', () => stranger.get(`${t}/approvals`)],
    ['list its bids', () => stranger.get(`${t}/bids`)],
    ['read the bid access log', () => stranger.get(`${t}/bid-access-log`)],
    ['read the evaluation', () => stranger.get(`${t}/evaluation`)],
    ['read the award', () => stranger.get(`${t}/award`)],
    ['edit it', () => send(stranger, 'PATCH', t, { expectedVersion: 1, title: 'Probe title' })],
    ['publish it', () => send(stranger, 'POST', `${t}/publish`, { expectedVersion: 1 })],
    ['propose opening', () => send(stranger, 'POST', `${t}/open-bids/proposal`, {})],
    ['open its bids', () => send(stranger, 'POST', `${t}/open-bids`, {})],
    [
      'cancel it',
      () =>
        send(stranger, 'POST', `${t}/cancel`, {
          expectedVersion: 1,
          reason: 'Probe from another tenant',
        }),
    ],
  ];
  for (const bidId of ids.bidIds ?? []) {
    probes.push(
      [`read bid ${bidId}`, () => stranger.get(`${t}/bids/${bidId}`)],
      [
        `qualify bid ${bidId}`,
        () => send(stranger, 'POST', `${t}/bids/${bidId}/qualification`, { decision: 'QUALIFIED' }),
      ],
      ['award it', () => send(stranger, 'POST', `${t}/award`, { bidId })],
    );
  }
  for (const approvalId of ids.approvalIds ?? []) {
    probes.push(
      [`read approval ${approvalId}`, () => stranger.get(`/v1/approvals/${approvalId}`)],
      [
        `decide approval ${approvalId}`,
        () =>
          stranger.post(`/v1/approvals/${approvalId}/decision`, {
            body: { expectedVersion: 1, decision: 'GRANT' },
          }),
      ],
    );
  }
  for (const [what, probe] of probes) {
    const response = await probe();
    expect(
      response.status,
      `another tenant tried to ${what}: ${JSON.stringify(response.body)}`,
    ).toBe(404);
  }
  const list = await stranger.get('/v1/tenders?limit=100');
  expect(list.status).toBe(200);
  expect((list.body as { items: { id: string }[] }).items.map((item) => item.id)).not.toContain(
    ids.tenderId,
  );
}

// ---------------------------------------------------------------------------

test.describe.serial('a tender, end to end (CON-002)', () => {
  let context: APIRequestContext;
  let tap: EconomicEventTap;

  const org = { owner: '', c1: '', c2: '', c3: '' };
  const supplier = { c1: '', c2: '' };
  let people: Record<
    'author' | 'p1' | 'p2' | 'evaluator' | 'awarder' | 'conflicted' | 'c1' | 'c2' | 'c3',
    Actor
  >;

  let projectId = '';
  let tenderId = '';
  let cancelledTenderId = '';
  const bid = { c1: '', c2: '' };
  const approvalIds: string[] = [];

  /** Correlation ids of the calls whose audit evidence is asserted at the end. */
  const evidence: { label: string; correlationId: string; events: string[] }[] = [];

  test.beforeAll(async ({ playwright }) => {
    context = await playwright.request.newContext();
    tap = await EconomicEventTap.start(config, config.constructionTopic);
  });

  test.afterAll(async () => {
    await tap?.stop();
    await context?.dispose();
  });

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
    org.owner = await organization(`E2E tender owner ${RUN}`, 'MUNICIPALITY', ORG.platform);
    org.c1 = await organization(`E2E contractor one ${RUN}`, 'COMPANY');
    org.c2 = await organization(`E2E contractor two ${RUN}`, 'COMPANY');
    org.c3 = await organization(`E2E contractor three ${RUN}`, 'COMPANY');

    const provision = async (
      label: string,
      organizationId: string,
      roles: string[],
    ): Promise<{ username: string; userId: string }> => {
      const username = `e2e.tender.${RUN}.${label}`;
      const created = await systemAdmin.post('/v1/users', {
        idempotencyKey: `e2e-tender-user-${username}`,
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
      conflicted: await provision('conflicted', org.owner, [OWNER_ROLE]),
      c1: await provision('c1', org.c1, ['CONTRACTOR']),
      c2: await provision('c2', org.c2, ['CONTRACTOR']),
      c3: await provision('c3', org.c3, ['CONTRACTOR']),
    };

    // The conflicted owner administrator also belongs to a bidding contractor,
    // in a role no bid-side rule excludes: the refusal is the membership alone.
    const second = await systemAdmin.post(`/v1/users/${accounts.conflicted.userId}/memberships`, {
      idempotencyKey: `e2e-tender-membership-${accounts.conflicted.username}`,
      body: { organizationId: org.c2, roles: ['OPERATOR'] },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);

    const expectedOrganization = {
      author: org.owner,
      p1: org.owner,
      p2: org.owner,
      evaluator: org.owner,
      awarder: org.owner,
      conflicted: org.owner,
      c1: org.c1,
      c2: org.c2,
      c3: org.c3,
    } as const;
    const signedIn = {} as typeof people;
    for (const [key, account] of Object.entries(accounts) as [
      keyof typeof accounts,
      (typeof accounts)['author'],
    ][]) {
      await enableSignIn(account.username);
      // The token names the platform user and acts for the organization it was
      // provisioned into — what every live-identity and conflict check reads.
      const token = await until(
        `a token for ${account.username} carrying its membership`,
        async () => {
          const candidate = await freshToken(account.username);
          const claims = membershipClaims(candidate);
          const ready =
            claims.rasta_uid === account.userId &&
            claims.org_id === expectedOrganization[key] &&
            (key !== 'conflicted' || (claims.org_ids ?? []).includes(org.c2));
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
      const contractor = people[key];
      const registered = await contractor.post('/v1/suppliers', {
        body: { displayName: `E2E contractor ${key} ${RUN}`, capabilities: ['CONTRACTING'] },
      });
      expect(registered.status, JSON.stringify(registered.body)).toBe(201);
      supplier[key] = (registered.body as { id: string }).id;

      const submitted = await contractor.post(`/v1/suppliers/${supplier[key]}/qualifications`, {
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
  async function activatePolicy(
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
    const policyId = (created.body as { id: string }).id;
    const submitted = await union.post(`/v1/approval-policies/${policyId}/submit`, {
      body: { expectedVersion: 1 },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const approved = await platform.post(`/v1/approval-policies/${policyId}/approve`, {
      body: { expectedVersion: (submitted.body as { version: number }).version },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'ACTIVE', workflowKey });
  }

  test('a project is approved under the owner’s own execution policy', async ({
    platformAdmin,
    systemAdmin,
  }) => {
    await activatePolicy(
      platformAdmin,
      systemAdmin,
      'project.execution',
      'Execution approval (sample)',
    );

    const { author, p1 } = people;
    const created = await author.post('/v1/projects', {
      body: {
        title: 'بهسازی راه روستایی',
        operationType: 'road',
        scopeOfWork: 'Resurfacing of the access road',
        locationDescription: 'Access road, east side',
        estimatedCostMinor: '5000000000',
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
          {
            body: { expectedVersion: 1 },
          },
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

  test('a tender is drafted, and no publication policy means no publication (Q-84)', async ({
    tenantB,
  }) => {
    const { author } = people;
    const draft = async (title: string): Promise<TenderBody> => {
      const created = await author.post(`/v1/projects/${projectId}/tenders`, {
        body: { title, scopeOfWork: 'Resurfacing of two kilometres of the access road' },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ status: 'DRAFT', version: 1 });
      return created.body as TenderBody;
    };
    tenderId = (await draft('Access road resurfacing')).id;
    cancelledTenderId = (await draft('Access road drainage')).id;

    let current = await tender(author, tenderId);
    const shaped = await send(author, 'PATCH', `/v1/tenders/${tenderId}`, {
      expectedVersion: current.version,
      procurementNature: 'FORMAL_TENDER',
      visibility: 'RESTRICTED',
      // A provisional window; the real one is set just before publication.
      bidOpeningAt: new Date().toISOString(),
      bidClosingAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(shaped.status, JSON.stringify(shaped.body)).toBe(200);

    for (const invited of [org.c1, org.c2]) {
      const invitation = await send(author, 'POST', `/v1/tenders/${tenderId}/invitations`, {
        organizationId: invited,
      });
      expect(invitation.status, JSON.stringify(invitation.body)).toBe(201);
    }

    current = await tender(author, tenderId);
    const criteria = await send(author, 'PUT', `/v1/tenders/${tenderId}/criteria`, {
      expectedVersion: current.version,
      criteria: CRITERIA,
    });
    expect(criteria.status, JSON.stringify(criteria.body)).toBe(200);
    expect(criteria.body).toMatchObject({ totalWeightBp: 10_000, complete: true });

    // Everything a publication needs is in place but the policy: refused, and
    // no approval request is opened — an absent policy is not "nothing to approve".
    current = await tender(author, tenderId);
    const refused = await send(author, 'POST', `/v1/tenders/${tenderId}/publish`, {
      expectedVersion: current.version,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('APPROVAL_POLICY_REQUIRED');
    expect(await requests(author, tenderId, 'tender.publication')).toEqual([]);
    expect((await tender(author, tenderId)).status).toBe('DRAFT');

    await assertInvisibleToStranger(tenantB, { tenderId });
    await assertInvisibleToStranger(tenantB, { tenderId: cancelledTenderId });
  });

  test('the union writes the three tender policies and the platform approves them', async ({
    platformAdmin,
    systemAdmin,
  }) => {
    await activatePolicy(
      platformAdmin,
      systemAdmin,
      'tender.publication',
      'Publication approval (sample)',
    );
    await activatePolicy(platformAdmin, systemAdmin, 'tender.award', 'Award approval (sample)');
    await activatePolicy(
      platformAdmin,
      systemAdmin,
      'tender.cancellation',
      'Cancellation approval (sample)',
    );
  });

  test('publication: requested, refused to its requester, granted by a second person, executed once', async ({
    tenantB,
  }) => {
    const { author, p1 } = people;

    // The real window, from now: the bids must arrive inside it.
    let current = await tender(author, tenderId);
    const window = await send(author, 'PATCH', `/v1/tenders/${tenderId}`, {
      expectedVersion: current.version,
      bidOpeningAt: new Date().toISOString(),
      bidClosingAt: new Date(Date.now() + BIDDING_WINDOW_MS).toISOString(),
    });
    expect(window.status, JSON.stringify(window.body)).toBe(200);
    current = window.body as TenderBody;

    const asked = await send(author, 'POST', `/v1/tenders/${tenderId}/publish`, {
      expectedVersion: current.version,
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const request = asked.body as RequestBody;
    expect(request).toMatchObject({
      tenderId,
      workflowKey: 'tender.publication',
      status: 'PENDING',
      tenderVersion: current.version,
    });
    expect(request.steps).toHaveLength(1);
    const step = request.steps[0]!.approvalId;
    approvalIds.push(step);
    expect((await tender(author, tenderId)).status).toBe('DRAFT');

    // The requester holds the step's role in its organization — and is still
    // refused: the person who asks is never the person who approves.
    const self = correlation('self-approval');
    const own = await decide(author, step, 'GRANT', self);
    expect(own.status, JSON.stringify(own.body)).toBe(403);
    expect(errorCode(own.body)).toBe('FORBIDDEN');
    evidence.push({
      label: 'self-approval refused',
      correlationId: self,
      events: ['TENDER_APPROVAL_ACTION'],
    });

    await assertInvisibleToStranger(tenantB, { tenderId, approvalIds: [step] });

    const granted = await decide(p1, step);
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    expect(granted.body).toMatchObject({ status: 'GRANTED' });
    expect((await tender(author, tenderId)).status).toBe('DRAFT');

    // The same command, on the same version, now executes and uses the approval up.
    const published = correlation('publish');
    const executed = await send(
      author,
      'POST',
      `/v1/tenders/${tenderId}/publish`,
      { expectedVersion: current.version },
      published,
    );
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    expect(executed.body).toMatchObject({ id: tenderId, status: 'PUBLISHED' });
    evidence.push({
      label: 'publication executed',
      correlationId: published,
      events: ['TENDER_PUBLISHED', 'TENDER_APPROVAL_ACTION'],
    });

    const [consumed] = await requests(author, tenderId, 'tender.publication');
    expect(consumed).toMatchObject({ id: request.id, status: 'CONSUMED' });

    // Executed once: neither the old version nor the new one publishes again.
    const after = await tender(author, tenderId);
    for (const expectedVersion of [current.version, after.version]) {
      const again = await send(author, 'POST', `/v1/tenders/${tenderId}/publish`, {
        expectedVersion,
      });
      expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(400);
      expect(again.status).toBeLessThan(500);
    }
    expect(await tender(author, tenderId)).toMatchObject({
      status: 'PUBLISHED',
      version: after.version,
    });
    expect(await requests(author, tenderId, 'tender.publication')).toHaveLength(1);
  });

  test('two qualified contractors bid; nobody else reads a bid, and a bidder reads only its own', async ({
    tenantB,
  }) => {
    const { author, p1, c1, c2, c3 } = people;
    const content = (price: string, note: string) => ({
      content: {
        priceMinor: price,
        answers: [
          { criterionCode: 'technical', response: `Method statement — ${note}` },
          { criterionCode: 'compliance', response: 'All documents attached to the file' },
        ],
      },
    });

    for (const [key, contractor] of [
      ['c1', c1],
      ['c2', c2],
    ] as const) {
      const submitted = await send(
        contractor,
        'POST',
        `/v1/tenders/${tenderId}/bids`,
        content(PRICE[key], key),
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
      const receipt = submitted.body as ReceiptBody;
      expect(receipt).toMatchObject({ tenderId, status: 'SUBMITTED', revision: 1 });
      expect(receipt.receipt).toMatch(/^[0-9a-f]{64}$/);
      // The content is sealed: the answer is the receipt, never what was sent.
      expect(JSON.stringify(receipt)).not.toContain(PRICE[key]);
      bid[key] = receipt.bidId;
    }

    // Each bidder sees its own receipt — no content, and not the other's.
    for (const [key, contractor] of [
      ['c1', c1],
      ['c2', c2],
    ] as const) {
      const mine = await contractor.get(`/v1/tenders/${tenderId}/bids/mine`);
      expect(mine.status, JSON.stringify(mine.body)).toBe(200);
      expect(mine.body).toMatchObject({ bidId: bid[key], status: 'SUBMITTED' });
      expect(JSON.stringify(mine.body)).not.toContain(PRICE[key]);
    }

    // A bidder asking for the other bidder's bid gets exactly what it gets for
    // a bid that does not exist: the refusal says nothing about the other.
    //
    // FINDING F3 (#223): the owner route refuses a contractor of another
    // organization **403** (`assertCanOpenBids`, a role check, runs before the
    // ownership check), where ADR-066 § 4 says 404 for every other
    // organization. Nothing is disclosed — the answer is the same for a bid that
    // does not exist, which is asserted — but the status is not the ADR's. It is
    // asserted as it is, and named, so that the fix changes this line.
    const OWNER_ROUTE_REFUSAL = 403;
    const missing = `BID_${RUN}_MISSING`;
    const otherAndMissing: [string, number, (bidId: string) => Promise<ApiResponse<unknown>>][] = [
      [
        'read through the owner route',
        OWNER_ROUTE_REFUSAL,
        (id) => c1.get(`/v1/tenders/${tenderId}/bids/${id}`),
      ],
      [
        'replace',
        404,
        (id) =>
          send(c1, 'PUT', `/v1/tenders/${tenderId}/bids/${id}`, {
            expectedRevision: 1,
            ...content('1', 'probe'),
          }),
      ],
      [
        'withdraw',
        404,
        (id) =>
          send(c1, 'POST', `/v1/tenders/${tenderId}/bids/${id}/withdraw`, { expectedRevision: 1 }),
      ],
    ];
    for (const [what, status, probe] of otherAndMissing) {
      const other = refusalOf(await probe(bid.c2));
      expect(other.status, `a bidder tried to ${what} another bidder's bid`).toBe(status);
      expect(other, `${what}: the other bidder's bid against a missing one`).toEqual(
        refusalOf(await probe(missing)),
      );
    }

    // A contractor that did not bid reads nothing.
    const nonBidder = await c3.get(`/v1/tenders/${tenderId}/bids/mine`);
    expect(nonBidder.status, JSON.stringify(nonBidder.body)).toBe(404);
    for (const id of [bid.c1, bid.c2]) {
      const asOwner = refusalOf(await c3.get(`/v1/tenders/${tenderId}/bids/${id}`));
      expect(asOwner.status).toBe(OWNER_ROUTE_REFUSAL);
      expect(asOwner).toEqual(refusalOf(await c3.get(`/v1/tenders/${tenderId}/bids/${missing}`)));
      // C3 is not qualified: the eligibility gate answers before anything about
      // the tender is looked at — the same answer as for a tender that does not exist.
      const replace = (path: string) =>
        send(c3, 'PUT', path, { expectedRevision: 1, ...content('1', 'probe') });
      const replaced = refusalOf(await replace(`/v1/tenders/${tenderId}/bids/${id}`));
      expect(replaced.status).toBeGreaterThanOrEqual(400);
      expect(replaced).toEqual(
        refusalOf(await replace(`/v1/tenders/TND_${RUN}_MISSING/bids/${id}`)),
      );
    }

    // The owner, before the opening: how many and when — not who, not what.
    const counted = await author.get(`/v1/tenders/${tenderId}/bids`);
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(counted.body).toMatchObject({ opened: false, bidCount: 2, bids: [] });
    expect(JSON.stringify(counted.body)).not.toContain(org.c1);
    expect(JSON.stringify(counted.body)).not.toContain(PRICE.c1);

    // Nothing opens before the deadline.
    const early = await send(p1, 'POST', `/v1/tenders/${tenderId}/open-bids/proposal`, {});
    expect(early.status, JSON.stringify(early.body)).toBe(422);
    expect(JSON.stringify(early.body)).toContain('NOT_CLOSED');

    await assertInvisibleToStranger(tenantB, { tenderId, bidIds: [bid.c1, bid.c2] });
  });

  test('the deadline closes the tender, and a bid after it is refused', async () => {
    const { author, c1 } = people;
    const closingAt = Date.parse((await tender(author, tenderId)).bidClosingAt!);
    // The sweeper closes it within one interval of the deadline (ADR-065 § 3).
    const waitMs = Math.max(0, closingAt - Date.now()) + 60_000;
    test.setTimeout(waitMs + 60_000);

    await until(
      'the sweeper to close the tender',
      async () => ((await tender(author, tenderId)).status === 'CLOSED' ? true : undefined),
      waitMs,
    );

    const late = await send(c1, 'PUT', `/v1/tenders/${tenderId}/bids/${bid.c1}`, {
      expectedRevision: 1,
      content: {
        priceMinor: '1',
        answers: [{ criterionCode: 'technical', response: 'Too late' }],
      },
    });
    expect(late.status, JSON.stringify(late.body)).toBe(422);
    const mine = await c1.get(`/v1/tenders/${tenderId}/bids/mine`);
    expect(mine.body).toMatchObject({ bidId: bid.c1, revision: 1 });
  });

  test('opening takes two people (Q-91) and opens against audit-service’s receipts', async ({
    tenantB,
  }) => {
    const { author, p1, p2 } = people;

    const proposed = await send(p1, 'POST', `/v1/tenders/${tenderId}/open-bids/proposal`, {});
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);

    const alone = await send(p1, 'POST', `/v1/tenders/${tenderId}/open-bids`, {});
    expect(alone.status, JSON.stringify(alone.body)).toBe(422);
    expect(JSON.stringify(alone.body)).toContain('SECOND_PERSON_REQUIRED');
    expect((await tender(author, tenderId)).status).toBe('CLOSED');

    // audit-service may still be catching up with the last receipts: 503 means
    // "not yet", and nothing is opened until it has them all.
    const opening = correlation('open-bids');
    const opened = await until(
      'the second person to open the bids',
      async () => {
        const response = await send(p2, 'POST', `/v1/tenders/${tenderId}/open-bids`, {}, opening);
        if (response.status === 503) return undefined;
        return response;
      },
      60_000,
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body).toMatchObject({ tenderId, status: 'EVALUATING', bidCount: 2 });
    evidence.push({ label: 'bids opened', correlationId: opening, events: ['BIDS_OPENED'] });

    const listed = await author.get(`/v1/tenders/${tenderId}/bids`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const bids = (listed.body as { bids: OpenedBid[] }).bids;
    expect(bids).toHaveLength(2);
    const byOrganization = Object.fromEntries(bids.map((b) => [b.bidderOrganizationId, b]));
    expect(byOrganization[org.c1]).toMatchObject({
      bidId: bid.c1,
      status: 'OPENED',
      content: { priceMinor: PRICE.c1 },
    });
    expect(byOrganization[org.c2]).toMatchObject({
      bidId: bid.c2,
      status: 'OPENED',
      content: { priceMinor: PRICE.c2 },
    });

    await assertInvisibleToStranger(tenantB, { tenderId, bidIds: [bid.c1, bid.c2] });
  });

  test('a member of a bidding organization is refused the evaluation (conflict of interest)', async () => {
    const coi = correlation('conflict-of-interest');
    const refused = await people.conflicted.get(`/v1/tenders/${tenderId}/evaluation`, {
      correlationId: coi,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain(PRICE.c2);
    evidence.push({
      label: 'conflict of interest refused',
      correlationId: coi,
      events: ['BID_ACCESSED'],
    });
  });

  test('the evaluator qualifies and scores both bids and completes the evaluation', async () => {
    const { evaluator } = people;
    const scores = { c1: [900, 100], c2: [700, 100] } as const;
    for (const key of ['c1', 'c2'] as const) {
      const qualified = await send(
        evaluator,
        'POST',
        `/v1/tenders/${tenderId}/bids/${bid[key]}/qualification`,
        {
          decision: 'QUALIFIED',
        },
      );
      expect(qualified.status, JSON.stringify(qualified.body)).toBe(200);
      expect(qualified.body).toMatchObject({ bidId: bid[key], decision: 'QUALIFIED' });

      const scored = await send(
        evaluator,
        'POST',
        `/v1/tenders/${tenderId}/bids/${bid[key]}/scores`,
        {
          scores: [
            { criterionCode: 'technical', scoreScaled: scores[key][0] },
            { criterionCode: 'compliance', scoreScaled: scores[key][1] },
          ],
        },
      );
      expect(scored.status, JSON.stringify(scored.body)).toBe(200);
      expect(scored.body).toMatchObject({ complete: true });
    }

    const evaluating = correlation('evaluate');
    const evaluated = await send(
      evaluator,
      'POST',
      `/v1/tenders/${tenderId}/evaluate`,
      {},
      evaluating,
    );
    expect(evaluated.status, JSON.stringify(evaluated.body)).toBe(200);
    expect(evaluated.body).toMatchObject({ status: 'EVALUATED', qualifiedBidCount: 2 });
    evidence.push({
      label: 'evaluation completed',
      correlationId: evaluating,
      events: ['BIDS_EVALUATED'],
    });

    const matrix = await evaluator.get(`/v1/tenders/${tenderId}/evaluation`);
    expect(matrix.status, JSON.stringify(matrix.body)).toBe(200);
    const ranked = (matrix.body as { bids: { bidId: string; rank: number; tied: boolean }[] }).bids;
    expect(ranked.find((row) => row.bidId === bid.c1)).toMatchObject({ rank: 1, tied: false });
    expect(ranked.find((row) => row.bidId === bid.c2)).toMatchObject({ rank: 2 });
  });

  test('award: never by an evaluator, approved by a second person, bound to what was approved', async ({
    tenantB,
  }) => {
    const { author, p1, evaluator, awarder } = people;

    // AWARDER_NOT_EVALUATOR (on by default): the evaluator does not award.
    const byEvaluator = correlation('awarder-is-evaluator');
    const refused = await send(
      evaluator,
      'POST',
      `/v1/tenders/${tenderId}/award`,
      { bidId: bid.c1 },
      byEvaluator,
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    evidence.push({
      label: 'awarder is evaluator refused',
      correlationId: byEvaluator,
      events: ['BID_ACCESSED'],
    });

    const asked = await send(awarder, 'POST', `/v1/tenders/${tenderId}/award`, { bidId: bid.c1 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const first = asked.body as RequestBody;
    expect(first).toMatchObject({ workflowKey: 'tender.award', status: 'PENDING' });
    const step = first.steps[0]!.approvalId;
    approvalIds.push(step);

    // Nor does the evaluator approve it — and the requester never does.
    // It names the bid and the justification, so even reading it is held to the
    // award's rules (Q-84, PR 11 addendum (3)).
    expect((await evaluator.get(`/v1/approvals/${step}`)).status).toBe(403);
    const evaluatorApproves = correlation('approver-is-evaluator');
    const byEvaluatorStep = await decide(evaluator, step, 'GRANT', evaluatorApproves, p1);
    expect(byEvaluatorStep.status, JSON.stringify(byEvaluatorStep.body)).toBe(403);
    evidence.push({
      label: 'approver is evaluator refused',
      correlationId: evaluatorApproves,
      events: ['TENDER_APPROVAL_ACTION'],
    });
    expect((await decide(awarder, step)).status).toBe(403);

    await assertInvisibleToStranger(tenantB, { tenderId, bidIds: [bid.c1], approvalIds: [step] });

    expect((await decide(p1, step)).status).toBe(200);
    expect((await requests(author, tenderId, 'tender.award'))[0]).toMatchObject({
      id: first.id,
      status: 'APPROVED',
    });

    // What is executed must be what was approved: the same award with a reason
    // added is a different decision. Nothing is awarded, and the approval ends.
    const changing = correlation('approval-stale');
    const stale = await send(
      awarder,
      'POST',
      `/v1/tenders/${tenderId}/award`,
      { bidId: bid.c1, justification: 'A reason the approver never saw' },
      changing,
    );
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(JSON.stringify(stale.body)).toContain('APPROVAL_STALE');
    evidence.push({
      label: 'stale approval refused',
      correlationId: changing,
      events: ['TENDER_APPROVAL_ACTION'],
    });
    expect(
      (await requests(author, tenderId, 'tender.award')).find((r) => r.id === first.id),
    ).toMatchObject({
      status: 'STALE',
    });
    expect((await tender(author, tenderId)).status).toBe('EVALUATED');
  });

  test('the winner’s standing is asked at execution: suspended is refused, reinstated is awarded', async ({
    systemAdmin,
    tenantB,
  }) => {
    const { author, p1, awarder, c1, c2 } = people;

    const asked = await send(awarder, 'POST', `/v1/tenders/${tenderId}/award`, { bidId: bid.c1 });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const request = asked.body as RequestBody;
    approvalIds.push(request.steps[0]!.approvalId);
    expect((await decide(p1, request.steps[0]!.approvalId)).status).toBe(200);

    // An approval never replaces supplier-service's word on the winner now.
    const suspended = await systemAdmin.post(`/v1/suppliers/${supplier.c1}/suspend`, {
      body: { reason: 'E2E: standing checked when the award executes' },
    });
    expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
    const notEligible = await send(awarder, 'POST', `/v1/tenders/${tenderId}/award`, {
      bidId: bid.c1,
    });
    expect(notEligible.status, JSON.stringify(notEligible.body)).toBe(422);
    expect(JSON.stringify(notEligible.body)).toContain('WINNER_NOT_ELIGIBLE');
    expect((await tender(author, tenderId)).status).toBe('EVALUATED');

    const reinstated = await systemAdmin.post(`/v1/suppliers/${supplier.c1}/reinstate`, {
      body: { reason: 'E2E: the suspension is lifted again' },
    });
    expect(reinstated.status, JSON.stringify(reinstated.body)).toBe(200);

    const awarding = correlation('award');
    const awarded = await until(
      'the award to execute against audit-service’s receipts',
      async () => {
        const response = await send(
          awarder,
          'POST',
          `/v1/tenders/${tenderId}/award`,
          { bidId: bid.c1 },
          awarding,
        );
        return response.status === 503 ? undefined : response;
      },
      60_000,
    );
    expect(awarded.status, JSON.stringify(awarded.body)).toBe(200);
    expect(awarded.body).toMatchObject({
      tenderId,
      status: 'AWARDED',
      bidId: bid.c1,
      bidderOrganizationId: org.c1,
    });
    evidence.push({
      label: 'award executed',
      correlationId: awarding,
      events: ['TENDER_AWARDED', 'BID_NOT_AWARDED'],
    });
    expect(
      (await requests(author, tenderId, 'tender.award')).find((r) => r.id === request.id),
    ).toMatchObject({
      status: 'CONSUMED',
    });

    // The price lives on the award record, read by the owner's authorised person.
    const record = await awarder.get(`/v1/tenders/${tenderId}/award`);
    expect(record.status, JSON.stringify(record.body)).toBe(200);
    expect(record.body).toMatchObject({ bidId: bid.c1, amountMinor: PRICE.c1 });

    // Each contractor reads its own opened bid and total — no rank, no other bidder.
    const own1 = await c1.get(`/v1/tenders/${tenderId}/bids/mine/opened`);
    expect(own1.status, JSON.stringify(own1.body)).toBe(200);
    expect(own1.body).toMatchObject({
      bidId: bid.c1,
      status: 'AWARDED',
      content: { priceMinor: PRICE.c1 },
    });
    const own2 = await c2.get(`/v1/tenders/${tenderId}/bids/mine/opened`);
    expect(own2.status, JSON.stringify(own2.body)).toBe(200);
    expect(own2.body).toMatchObject({
      bidId: bid.c2,
      status: 'NOT_AWARDED',
      content: { priceMinor: PRICE.c2 },
    });
    for (const leak of [PRICE.c1, bid.c1, org.c1])
      expect(JSON.stringify(own2.body)).not.toContain(leak);

    await assertInvisibleToStranger(tenantB, { tenderId, bidIds: [bid.c1, bid.c2], approvalIds });
  });

  test('a second tender is cancelled through tender.cancellation', async ({ tenantB }) => {
    const { author, p1 } = people;
    const current = await tender(author, cancelledTenderId);
    const body = {
      expectedVersion: current.version,
      reason: 'The drainage works were merged into the road tender',
    };

    const asked = await send(author, 'POST', `/v1/tenders/${cancelledTenderId}/cancel`, body);
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const request = asked.body as RequestBody;
    expect(request).toMatchObject({
      workflowKey: 'tender.cancellation',
      status: 'PENDING',
      reasonCode: 'OWNER_REQUEST',
    });
    expect((await tender(author, cancelledTenderId)).status).toBe('DRAFT');

    await assertInvisibleToStranger(tenantB, {
      tenderId: cancelledTenderId,
      approvalIds: [request.steps[0]!.approvalId],
    });
    expect((await decide(p1, request.steps[0]!.approvalId)).status).toBe(200);

    const cancelling = correlation('cancel');
    const cancelled = await send(
      author,
      'POST',
      `/v1/tenders/${cancelledTenderId}/cancel`,
      body,
      cancelling,
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      statusReasonCode: 'OWNER_REQUEST',
    });
    evidence.push({
      label: 'cancellation executed',
      correlationId: cancelling,
      events: ['TENDER_CANCELLED'],
    });
    expect((await requests(author, cancelledTenderId, 'tender.cancellation'))[0]).toMatchObject({
      id: request.id,
      status: 'CONSUMED',
    });
    await assertInvisibleToStranger(tenantB, { tenderId: cancelledTenderId });
  });

  test('audit-service holds every decision and every refusal, and the topic says which refusal', async ({
    systemAdmin,
  }) => {
    test.setTimeout(240_000);

    interface AuditItem {
      organizationId: string | null;
      correlationId: string;
      sourceTopic: string;
      sourceEventName: string;
      resourceId: string | null;
    }
    for (const entry of evidence) {
      const records = await until(
        `audit records ${entry.events.join(', ')} for ${entry.label}`,
        async () => {
          const to = new Date(Date.now() + 60_000);
          const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
          const parameters = new URLSearchParams({
            from: from.toISOString(),
            to: to.toISOString(),
            correlationId: entry.correlationId,
            limit: '50',
          }).toString();
          const response = await systemAdmin.get(`/v1/audit-events?${parameters}`);
          if (response.status !== 200) return undefined;
          const items = (response.body as { items: AuditItem[] }).items;
          const names = new Set(items.map((item) => item.sourceEventName));
          return entry.events.every((name) => names.has(name)) ? items : undefined;
        },
        120_000,
      );
      for (const record of records.filter((item) => entry.events.includes(item.sourceEventName))) {
        expect(record, entry.label).toMatchObject({
          organizationId: org.owner,
          correlationId: entry.correlationId,
          sourceTopic: config.constructionTopic,
        });
      }
    }

    // audit-service keeps no payload (path A), so which refusal it was is read
    // on the topic, under the same correlation id.
    const refusal = async (label: string, eventName: string): Promise<ObservedEvent> => {
      const entry = evidence.find((item) => item.label === label)!;
      const events = await tap.awaitCorrelated(entry.correlationId, [eventName]);
      return events.find((event) => event.eventName === eventName)!;
    };
    expect(
      (await refusal('self-approval refused', 'TENDER_APPROVAL_ACTION')).payload,
    ).toMatchObject({
      tenderId,
      workflowKey: 'tender.publication',
      action: 'GRANT',
      outcome: 'REFUSED',
    });
    expect((await refusal('conflict of interest refused', 'BID_ACCESSED')).payload).toMatchObject({
      tenderId,
      refusalCode: 'CONFLICT_OF_INTEREST',
    });
    expect((await refusal('awarder is evaluator refused', 'BID_ACCESSED')).payload).toMatchObject({
      tenderId,
      refusalCode: 'AWARDER_IS_EVALUATOR',
    });
    expect(
      (await refusal('approver is evaluator refused', 'TENDER_APPROVAL_ACTION')).payload,
    ).toMatchObject({
      tenderId,
      workflowKey: 'tender.award',
      outcome: 'REFUSED',
      refusalCode: 'APPROVER_IS_EVALUATOR',
    });
    expect(
      (await refusal('stale approval refused', 'TENDER_APPROVAL_ACTION')).payload,
    ).toMatchObject({
      tenderId,
      workflowKey: 'tender.award',
      action: 'STALE',
    });

    // Every event of this tender was published under the owner's tenant and the
    // tender's key, and no event carried a bid price (ADR-066 § 6).
    for (const entry of evidence) {
      for (const event of tap.correlated(entry.correlationId)) {
        expect(event.tenantId).toBe(org.owner);
        expect([tenderId, cancelledTenderId]).toContain(event.key);
        expect(JSON.stringify(event.payload)).not.toContain(PRICE.c1);
        expect(JSON.stringify(event.payload)).not.toContain(PRICE.c2);
      }
    }
  });
});
