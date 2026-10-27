import { randomUUID } from 'node:crypto';
import {
  test,
  expect,
  errorCode,
  idempotencyKey,
  Actor,
  SessionToken,
  until,
  type ApiResponse,
} from '../../src/api';
import { expectNotDisclosed } from '@rasta/testing';
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
 *   `tenantB` (`ORG-DEH-0002`) is the other seeded tenant. A **consultant**, an organization
 *   that is neither party, is named by the first step of the statements' technical chain
 *   (Q-96 (1)).
 * - **People** (`system.admin`, identity-service — real memberships): in the owner, all
 *   `ORGANIZATION_ADMIN`: `author`, `p1`, `p2`, `evaluator`, `awarder` (the tender flow),
 *   `plain` (no signing authority), `signer` (also `FLEET_MANAGER`, the role the signing policy
 *   names) and `dual` (also a `CONTRACTOR` member of C1). One `CONTRACTOR` in each of C1, C2, C3,
 *   and a second in C1 (`c1b`). `tech`, the consultant's `ORGANIZATION_ADMIN`.
 * - **Policies**: `project.execution`, `tender.publication`, `tender.award` for the owner in
 *   construction-service (`union.admin` writes, `system.admin` approves), then — later in the
 *   run, once a signature has been refused for want of one — `contract.signature` in
 *   contract-service, naming the owner's own `FLEET_MANAGER` role, and — once a submission has
 *   been refused for want of them — `contract.statement.technical` (the consultant, then the
 *   owner) and `contract.statement.financial` (the owner). Samples; no legal authority is
 *   claimed (ADR-023, Q-02).
 *
 * ## Statements (CON-003 PR 4 to 6)
 *
 * On contract A, after its amendment and milestone: C1 drafts and submits two statements; both
 * approval chains are decided by different people, the same person twice is refused, a replayed
 * decision answers its first response, and the second statement's financial approval would take
 * the approved total past the price and the effective amendment, so it is refused. They run
 * before the organization move: a union-written chain policy is confirmed with
 * organization-service at submission (Q-70 (7)). No deduction is applied: no route writes a
 * deduction rule yet (Q-125), so a statement can only name one to be refused, and its net is its
 * gross.
 *
 * ## Through the front door
 *
 * Every call goes through api-gateway with a real user token, the `contract.signature` policy
 * included: contract-service serves it under `/v1/contract-approval-policies`, a first path
 * segment the gateway routes to it (#243). Nothing here reaches a service directly.
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
const SUSPENSION_WAIT_MS = 120_000;
const FLAG_WAIT_MS = 60_000;

/**
 * The declared waits. A test that polls sets its own timeout to the sum of its waits plus
 * HTTP_WORK_MS, so no wait is cut short by the 120 s default it would otherwise inherit.
 */
const TOKEN_WAIT_MS = 30_000;
/** One wait out of audit-service's 503s while the evidence a step needs is not in yet. */
const AUDIT_CATCH_UP_MS = 60_000;
const DRAFT_WAIT_MS = 90_000;
const AUDIT_RECORDS_WAIT_MS = 180_000;
const EVENTS_WAIT_MS = 60_000;
/** The HTTP calls of a test around its waits, and the last poll that overruns a deadline. */
const HTTP_WORK_MS = 120_000;

/** The least that must be left of the window when a step that needs it open starts. */
const WINDOW_MARGIN_MS = 15_000;

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
  tech: 'مشاور ناظر',
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

/**
 * The statements of contract A, minor units. The first is approved; the second would take the
 * approved total (gross, Q-96 (5)) past the price plus the effective amendment — 4 200 000 000 +
 * 500 000 000 — so its final approval is refused.
 */
const STATEMENT_ONE_LINES = ['1100000000', '400000000'] as const;
const STATEMENT_ONE_GROSS = '1500000000';
const STATEMENT_TWO_GROSS = '3300000000';
/** How a statement line is worded: `<this>, section <n>`. */
const STATEMENT_LINE_WORDING = 'Resurfacing works';

/**
 * What no refusal may repeat: every amount of contract A — its price, the amendments, the cap
 * they make, each statement line, each gross and the total the second statement would make — and
 * the lines' wording.
 */
const SCENARIO_VALUES: readonly string[] = [
  PRICE.A.c1,
  AMENDMENT_ONE,
  AMENDMENT_TWO,
  (BigInt(PRICE.A.c1) + BigInt(AMENDMENT_ONE)).toString(),
  ...STATEMENT_ONE_LINES,
  STATEMENT_ONE_GROSS,
  STATEMENT_TWO_GROSS,
  (BigInt(STATEMENT_ONE_GROSS) + BigInt(STATEMENT_TWO_GROSS)).toString(),
  STATEMENT_LINE_WORDING,
];

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

interface ChainBody {
  policyId: string;
  policyVersion: number;
  steps: {
    stepOrder: number;
    authorityOrganizationId: string;
    authorityRole: string;
    decision: { outcome: string; decidedAt: string } | null;
  }[];
}

interface StatementBody {
  id: string;
  contractId: string;
  organizationId: string;
  contractorOrganizationId: string;
  statementNumber: number;
  status: string;
  grossMinor: string;
  deductionsMinor: string;
  netMinor: string;
  lines: { lineNumber: number; amountMinor: string; milestoneId: string | null }[];
  deductions: unknown[];
  submittedAt: string | null;
  approvalChains: { technical: ChainBody; financial: ChainBody } | null;
  version: number;
}

// ---------------------------------------------------------------------------
// Helpers — thin: each adds headers or polls, and none decides an outcome.
// ---------------------------------------------------------------------------

/**
 * A correlation id this file can later find on the topic. A bare UUID: the
 * gateway adopts nothing else from a caller and would re-mint a labelled one.
 * `_label` names the step for the reader only.
 */
function correlation(_label: string): string {
  return randomUUID();
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

/** The closed reasons of a refusal: every `details[].code` of the error body (docs/06 § 6.7). */
function reasonsOf(body: unknown): string[] {
  const details = (body as { details?: unknown } | null)?.details;
  if (!Array.isArray(details)) return [];
  return details.flatMap((detail) => {
    const code = (detail as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? [code] : [];
  });
}

/** The closed reason of a refusal: the first `details[].code` of the error body (docs/06 § 6.7). */
function reasonOf(body: unknown): string | undefined {
  return reasonsOf(body)[0];
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

/**
 * A stranger's write must be a 404 that is, in status, code, message and details, the answer
 * the same request gets against a record that does not exist.
 */
async function expectMissingLike(
  response: ApiResponse<unknown>,
  againstMissing: Promise<ApiResponse<unknown>>,
  what: string,
): Promise<void> {
  expectRefusal(response, NOT_FOUND, what);
  expect(refusalOf(response), `${what}: against a record that is not there`).toEqual(
    refusalOf(await againstMissing),
  );
}

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

/** An error body's request metadata: it differs by construction and is left out of a comparison. */
const REQUEST_METADATA: readonly string[] = ['correlationId', 'traceId', 'timestamp', 'path'];

/** A refusal's closed reason, as contract-service words it (`refusalDetails`, docs/06 § 6.7). */
function decisionReason(code: string): { path: string; code: string; message: string }[] {
  return [{ path: 'decision', code, message: `Statement cannot be decided: ${code}` }];
}

/**
 * A refusal that says what it is meant to and nothing more (S-09): the request's metadata aside,
 * its body is exactly the platform code, the fixed message and the closed reasons expected — no
 * other key — and no value of the scenario, an amount or a line's wording, appears anywhere in it,
 * metadata included. `expectRefusal` alone would pass a 403 whose message quoted the statement.
 */
function expectRefusalExactly(
  response: ApiResponse<unknown>,
  expected: {
    status: number;
    code: string;
    message: string;
    details?: { path: string; code: string; message: string }[];
  },
  what: string,
): void {
  const text = JSON.stringify(response.body);
  expect(response.status, `${what}: ${text}`).toBe(expected.status);
  const said = Object.fromEntries(
    Object.entries((response.body ?? {}) as Record<string, unknown>).filter(
      ([key]) => !REQUEST_METADATA.includes(key),
    ),
  );
  expect(said, `${what}: ${text}`).toEqual({
    code: expected.code,
    message: expected.message,
    ...(expected.details ? { details: expected.details } : {}),
  });
  for (const value of SCENARIO_VALUES) {
    expectNotDisclosed(response.body, [value]);
  }
}

/** The role guard's refusal of the oversight role (`RastaError.insufficientRole`): no details. */
const OVERSIGHT_REFUSED = {
  status: 403,
  code: 'INSUFFICIENT_ROLE',
  message: 'You do not have permission to perform this action',
} as const;

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

/** A statement's draft body: one line per amount, numbered by the service in this order. */
function statementLines(amounts: readonly string[], milestoneId?: string) {
  return amounts.map((amountMinor, index) => ({
    description: `${STATEMENT_LINE_WORDING}, section ${index + 1}`,
    amountMinor,
    ...(index === 0 && milestoneId ? { milestoneId } : {}),
  }));
}

/**
 * Everything another organization could ask about a contract, its amendments, its milestones
 * and its statements. Each must be 404 — a 403 would confirm the record exists — and none may
 * change anything (each write body is valid, so the answer is the tenant check, not validation).
 */
async function assertInvisibleToStranger(
  stranger: Actor,
  ids: {
    contractId: string;
    amendmentIds?: string[];
    milestoneIds?: string[];
    statementIds?: string[];
  },
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
      ['list its statements', () => stranger.get(`${c}/statements`)],
      [
        'draft a statement',
        () => send(stranger, 'POST', `${c}/statements`, { lines: statementLines(['1000']) }),
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
    (target.statementIds ?? []).forEach((id, index) => {
      probes.push(
        [`read statement ${index + 1}`, () => stranger.get(`${c}/statements/${id}`)],
        [
          `submit statement ${index + 1}`,
          () => send(stranger, 'POST', `${c}/statements/${id}/submit`, {}),
        ],
        [
          `decide statement ${index + 1}`,
          () =>
            send(stranger, 'POST', `${c}/statements/${id}/decisions`, {
              chain: 'TECHNICAL',
              stepOrder: 1,
              decision: 'APPROVE',
            }),
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
    statementIds: (ids.statementIds ?? []).map((_, index) => `STM_${RUN}_MISSING_${index}`),
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
  let tap: EconomicEventTap;

  const org = { owner: '', c1: '', c2: '', c3: '', consultant: '' };
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
    | 'c3'
    | 'tech',
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
  const statementId = { one: '', two: '' };

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

  test.beforeAll(async () => {
    tap = await EconomicEventTap.start(config, config.contractTopic);
  });

  test.afterAll(async () => {
    await tap?.stop();
  });

  // ---- the cast and the awarded tenders -------------------------------------

  test('the cast: an owner under the union, three contractors, a consultant, and the people who act', async ({
    systemAdmin,
  }) => {
    // One token wait per person, one after another.
    test.setTimeout(Object.keys(SURNAMES).length * TOKEN_WAIT_MS + HTTP_WORK_MS);

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
    org.consultant = await organization(`E2E supervising consultant ${RUN}`, 'COMPANY');

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
      tech: await provision('tech', org.consultant, [OWNER_ROLE]),
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
      tech: org.consultant,
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
        TOKEN_WAIT_MS,
      );
      signedIn[key] = new Actor(
        account.username,
        new SessionToken(token, () => freshToken(account.username)),
        config,
      );
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
    // One wait for the three closures (they share a deadline), then one audit catch-up per
    // opening.
    test.setTimeout(waitMs + TENDERS.length * AUDIT_CATCH_UP_MS + HTTP_WORK_MS);

    await until(
      'the sweeper to close all three tenders',
      async () => {
        for (const key of TENDERS) {
          if ((await tender(author, tenderId[key])).status !== 'CLOSED') return undefined;
        }
        return true;
      },
      waitMs,
    );

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
        AUDIT_CATCH_UP_MS,
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
              { criterionCode: 'technical', scoreScaled: SCORES[key][who][0], expectedRevision: 0 },
              {
                criterionCode: 'compliance',
                scoreScaled: SCORES[key][who][1],
                expectedRevision: 0,
              },
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
    // One audit catch-up per award, one after another.
    test.setTimeout(TENDERS.length * AUDIT_CATCH_UP_MS + HTTP_WORK_MS);
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
        AUDIT_CATCH_UP_MS,
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
    // One wait for the three drafts, then the HTTP work: reads and stranger probes.
    test.setTimeout(DRAFT_WAIT_MS + HTTP_WORK_MS);
    const { author, c1, c2, c3 } = people;
    const drafts = await until(
      'the draft contracts of all three tenders',
      async () => {
        const list = await author.get('/v1/contracts?limit=100');
        expect(list.status, JSON.stringify(list.body)).toBe(200);
        const items = (list.body as { items: ContractBody[] }).items;
        const found = TENDERS.map((key) => items.find((item) => item.tenderId === tenderId[key]));
        return found.every((item) => item !== undefined) ? found : undefined;
      },
      DRAFT_WAIT_MS,
    );
    for (const [index, key] of TENDERS.entries()) {
      const draft = drafts[index]!;
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

    // A refusal of the contract's state (above) leaves no record; a party's refusal for want of
    // authority does.
    const byContractor = correlation('contractor-cancels');
    expectRefusal(
      await send(
        c2,
        'POST',
        `/v1/contracts/${contractId.B}/cancel`,
        { reasonCode: 'OTHER' },
        byContractor,
      ),
      { status: 403, code: 'FORBIDDEN' },
      'the contractor cancelling the draft',
    );
    evidence.push({
      label: 'contractor cancellation refused',
      correlationId: byContractor,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.B,
        payload: {
          contractId: contractId.B,
          action: 'CANCEL_CONTRACT',
          side: 'CONTRACTOR',
          subjectId: null,
          reason: 'NOT_EMPLOYER',
        },
      },
    });
    expect(await contract(author, contractId.B)).toMatchObject({ status: 'DRAFT' });
  });

  /**
   * A contract-service approval policy for the owner, through the gateway: written and submitted
   * by `union.admin` and approved by a different person, the platform administrator
   * (CONTRACT_POLICY_FOUR_EYES). Returns its id.
   */
  async function activateContractPolicy(
    union: Actor,
    platform: Actor,
    workflowKey: string,
    label: string,
    steps: { authorityOrganizationId: string; authorityRole: string; authorityLabel: string }[],
  ): Promise<string> {
    const created = await union.post('/v1/contract-approval-policies', {
      idempotencyKey: idempotencyKey(`contract-policy-${RUN}`),
      body: {
        organizationId: org.owner,
        workflowKey,
        label,
        rationale: 'Written by the E2E suite; a sample, not an adopted procedure',
        isSample: true,
        steps,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body as PolicyBody).id;

    const submitted = await union.post(`/v1/contract-approval-policies/${id}/submit`, {
      idempotencyKey: idempotencyKey(`contract-policy-${RUN}`),
      body: { expectedVersion: (created.body as PolicyBody).version },
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);

    const approved = await platform.post(`/v1/contract-approval-policies/${id}/approve`, {
      idempotencyKey: idempotencyKey(`contract-policy-${RUN}`),
      body: { expectedVersion: (submitted.body as PolicyBody).version },
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'ACTIVE', workflowKey });
    return id;
  }

  test('the union writes the contract.signature policy and the platform approves it', async ({
    platformAdmin,
    systemAdmin,
  }) => {
    policyId = await activateContractPolicy(
      platformAdmin,
      systemAdmin,
      'contract.signature',
      'E2E sample — contract signature',
      [
        {
          authorityOrganizationId: org.owner,
          authorityRole: SIGNING_ROLE,
          authorityLabel: 'Signatory of the owner (sample)',
        },
      ],
    );
  });

  test('the employer signs under the policy: refusals once each, then SIGNED exactly once, and a replay answers the first response', async ({
    tenantB,
  }) => {
    const { plain, dual, signer, author, c1, c3 } = people;
    const path = `/v1/contracts/${contractId.A}/sign`;

    // An administrator of the employer who does not hold the role the policy names.
    const withoutRole = correlation('sign-without-role');
    expectRefusal(
      await send(plain, 'POST', path, {}, withoutRole),
      { status: 403, code: 'INSUFFICIENT_ROLE' },
      'a person without the policy’s role signing',
    );
    evidence.push({
      label: 'signature refused for want of the policy’s role',
      correlationId: withoutRole,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'SIGN_CONTRACT',
          side: 'EMPLOYER',
          subjectId: null,
          reason: 'ROLE_NOT_PERMITTED',
        },
      },
    });
    // A person who is a member of both parties.
    const bothParties = correlation('sign-member-of-both');
    expectRefusal(
      await send(dual, 'POST', path, {}, bothParties),
      { status: 403, code: 'FORBIDDEN', reason: 'MEMBER_OF_BOTH_PARTIES' },
      'a member of both parties signing',
    );
    evidence.push({
      label: 'signature refused to a member of both parties',
      correlationId: bothParties,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'SIGN_CONTRACT',
          side: 'EMPLOYER',
          subjectId: null,
          reason: 'MEMBER_OF_BOTH_PARTIES',
        },
      },
    });
    // Not a party at all.
    const missingSign = `/v1/contracts/CTR_${RUN}_MISSING/sign`;
    await expectMissingLike(
      await send(c3, 'POST', path, {}),
      send(c3, 'POST', missingSign, {}),
      'a stranger signing',
    );
    await expectMissingLike(
      await send(tenantB, 'POST', path, {}),
      send(tenantB, 'POST', missingSign, {}),
      'another tenant signing',
    );
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
    const missingCancel = `/v1/contracts/CTR_${RUN}_MISSING/cancel`;
    await expectMissingLike(
      await send(c3, 'POST', path, { reasonCode: 'OTHER' }),
      send(c3, 'POST', missingCancel, { reasonCode: 'OTHER' }),
      'a stranger',
    );
    await expectMissingLike(
      await send(tenantB, 'POST', path, { reasonCode: 'OTHER' }),
      send(tenantB, 'POST', missingCancel, { reasonCode: 'OTHER' }),
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

    await expectMissingLike(
      await send(c3, 'POST', path, {}),
      send(c3, 'POST', `/v1/contracts/CTR_${RUN}_MISSING/amendments/AMD_${RUN}_MISSING_0/sign`, {}),
      'a stranger signing the amendment',
    );

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

  // ---- statements (CON-003 PR 4 to 6) ---------------------------------------

  const statementPolicy = { technical: '', financial: '' };

  async function statement(actor: Actor, id: string): Promise<StatementBody> {
    const response = await actor.get(`/v1/contracts/${contractId.A}/statements/${id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as StatementBody;
  }

  /** A decision on a named step: the step is named, never inferred (Q-135 (1)). */
  function stepOf(chain: 'TECHNICAL' | 'FINANCIAL', stepOrder: number, decision = 'APPROVE') {
    return { chain, stepOrder, decision };
  }

  test('a statement: only the contractor drafts it, on a signed contract and with no unconfigured deduction; with no chain policy it is not submitted', async () => {
    const { author, p1, c1, c2 } = people;
    const base = `/v1/contracts/${contractId.A}/statements`;
    const body = { lines: statementLines(STATEMENT_ONE_LINES, milestoneId) };

    // The employer does not draft its contractor's claim: refused, and recorded.
    const byEmployer = correlation('employer-drafts');
    expectRefusal(
      await send(author, 'POST', base, body, byEmployer),
      { status: 403, code: 'FORBIDDEN', reason: 'AUTHOR_NOT_CONTRACTOR' },
      'the employer drafting a statement',
    );
    evidence.push({
      label: 'employer draft refused',
      correlationId: byEmployer,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'DRAFT_STATEMENT',
          side: 'EMPLOYER',
          subjectId: null,
          reason: 'NOT_CONTRACTOR',
        },
      },
    });
    expectRefusal(
      await c1.post(base, { body }),
      { status: 400, code: 'VALIDATION_FAILED' },
      'drafting without a key',
    );
    // A deduction is only a rule the employer configured (Q-96 (6)). No route configures one yet
    // (Q-125), so any rule a statement names is refused, and nothing is drafted.
    expectRefusal(
      await send(c1, 'POST', base, {
        ...body,
        deductions: [{ deductionRuleId: `DDR_${RUN}_NONE` }],
      }),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'DEDUCTION_NOT_CONFIGURED' },
      'a deduction no rule configures',
    );
    // Only on a signed contract: B was cancelled as a draft.
    expectRefusal(
      await send(c2, 'POST', `/v1/contracts/${contractId.B}/statements`, {
        lines: statementLines(STATEMENT_ONE_LINES),
      }),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'CONTRACT_NOT_SIGNED' },
      'a statement of a cancelled contract',
    );

    const drafting = correlation('statement-one-drafted');
    const key = idempotencyKey(`contract-statement-${RUN}`);
    const drafted = await c1.call('POST', base, {
      idempotencyKey: key,
      correlationId: drafting,
      body,
    });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body).toMatchObject({
      contractId: contractId.A,
      organizationId: org.owner,
      contractorOrganizationId: org.c1,
      statementNumber: 1,
      status: 'DRAFT',
      grossMinor: STATEMENT_ONE_GROSS,
      deductionsMinor: '0',
      netMinor: STATEMENT_ONE_GROSS,
      lines: [
        { lineNumber: 1, amountMinor: STATEMENT_ONE_LINES[0], milestoneId },
        { lineNumber: 2, amountMinor: STATEMENT_ONE_LINES[1], milestoneId: null },
      ],
      deductions: [],
      submittedAt: null,
      approvalChains: null,
    });
    statementId.one = (drafted.body as StatementBody).id;
    evidence.push({
      label: 'statement one drafted',
      correlationId: drafting,
      events: ['STATEMENT_DRAFTED'],
    });

    // A replay answers the first response and drafts nothing.
    const replay = await c1.call('POST', base, { idempotencyKey: key, body });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(drafted.body);
    // Both parties read it, and list it once.
    for (const party of [author, c1]) {
      expect(await statement(party, statementId.one)).toEqual(drafted.body);
      const listed = await party.get(`${base}?limit=50`);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect((listed.body as { items: StatementBody[] }).items.map((item) => item.id)).toEqual([
        statementId.one,
      ]);
    }

    // A draft is not decided; and with no chain policy in force it is not submitted — the
    // platform never approves by default.
    expectRefusal(
      await send(p1, 'POST', `${base}/${statementId.one}/decisions`, stepOf('TECHNICAL', 1)),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'STATEMENT_NOT_SUBMITTED' },
      'deciding a draft',
    );
    const unsubmitted = await send(c1, 'POST', `${base}/${statementId.one}/submit`, {});
    expectRefusal(
      unsubmitted,
      { status: 422, code: 'BUSINESS_RULE_VIOLATION' },
      'submitting with no chain policy in force',
    );
    expect(reasonsOf(unsubmitted.body)).toEqual([
      'TECHNICAL_POLICY_REQUIRED',
      'FINANCIAL_POLICY_REQUIRED',
    ]);
    expect(await statement(author, statementId.one)).toEqual(drafted.body);
  });

  test('the union writes both statement chains, and the platform approves them', async ({
    platformAdmin,
    systemAdmin,
  }) => {
    // Technical: the supervising consultant, then the owner. Financial: the owner. Every step is
    // an organization administrator, so who decides is told apart by person, not by role.
    statementPolicy.technical = await activateContractPolicy(
      platformAdmin,
      systemAdmin,
      'contract.statement.technical',
      'E2E sample — statement technical chain',
      [
        {
          authorityOrganizationId: org.consultant,
          authorityRole: OWNER_ROLE,
          authorityLabel: 'Supervising consultant (sample)',
        },
        {
          authorityOrganizationId: org.owner,
          authorityRole: OWNER_ROLE,
          authorityLabel: 'Technical review of the owner (sample)',
        },
      ],
    );
    statementPolicy.financial = await activateContractPolicy(
      platformAdmin,
      systemAdmin,
      'contract.statement.financial',
      'E2E sample — statement financial chain',
      [
        {
          authorityOrganizationId: org.owner,
          authorityRole: OWNER_ROLE,
          authorityLabel: 'Financial approval of the owner (sample)',
        },
      ],
    );
  });

  test('the contractor submits it with both chains snapshotted; strangers, the oversight role and the platform administrator see nothing, the consultant only this statement', async ({
    tenantB,
    auditor,
    systemAdmin,
  }) => {
    const { author, c1, c2, c3, tech } = people;
    const base = `/v1/contracts/${contractId.A}/statements`;
    const draft = await statement(c1, statementId.one);

    const submitting = correlation('statement-one-submitted');
    const submitted = await send(
      c1,
      'POST',
      `${base}/${statementId.one}/submit`,
      { expectedVersion: draft.version },
      submitting,
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body).toMatchObject({
      id: statementId.one,
      status: 'SUBMITTED',
      grossMinor: STATEMENT_ONE_GROSS,
      netMinor: STATEMENT_ONE_GROSS,
      approvalChains: {
        technical: {
          policyId: statementPolicy.technical,
          steps: [
            {
              stepOrder: 1,
              authorityOrganizationId: org.consultant,
              authorityRole: OWNER_ROLE,
              decision: null,
            },
            {
              stepOrder: 2,
              authorityOrganizationId: org.owner,
              authorityRole: OWNER_ROLE,
              decision: null,
            },
          ],
        },
        financial: {
          policyId: statementPolicy.financial,
          steps: [
            {
              stepOrder: 1,
              authorityOrganizationId: org.owner,
              authorityRole: OWNER_ROLE,
              decision: null,
            },
          ],
        },
      },
    });
    // An instant in UTC, in the ISO 8601 form the contract publishes (`toISOString`): a missing,
    // empty or unparseable value fails, and so does one with an offset or another precision.
    const submittedAt: unknown = (submitted.body as StatementBody).submittedAt;
    expect(typeof submittedAt, `submittedAt: ${String(submittedAt)}`).toBe('string');
    const at = String(submittedAt);
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(at)), `submittedAt: ${at}`).toBe(false);
    expect(new Date(at).toISOString(), 'submittedAt is a real instant').toBe(at);
    evidence.push({
      label: 'statement one submitted',
      correlationId: submitting,
      events: ['STATEMENT_SUBMITTED'],
    });
    expectRefusal(
      await send(c1, 'POST', `${base}/${statementId.one}/submit`, {}),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'STATEMENT_NOT_DRAFT' },
      'submitting it again',
    );

    // The milestone its first line is against is now referenced, and no longer changed (Q-100 (4)).
    const milestonePath = `/v1/contracts/${contractId.A}/milestones/${milestoneId}`;
    const referenced = await author.get(milestonePath);
    expect(referenced.status, JSON.stringify(referenced.body)).toBe(200);
    expect(referenced.body).toMatchObject({ id: milestoneId, referenced: true });
    expectRefusal(
      await send(author, 'PATCH', milestonePath, { title: 'Changed after the statement' }),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'MILESTONE_REFERENCED' },
      'changing a referenced milestone',
    );

    // Both parties read the submitted statement alike.
    for (const party of [author, c1]) {
      expect(await statement(party, statementId.one)).toEqual(submitted.body);
    }
    // Every other organization: what it gets for a contract or a statement that does not exist.
    for (const [who, stranger] of [
      ['an uninvolved contractor', c3],
      ['another tenant', tenantB],
      ['the other bidder', c2],
    ] as const) {
      await assertInvisibleToStranger(
        stranger,
        { contractId: contractId.A, statementIds: [statementId.one] },
        who,
      );
    }

    // ADR-068 § 7: the oversight role reads and does nothing; the platform administrator reads a
    // contract's statements only for an organization it selected, and it can select only its own —
    // which is no party — so it is told what a stranger is told, and never drafts, submits or
    // decides. Each refusal is asserted whole — code, message, no details — and repeats nothing of
    // the statement.
    const missing = `/v1/contracts/CTR_${RUN}_MISSING/statements`;
    for (const [path, missingPath] of [
      [base, missing],
      [`${base}/${statementId.one}`, `${missing}/${statementId.one}`],
    ] as const) {
      expectRefusalExactly(
        await auditor.get(path),
        OVERSIGHT_REFUSED,
        `the oversight role reading ${path}`,
      );
      // What it is told for a contract that is not there, word for word.
      const absent = refusalOf(await systemAdmin.get(missingPath));
      expect(absent, 'the platform administrator reading a missing contract').toMatchObject(
        NOT_FOUND,
      );
      expect(typeof absent.message).toBe('string');
      expect(absent.details).toBeUndefined();
      expectRefusalExactly(
        await systemAdmin.get(path),
        { ...NOT_FOUND, message: absent.message ?? '' },
        `the platform administrator reading ${path}`,
      );
      expectRefusalExactly(
        await systemAdmin.get(path, { organizationId: org.owner }),
        {
          status: 403,
          code: 'TENANT_MISMATCH',
          message: 'You are not a member of the requested organization',
        },
        `the platform administrator selecting the employer to read ${path}`,
      );
    }
    for (const [what, path, command, operatorRefused] of [
      [
        'draft a statement',
        base,
        { lines: statementLines(['1000']) },
        'The platform administrator does not draft or submit a statement for a party',
      ],
      [
        'submit it',
        `${base}/${statementId.one}/submit`,
        {},
        'The platform administrator does not draft or submit a statement for a party',
      ],
      [
        'decide it',
        `${base}/${statementId.one}/decisions`,
        stepOf('TECHNICAL', 1),
        'The platform administrator does not approve or reject a statement for anyone',
      ],
    ] as const) {
      expectRefusalExactly(
        await send(auditor, 'POST', path, command),
        OVERSIGHT_REFUSED,
        `the oversight role trying to ${what}`,
      );
      expectRefusalExactly(
        await send(systemAdmin, 'POST', path, command),
        { status: 403, code: 'FORBIDDEN', message: operatorRefused },
        `the platform administrator trying to ${what}`,
      );
    }

    // The consultant its technical chain names reads this statement — nothing else of the
    // contract (Q-135 (2)).
    expect(await statement(tech, statementId.one)).toEqual(submitted.body);
    const contractPath = `/v1/contracts/${contractId.A}`;
    for (const [what, path, missingPath] of [
      ['the contract', contractPath, `/v1/contracts/CTR_${RUN}_MISSING`],
      ['its statements', base, missing],
      [
        'its amendments',
        `${contractPath}/amendments`,
        `/v1/contracts/CTR_${RUN}_MISSING/amendments`,
      ],
      [
        'its milestones',
        `${contractPath}/milestones`,
        `/v1/contracts/CTR_${RUN}_MISSING/milestones`,
      ],
    ] as const) {
      const response = await tech.get(path);
      expectRefusal(response, NOT_FOUND, `the consultant reading ${what}`);
      expect(refusalOf(response), `the consultant reading ${what}: against a missing one`).toEqual(
        refusalOf(await tech.get(missingPath)),
      );
    }
    const contracts = await tech.get('/v1/contracts?limit=100');
    expect(contracts.status, JSON.stringify(contracts.body)).toBe(200);
    expect((contracts.body as { items: { id: string }[] }).items).toEqual([]);
    for (const [what, path, command] of [
      ['draft a statement', base, { lines: statementLines(['1000']) }],
      ['submit it', `${base}/${statementId.one}/submit`, {}],
    ] as const) {
      await expectMissingLike(
        await send(tech, 'POST', path, command),
        send(tech, 'POST', path.replace(contractId.A, `CTR_${RUN}_MISSING`), command),
        `the consultant trying to ${what}`,
      );
    }
  });

  test('the technical chain, then the financial chain, each step by its authority and a different person: the same person twice is refused, and a replayed decision answers its first response', async () => {
    const { author, p1, p2, dual, tech, c1 } = people;
    const path = `/v1/contracts/${contractId.A}/statements/${statementId.one}/decisions`;

    expectRefusal(
      await tech.post(path, { body: stepOf('TECHNICAL', 1) }),
      { status: 400, code: 'VALIDATION_FAILED' },
      'deciding without a key',
    );
    // In order (Q-96 (2)): the financial chain is not open, the technical chain's second step
    // waits for its first, and a step the chains do not have is no step.
    expectRefusal(
      await send(p2, 'POST', path, stepOf('FINANCIAL', 1)),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'CHAIN_NOT_OPEN' },
      'the financial chain before the technical one',
    );
    expectRefusal(
      await send(p1, 'POST', path, stepOf('TECHNICAL', 2)),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'STEP_NOT_NEXT' },
      'the second technical step before the first',
    );
    expectRefusal(
      await send(p1, 'POST', path, stepOf('TECHNICAL', 3)),
      { status: 422, code: 'BUSINESS_RULE_VIOLATION', reason: 'STEP_NOT_IN_CHAIN' },
      'a step the chain does not have',
    );

    // The employer is not the authority of the consultant's step: refused, and recorded.
    const notAuthority = correlation('employer-decides-consultant-step');
    expectRefusal(
      await send(p1, 'POST', path, stepOf('TECHNICAL', 1), notAuthority),
      { status: 403, code: 'FORBIDDEN', reason: 'NOT_STEP_AUTHORITY' },
      'the employer deciding the consultant’s step',
    );
    evidence.push({
      label: 'employer deciding the consultant’s step refused',
      correlationId: notAuthority,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'APPROVE_STATEMENT',
          side: 'EMPLOYER',
          subjectId: statementId.one,
          reason: 'NOT_STEP_AUTHORITY',
        },
      },
    });
    // A member of the contractor's organization never decides its claim, whichever step.
    const memberOfContractor = correlation('member-of-contractor-decides');
    expectRefusal(
      await send(dual, 'POST', path, stepOf('TECHNICAL', 1), memberOfContractor),
      { status: 403, code: 'FORBIDDEN', reason: 'MEMBER_OF_CONTRACTOR' },
      'a member of the contractor deciding',
    );
    evidence.push({
      label: 'member of the contractor deciding refused',
      correlationId: memberOfContractor,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'APPROVE_STATEMENT',
          side: 'EMPLOYER',
          subjectId: statementId.one,
          reason: 'MEMBER_OF_CONTRACTOR',
        },
      },
    });

    // Technical step 1, by the consultant: recorded, the statement still SUBMITTED.
    const technicalOne = correlation('statement-one-technical-1');
    const first = await send(tech, 'POST', path, stepOf('TECHNICAL', 1), technicalOne);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      status: 'SUBMITTED',
      approvalChains: {
        technical: {
          steps: [
            { stepOrder: 1, decision: { outcome: 'APPROVED' } },
            { stepOrder: 2, decision: null },
          ],
        },
        financial: { steps: [{ stepOrder: 1, decision: null }] },
      },
    });
    evidence.push({
      label: 'statement one technical step 1',
      correlationId: technicalOne,
      events: ['STATEMENT_DECISION_RECORDED'],
    });
    // The consultant is not the authority of the owner's step: refused, and recorded as an
    // approver that is no party.
    const approverOther = correlation('consultant-decides-owner-step');
    expectRefusal(
      await send(tech, 'POST', path, stepOf('TECHNICAL', 2), approverOther),
      { status: 403, code: 'FORBIDDEN', reason: 'NOT_STEP_AUTHORITY' },
      'the consultant deciding the owner’s step',
    );
    evidence.push({
      label: 'consultant deciding the owner’s step refused',
      correlationId: approverOther,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'APPROVE_STATEMENT',
          side: 'APPROVER',
          subjectId: statementId.one,
          reason: 'NOT_STEP_AUTHORITY',
        },
      },
    });

    // Technical step 2, by p1: the technical chain is done.
    const technicalTwo = correlation('statement-one-technical-2');
    const second = await send(p1, 'POST', path, stepOf('TECHNICAL', 2), technicalTwo);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({
      status: 'TECHNICALLY_APPROVED',
      approvalChains: {
        technical: {
          steps: [
            { stepOrder: 1, decision: { outcome: 'APPROVED' } },
            { stepOrder: 2, decision: { outcome: 'APPROVED' } },
          ],
        },
        financial: { steps: [{ stepOrder: 1, decision: null }] },
      },
    });
    evidence.push({
      label: 'statement one technical step 2',
      correlationId: technicalTwo,
      events: ['STATEMENT_DECISION_RECORDED', 'STATEMENT_TECHNICALLY_APPROVED'],
    });

    // Separation of duties across both chains (Q-96 (3)): p1 holds the financial step's role too,
    // and is refused it — recorded — and nothing changes.
    const twice = correlation('same-person-twice');
    expectRefusalExactly(
      await send(p1, 'POST', path, stepOf('FINANCIAL', 1), twice),
      {
        status: 422,
        code: 'BUSINESS_RULE_VIOLATION',
        message:
          'Separation of duties: one person decides a statement at most once, across both chains',
        details: decisionReason('ALREADY_DECIDED_STATEMENT'),
      },
      'the same person deciding a second step',
    );
    evidence.push({
      label: 'same person deciding twice refused',
      correlationId: twice,
      events: ['CONTRACT_AUTHORITY_REFUSED'],
      refusal: {
        event: 'CONTRACT_AUTHORITY_REFUSED',
        contractId: contractId.A,
        payload: {
          contractId: contractId.A,
          action: 'APPROVE_STATEMENT',
          side: 'EMPLOYER',
          subjectId: statementId.one,
          reason: 'ALREADY_DECIDED_STATEMENT',
        },
      },
    });
    expect(await statement(author, statementId.one)).toEqual(second.body);

    // The financial step, by p2, a third person: APPROVED.
    const key = idempotencyKey(`contract-decision-${RUN}`);
    const financial = correlation('statement-one-financial-1');
    const approved = await p2.call('POST', path, {
      idempotencyKey: key,
      correlationId: financial,
      body: stepOf('FINANCIAL', 1),
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      id: statementId.one,
      status: 'APPROVED',
      grossMinor: STATEMENT_ONE_GROSS,
      approvalChains: {
        technical: {
          steps: [
            { stepOrder: 1, decision: { outcome: 'APPROVED' } },
            { stepOrder: 2, decision: { outcome: 'APPROVED' } },
          ],
        },
        financial: { steps: [{ stepOrder: 1, decision: { outcome: 'APPROVED' } }] },
      },
    });
    evidence.push({
      label: 'statement one financial step 1',
      correlationId: financial,
      events: ['STATEMENT_DECISION_RECORDED', 'STATEMENT_APPROVED'],
    });

    // Idempotency-Key replay: the first response, nothing decided twice.
    const replay = await p2.call('POST', path, {
      idempotencyKey: key,
      body: stepOf('FINANCIAL', 1),
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(approved.body);
    expectRefusal(
      await p2.call('POST', path, { idempotencyKey: key, body: stepOf('FINANCIAL', 1, 'REJECT') }),
      { status: 409, code: 'IDEMPOTENCY_KEY_REUSED' },
      'the same key with another decision',
    );
    // A fresh key is a new request: the step is decided.
    expectRefusal(
      await send(p2, 'POST', path, stepOf('FINANCIAL', 1)),
      { status: 409, code: 'CONFLICT', reason: 'STEP_DECIDED' },
      'deciding the decided step again',
    );
    for (const reader of [author, c1, tech]) {
      expect(await statement(reader, statementId.one)).toEqual(approved.body);
    }
  });

  test('the cap: a second statement that would take the approved total past the price and the effective amendment is refused at its last approval, and nothing is written', async ({
    tenantB,
  }) => {
    const { author, c1, p2, evaluator, tech } = people;
    const base = `/v1/contracts/${contractId.A}/statements`;

    const drafting = correlation('statement-two-drafted');
    const drafted = await send(
      c1,
      'POST',
      base,
      { lines: statementLines([STATEMENT_TWO_GROSS]) },
      drafting,
    );
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body).toMatchObject({
      statementNumber: 2,
      status: 'DRAFT',
      grossMinor: STATEMENT_TWO_GROSS,
      netMinor: STATEMENT_TWO_GROSS,
    });
    statementId.two = (drafted.body as StatementBody).id;
    evidence.push({
      label: 'statement two drafted',
      correlationId: drafting,
      events: ['STATEMENT_DRAFTED'],
    });

    // The consultant reads a statement only once its chains name it: not this draft.
    const unnamed = await tech.get(`${base}/${statementId.two}`);
    expectRefusal(unnamed, NOT_FOUND, 'the consultant reading a draft');
    expect(refusalOf(unnamed), 'the consultant: against a missing statement').toEqual(
      refusalOf(await tech.get(`${base}/STM_${RUN}_MISSING`)),
    );

    const submitting = correlation('statement-two-submitted');
    const submitted = await send(c1, 'POST', `${base}/${statementId.two}/submit`, {}, submitting);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body).toMatchObject({ status: 'SUBMITTED' });
    evidence.push({
      label: 'statement two submitted',
      correlationId: submitting,
      events: ['STATEMENT_SUBMITTED'],
    });

    const path = `${base}/${statementId.two}/decisions`;
    const technicalOne = correlation('statement-two-technical-1');
    expect((await send(tech, 'POST', path, stepOf('TECHNICAL', 1), technicalOne)).status).toBe(200);
    evidence.push({
      label: 'statement two technical step 1',
      correlationId: technicalOne,
      events: ['STATEMENT_DECISION_RECORDED'],
    });
    const technicalTwo = correlation('statement-two-technical-2');
    const technicallyApproved = await send(
      evaluator,
      'POST',
      path,
      stepOf('TECHNICAL', 2),
      technicalTwo,
    );
    expect(technicallyApproved.status, JSON.stringify(technicallyApproved.body)).toBe(200);
    expect(technicallyApproved.body).toMatchObject({ status: 'TECHNICALLY_APPROVED' });
    evidence.push({
      label: 'statement two technical step 2',
      correlationId: technicalTwo,
      events: ['STATEMENT_DECISION_RECORDED', 'STATEMENT_TECHNICALLY_APPROVED'],
    });

    // Approved gross so far: statement one. Statement two on top passes the price plus the
    // effective amendment (Q-96 (5)): refused, and nothing is written — no decision, no move.
    expect(
      BigInt(STATEMENT_ONE_GROSS) + BigInt(STATEMENT_TWO_GROSS),
      'the scenario’s amounts must pass the cap',
    ).toBeGreaterThan(BigInt(PRICE.A.c1) + BigInt(AMENDMENT_ONE));
    expect(BigInt(STATEMENT_TWO_GROSS)).toBeLessThanOrEqual(
      BigInt(PRICE.A.c1) + BigInt(AMENDMENT_ONE),
    );
    const contractBefore = await contract(author, contractId.A);
    expectRefusalExactly(
      await send(p2, 'POST', path, stepOf('FINANCIAL', 1)),
      {
        status: 422,
        code: 'BUSINESS_RULE_VIOLATION',
        message:
          'Approving this statement would take the approved total past the contract’s price and its effective amendments',
        details: decisionReason('APPROVED_TOTAL_EXCEEDS_CAP'),
      },
      'approving past the cap',
    );
    for (const party of [author, c1]) {
      expect(await statement(party, statementId.two)).toEqual(technicallyApproved.body);
      expect(await statement(party, statementId.one)).toMatchObject({ status: 'APPROVED' });
    }
    expect(await contract(author, contractId.A)).toEqual(contractBefore);

    await assertInvisibleToStranger(
      tenantB,
      { contractId: contractId.A, statementIds: [statementId.one, statementId.two] },
      'another tenant',
    );
  });

  // ---- an organization move (D-050 / D-051) ---------------------------------

  test('moving the employer out from under the union that wrote its signing policy suspends the policy, and a pending signature is refused', async ({
    systemAdmin,
    platformAdmin,
  }) => {
    // The declared waits (suspension, then flag) plus the HTTP work around them: two signatures,
    // the move, the reads and the refusal. The signature-to-move bound is asserted separately.
    test.setTimeout(SUSPENSION_WAIT_MS + FLAG_WAIT_MS + HTTP_WORK_MS);
    const { signer, c1, c2, author } = people;
    const policyPath = `/v1/contract-approval-policies/${policyId}`;

    // The union is the policy's author and governs the employer: the policy is in force.
    const inForce = await platformAdmin.get(policyPath);
    expect(inForce.status, JSON.stringify(inForce.body)).toBe(200);
    expect(inForce.body).toMatchObject({ id: policyId, status: 'ACTIVE' });

    // Every monetary field of A and C, as both parties read them before the move.
    const moneyOf = (c: ContractBody) => ({
      amountMinor: c.amountMinor,
      currentAmountMinor: c.currentAmountMinor,
      amendmentsTotalMinor: c.amendmentsTotalMinor,
    });
    const moneyBefore = {
      A: [moneyOf(await contract(author, contractId.A)), moneyOf(await contract(c1, contractId.A))],
      C: [moneyOf(await contract(author, contractId.C)), moneyOf(await contract(c2, contractId.C))],
    };

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
        const read = await platformAdmin.get(policyPath);
        return read.status === 200 && (read.body as PolicyBody).status === 'SUSPENDED'
          ? read
          : undefined;
      },
      SUSPENSION_WAIT_MS,
    );
    expect(suspended.body).toMatchObject({ id: policyId, status: 'SUSPENDED' });
    // The signature made just before the move is flagged for review: a flag is never a
    // revocation — the contract stays SIGNED, its total unchanged — and both parties see it.
    await until(
      'the signature on the fresh contract to be flagged for review',
      async () =>
        (await contract(author, contractId.C)).authorityReviewRequired ? true : undefined,
      FLAG_WAIT_MS,
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
    // No amount moved on either contract, for either party.
    for (const [key, parties] of [
      ['A', [author, c1]],
      ['C', [author, c2]],
    ] as const) {
      for (const [index, party] of parties.entries()) {
        expect(
          moneyOf(await contract(party, contractId[key])),
          `contract ${key}, party ${index + 1}: amounts after the move`,
        ).toEqual(moneyBefore[key][index]);
      }
    }
  });

  // ---- audit ----------------------------------------------------------------

  test('audit-service holds the decisions and the refusals, once each, under the employer’s tenant, and no event carries an amount', async ({
    systemAdmin,
  }) => {
    // The audit records, then the events of every correlated call (awaited together, so one
    // wait), then every event of the contracts on the tap, then the reads around them.
    test.setTimeout(AUDIT_RECORDS_WAIT_MS + 2 * EVENTS_WAIT_MS + HTTP_WORK_MS);

    interface AuditItem {
      occurredAt: string;
      organizationId: string | null;
      correlationId: string;
      sourceTopic: string;
      sourceEventName: string;
      action: string;
      resourceType: string;
      resourceId: string | null;
      outcome: string;
      reason: string | null;
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
        // Two statements; three decisions on the first, two on the second, whose financial
        // approval was refused at the cap and wrote nothing; nothing rejected.
        STATEMENT_DRAFTED: 2,
        STATEMENT_SUBMITTED: 2,
        STATEMENT_DECISION_RECORDED: 5,
        STATEMENT_TECHNICALLY_APPROVED: 2,
        STATEMENT_APPROVED: 1,
        STATEMENT_REJECTED: 0,
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
    // Refusals of a party for want of authority or for separation of duties: on contract A, the
    // employer signing without the policy's role and as a member of both parties, the contractor
    // proposing an amendment, planning a milestone and changing one, the employer drafting a
    // statement, the employer and the consultant deciding each other's step, a member of the
    // contractor deciding, the same person deciding twice, and the employer signing an amendment
    // after its policy was suspended; on B, the contractor cancelling. Each is in `evidence` with
    // its correlation id.
    const refusals = evidence.filter((entry) => entry.refusal);
    const authorityRefusals = refusals.filter(
      (entry) => entry.refusal!.event === 'CONTRACT_AUTHORITY_REFUSED',
    );
    expect(authorityRefusals).toHaveLength(12);

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
      AUDIT_RECORDS_WAIT_MS,
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
    // Exactly the twelve authority refusals, no more: one audit record per refusal, found by the
    // correlation id the call carried, naming the refusal's event, its contract and the tenant,
    // stored as REFUSED under the closed action and reason the refusal names (#243; a
    // CONTRACT_SIGNATURE_REFUSED is always the contract's own signature, SIGN_CONTRACT).
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
      const { event, contractId: refusedContract, payload } = entry.refusal!;
      expect(recorded[0], entry.label).toMatchObject({
        organizationId: org.owner,
        action: payload.action ?? 'SIGN_CONTRACT',
        outcome: 'REFUSED',
        reason: payload.reason,
        sourceEventName: event,
        resourceType: 'Contract',
        resourceId: refusedContract,
      });
    }
    // Each statement's life, in order, as audit-service holds it: every call that moved it left
    // exactly its own events — recorded under the contract, the employer's tenant and the call's
    // correlation id — and each call's events are no earlier than the previous call's.
    for (const [which, calls] of [
      [
        'statement one',
        [
          'statement one drafted',
          'statement one submitted',
          'statement one technical step 1',
          'statement one technical step 2',
          'statement one financial step 1',
        ],
      ],
      [
        'statement two',
        [
          'statement two drafted',
          'statement two submitted',
          'statement two technical step 1',
          'statement two technical step 2',
        ],
      ],
    ] as const) {
      let previous = 0;
      for (const label of calls) {
        const entry = evidence.find((item) => item.label === label)!;
        const recorded = records.filter((item) => item.correlationId === entry.correlationId);
        expect(
          recorded.map((item) => item.sourceEventName).sort(),
          `audit records of "${label}"`,
        ).toEqual([...entry.events].sort());
        for (const item of recorded) {
          expect(item, label).toMatchObject({
            organizationId: org.owner,
            outcome: 'SUCCESS',
            resourceType: 'Contract',
            resourceId: contractId.A,
          });
        }
        const instants = recorded.map((item) => Date.parse(item.occurredAt)).sort((a, b) => a - b);
        expect(
          instants[0]!,
          `${which}: "${label}" is no earlier than the call before it`,
        ).toBeGreaterThanOrEqual(previous);
        previous = instants[instants.length - 1]!;
      }
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

    // The correlated calls: every one's declared events are on the topic. The tap finds them by
    // the Kafka header, so a lost header fails here rather than leaving nothing to check below.
    // Awaited together: one wait, not one per call.
    const delivered = new Map(
      await Promise.all(
        evidence.map(
          async (entry) =>
            [
              entry.correlationId,
              await tap.awaitCorrelated(entry.correlationId, entry.events, EVENTS_WAIT_MS),
            ] as const,
        ),
      ),
    );
    const deliveriesOf = (label: string): ObservedEvent[] =>
      delivered.get(evidence.find((item) => item.label === label)!.correlationId)!;
    // The outbox delivers at least once (a row may be published again before it is marked
    // published): deliveries with one eventId are one logical event.
    const distinct = (events: ObservedEvent[]): ObservedEvent[] => [
      ...new Map(events.map((event) => [event.eventId, event])).values(),
    ];
    const payloadOf = (events: ObservedEvent[], name: string): Record<string, unknown> =>
      events.find((event) => event.eventName === name)!.payload;

    // Every delivery of the correlated calls — every one observed with the call's event ids, not
    // only those found by header, so a redelivery that lost its header cannot hide behind a
    // valid one — carries the call's correlation id in its header and in its envelope alike, and
    // an eventId; it was published under the employer's tenant and keyed by the contract.
    for (const entry of evidence) {
      const byHeader = delivered.get(entry.correlationId)!;
      expect(byHeader.length, `deliveries of "${entry.label}"`).toBeGreaterThan(0);
      const events = new Set([
        ...byHeader,
        ...tap.withEventIds(byHeader.map((event) => event.eventId)),
      ]);
      for (const event of events) {
        expect(
          { header: event.correlationId, envelope: event.envelopeCorrelationId },
          `${event.eventName} of "${entry.label}": correlation id`,
        ).toEqual({ header: entry.correlationId, envelope: entry.correlationId });
        expect(event.eventId, `${event.eventName} of "${entry.label}": eventId`).toBeTruthy();
        expect(event.tenantId, entry.label).toBe(org.owner);
        expect(Object.values(contractId), entry.label).toContain(event.key);
      }
    }

    // No event of the scenario's contracts carries an amount, a note or reason text (ADR-068
    // § 4): every one the tap observed keyed by one of them, not only the correlated calls' — the
    // drafts the awards created and the authority flags the move raised carry no correlation id
    // of ours (Codex r6 on #241). First the tap holds at least what audit-service counted above
    // for each contract, so the check cannot pass over an event that had not arrived yet.
    const amounts = [
      PRICE.A.c1,
      PRICE.A.c2,
      PRICE.B.c1,
      PRICE.B.c2,
      PRICE.C.c1,
      PRICE.C.c2,
      AMENDMENT_ONE,
      AMENDMENT_TWO,
      ...STATEMENT_ONE_LINES,
      STATEMENT_ONE_GROSS,
      STATEMENT_TWO_GROSS,
      'wrong lot',
      'Additional resurfacing',
      'Resurfacing works, section',
    ];
    const contractKey = new Map(TENDERS.map((key) => [contractId[key], key] as const));
    const ofContracts = await until(
      'every event audit-service recorded for the contracts, on the tap as well',
      async () => {
        const seen = tap.observed((event) => contractKey.has(event.key ?? ''));
        const complete = TENDERS.every((key) =>
          Object.entries(expectedByContract[key]).every(
            ([name, count]) =>
              distinct(
                seen.filter((event) => event.key === contractId[key] && event.eventName === name),
              ).length >= count,
          ),
        );
        return complete ? seen : undefined;
      },
      EVENTS_WAIT_MS,
    );
    for (const name of [
      'CONTRACT_DRAFTED',
      'CONTRACT_SIGNATURE_AUTHORITY_FLAGGED',
      'STATEMENT_DRAFTED',
      'STATEMENT_APPROVED',
    ]) {
      expect(
        ofContracts.some((event) => event.eventName === name),
        `${name} is among the events inspected`,
      ).toBe(true);
    }
    for (const event of ofContracts) {
      for (const leak of amounts) {
        expectNotDisclosed(event.payload, [leak]);
      }
    }

    // Each refusal is exactly one logical event on the topic, however often it was delivered,
    // with the action, subject and reason that were refused (the audit record above is its one
    // row).
    for (const entry of refusals) {
      const { event, payload } = entry.refusal!;
      const published = distinct(deliveriesOf(entry.label)).filter(
        (item) => item.eventName === event,
      );
      expect(published, `${event} of "${entry.label}" on the topic`).toHaveLength(1);
      expect(published[0]!.payload, entry.label).toMatchObject(payload);
    }
    expect(payloadOf(deliveriesOf('draft cancelled'), 'CONTRACT_CANCELLED')).toMatchObject({
      contractId: contractId.B,
      reasonCode: 'AWARD_ERROR',
    });
    expect(
      payloadOf(deliveriesOf('employer signature recorded and contract signed'), 'CONTRACT_SIGNED'),
    ).toMatchObject({ contractId: contractId.A });
    // The statement's facts name the statement and the step decided, by whom it was decided as
    // (organization and role), and nothing else.
    const statementFacts = {
      contractId: contractId.A,
      statementId: statementId.one,
      statementNumber: 1,
      organizationId: org.owner,
      contractorOrganizationId: org.c1,
    };
    expect(payloadOf(deliveriesOf('statement one submitted'), 'STATEMENT_SUBMITTED')).toMatchObject(
      {
        ...statementFacts,
        technicalPolicyId: statementPolicy.technical,
        financialPolicyId: statementPolicy.financial,
        milestoneIds: [milestoneId],
      },
    );
    for (const [label, chain, stepOrder, decider] of [
      ['statement one technical step 1', 'TECHNICAL', 1, org.consultant],
      ['statement one technical step 2', 'TECHNICAL', 2, org.owner],
      ['statement one financial step 1', 'FINANCIAL', 1, org.owner],
    ] as const) {
      expect(payloadOf(deliveriesOf(label), 'STATEMENT_DECISION_RECORDED'), label).toMatchObject({
        ...statementFacts,
        chain,
        stepOrder,
        outcome: 'APPROVED',
        deciderOrganizationId: decider,
        deciderRole: OWNER_ROLE,
      });
    }
    expect(
      payloadOf(deliveriesOf('statement one financial step 1'), 'STATEMENT_APPROVED'),
    ).toMatchObject(statementFacts);
  });
});
