import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { liveAccessToken, type ProvisionedPerson } from './live-session';
import { provisionPerson, provisionedAccessToken } from './provisioned-people';

/**
 * The people and the tenders the live bid scenarios act on, made through the
 * platform's own routes — through the gateway, as the people the platform
 * says may make them — never rows written behind a service's back. The model
 * is `tests/e2e/specs/construction/03-tender-lifecycle.e2e-spec.ts`; nothing
 * here exists only for a test.
 *
 * ## Once per run (`castForRun`)
 *
 * - **the owner** — an organization made for this run under ORG-UNION-YAZD,
 *   so `union.admin` may write its approval policies (Q-70 (7)); its
 *   `project.execution` and `tender.publication` policies, written by
 *   `union.admin` and put in force by `system.admin`, each one step naming the
 *   owner's `ORGANIZATION_ADMIN` (samples, `isSample`: no authority claimed);
 *   two people with that role — the author, and the approver (the person who
 *   asks never approves); and one approved project.
 * - **the contractor** — an organization of its own, a `CONTRACTOR` in it, and
 *   its qualification for CONTRACTING at supplier-service: registered by the
 *   contractor, approved by `system.admin`.
 * - **an unqualified contractor** — invited like the first, never qualified.
 * - **another tenant's contractor** — a `CONTRACTOR` acting for ORG-DEH-0002,
 *   invited to nothing.
 * - with `{ evaluation: true }`: the owner's `tender.award` policy (one step,
 *   naming the `ORGANIZATION_ADMIN` of a **reviewer** organization made for the
 *   run — an authority who cannot read the owner's tender; a sample), the
 *   reviewer's administrator, an **evaluator** — a third owner
 *   `ORGANIZATION_ADMIN`, who takes no other part, so that the author may award
 *   (`AWARDER_NOT_EVALUATOR`) — and a **rival**: a second qualified contractor,
 *   invited like the first.
 *
 * ## Once per test (`draftTender`, `publishedTender`, `openedTender`)
 *
 * A fresh RESTRICTED tender on that project, the contractors invited, its
 * criteria written out, its window set — left in draft for the owner's own
 * scenarios, published through its approval round, or bid on, closed by the
 * service at its deadline and opened by two people — so a retry of a test
 * acts on a tender nobody has acted on. From an opened one, through the
 * gateway, each later stage the evaluation scenarios start from:
 * `evaluatedTender`, `awardRequestedTender`, `awardApprovedTender`,
 * `awardedTender` — so no test needs another to have run first.
 */

const OWNER_ROLE = 'ORGANIZATION_ADMIN';
const UNION = 'ORG-UNION-YAZD';
const STRANGER_TENANT = 'ORG-DEH-0002';

export const TENDER_CRITERIA = [
  {
    code: 'technical',
    label: 'روش اجرا (نمونه)',
    weightBp: 7000,
    scoringMethod: 'MANUAL_SCORE',
    maxScore: 10,
  },
  {
    code: 'compliance',
    label: 'کامل‌بودن مدارک (نمونه)',
    weightBp: 3000,
    scoringMethod: 'PASS_FAIL',
    maxScore: 1,
  },
] as const;

function gatewayUrl(path: string): string {
  const base = process.env.API_GATEWAY_URL?.trim();
  if (!base) throw new Error('The live bid scenarios require API_GATEWAY_URL');
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** One gateway call that must answer `status`; its body. Every unsafe call carries a fresh key. */
export async function gateway(
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  path: string,
  status: number,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(gatewayUrl(path), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'idempotency-key': `e2e-bids-${randomUUID()}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer: unknown = await response.json().catch(() => null);
  if (response.status !== status) {
    const code = (answer as { code?: unknown } | null)?.code;
    throw new Error(
      `${method} ${path} answered ${response.status} (${String(code)}), not ${status}`,
    );
  }
  return answer;
}

const withId = z.object({ id: z.string() });
const versioned = z.object({ id: z.string(), version: z.number().int() });

export interface TenderCast {
  readonly owner: string;
  readonly projectId: string;
  readonly author: string;
  readonly approver: string;
  /** The same two, to act in a browser. */
  readonly authorPerson: ProvisionedPerson;
  readonly approverPerson: ProvisionedPerson;
  readonly contractor: ProvisionedPerson;
  readonly unqualified: ProvisionedPerson;
  readonly stranger: ProvisionedPerson;
  /** `{ evaluation: true }` only: the owner's evaluator, and a second qualified contractor. */
  readonly evaluatorPerson: ProvisionedPerson | null;
  readonly rival: ProvisionedPerson | null;
  /** `{ evaluation: true }` only: the award's authority, an administrator of another organization. */
  readonly reviewerPerson: ProvisionedPerson | null;
}

async function organization(systemAdmin: string, name: string, parentId?: string) {
  const created = await gateway(systemAdmin, 'POST', '/v1/organizations', 201, {
    name,
    type: parentId ? 'MUNICIPALITY' : 'COMPANY',
    ...(parentId ? { parentId } : {}),
  });
  return withId.parse(created).id;
}

/** `union.admin` writes and submits; `system.admin`, a different person, puts it in force. */
async function policy(
  union: string,
  systemAdmin: string,
  owner: string,
  workflowKey: string,
  approvalType: string,
  /** The organization whose administrator decides: the owner's own unless named. */
  authority: string = owner,
): Promise<void> {
  const created = withId.parse(
    await gateway(union, 'POST', '/v1/approval-policies', 201, {
      organizationId: owner,
      workflowKey,
      label: `E2E sample — ${approvalType}`,
      rationale: 'Written by the portal browser suite; a sample, not an adopted procedure',
      isSample: true,
      steps: [
        {
          approvalType,
          authorityOrganizationId: authority,
          authorityRole: OWNER_ROLE,
          authorityLabel:
            authority === owner
              ? 'Owner administrator (sample)'
              : 'Reviewer administrator (sample)',
        },
      ],
    }),
  );
  const submitted = versioned.parse(
    await gateway(union, 'POST', `/v1/approval-policies/${created.id}/submit`, 200, {
      expectedVersion: 1,
    }),
  );
  await gateway(systemAdmin, 'POST', `/v1/approval-policies/${created.id}/approve`, 200, {
    expectedVersion: submitted.version,
  });
}

/** The authority reads its step for the version, and grants it. */
async function grant(approver: string, approvalId: string): Promise<unknown> {
  const step = versioned.parse(await gateway(approver, 'GET', `/v1/approvals/${approvalId}`, 200));
  return gateway(approver, 'POST', `/v1/approvals/${approvalId}/decision`, 200, {
    expectedVersion: step.version,
    decision: 'GRANT',
  });
}

/** A contractor's standing, as supplier-service holds it: registered by it, its CONTRACTING qualification approved. */
async function qualify(systemAdmin: string, who: ProvisionedPerson, name: string): Promise<void> {
  const token = await provisionedAccessToken(who);
  const supplier = withId.parse(
    await gateway(token, 'POST', '/v1/suppliers', 201, {
      displayName: name,
      capabilities: ['CONTRACTING'],
    }),
  );
  const qualification = withId.parse(
    await gateway(token, 'POST', `/v1/suppliers/${supplier.id}/qualifications`, 201, {
      capability: 'CONTRACTING',
    }),
  );
  await gateway(
    systemAdmin,
    'POST',
    `/v1/suppliers/${supplier.id}/qualifications/${qualification.id}/approve`,
    200,
    {},
  );
}

/** The cast of one run; see the module header. `run` names everything it makes. */
export async function castForRun(
  run: string,
  { evaluation = false }: { readonly evaluation?: boolean } = {},
): Promise<TenderCast> {
  const systemAdmin = await liveAccessToken('systemAdmin');
  const union = await liveAccessToken('unionAdmin');

  const owner = await organization(systemAdmin, `E2E bid owner ${run}`, UNION);
  const contractorOrg = await organization(systemAdmin, `E2E bid contractor ${run}`);
  const unqualifiedOrg = await organization(systemAdmin, `E2E bid unqualified ${run}`);

  const person = (label: string, org: string, roles: string[]) =>
    provisionPerson(systemAdmin, `e2e.bids.${run}.${label}`, org, roles);
  const authorPerson = await person('author', owner, [OWNER_ROLE]);
  const approverPerson = await person('approver', owner, [OWNER_ROLE]);
  const contractor = await person('contractor', contractorOrg, ['CONTRACTOR']);
  const unqualified = await person('unqualified', unqualifiedOrg, ['CONTRACTOR']);
  const stranger = await person('stranger', STRANGER_TENANT, ['CONTRACTOR']);
  const author = await provisionedAccessToken(authorPerson);
  const approver = await provisionedAccessToken(approverPerson);

  // The contractor's standing, as supplier-service holds it: registered by the
  // contractor, its CONTRACTING qualification approved by the platform.
  await qualify(systemAdmin, contractor, `E2E bid contractor ${run}`);

  await policy(union, systemAdmin, owner, 'project.execution', 'Execution approval (sample)');
  await policy(union, systemAdmin, owner, 'tender.publication', 'Publication approval (sample)');

  let evaluatorPerson: ProvisionedPerson | null = null;
  let rival: ProvisionedPerson | null = null;
  let reviewerPerson: ProvisionedPerson | null = null;
  if (evaluation) {
    // The award's authority is another organization's administrator, who cannot read the
    // owner's tender and decides from the approval inbox (PR 346 review 1, finding 3).
    const reviewerOrg = await organization(systemAdmin, `E2E bid reviewer ${run}`);
    reviewerPerson = await person('reviewer', reviewerOrg, [OWNER_ROLE]);
    await policy(union, systemAdmin, owner, 'tender.award', 'Award approval (sample)', reviewerOrg);
    evaluatorPerson = await person('evaluator', owner, [OWNER_ROLE]);
    const rivalOrg = await organization(systemAdmin, `E2E bid rival ${run}`);
    rival = await person('rival', rivalOrg, ['CONTRACTOR']);
    await qualify(systemAdmin, rival, `E2E bid rival ${run}`);
  }

  const project = versioned.parse(
    await gateway(author, 'POST', '/v1/projects', 201, {
      title: 'بهسازی راه روستایی',
      operationType: 'road',
      scopeOfWork: 'Resurfacing of the access road',
      locationDescription: 'Access road, east side',
      estimatedCostMinor: '5000000000',
    }),
  );
  const need = withId.parse(
    await gateway(author, 'POST', `/v1/projects/${project.id}/needs`, 201, {
      title: 'Contractor',
      description: 'Resurfacing works, two kilometres',
    }),
  );
  await gateway(author, 'POST', `/v1/projects/${project.id}/needs/${need.id}/submit`, 200, {
    expectedVersion: 1,
  });
  await gateway(author, 'POST', `/v1/projects/${project.id}/approvals`, 200, {
    expectedVersion: project.version,
  });
  const steps = z
    .array(z.object({ id: z.string(), status: z.string() }))
    .parse(await gateway(author, 'GET', `/v1/projects/${project.id}/approvals`, 200));
  const pending = steps.find((step) => step.status === 'PENDING');
  if (!pending) throw new Error('the project approval round opened no pending step');
  await grant(approver, pending.id);

  return {
    owner,
    projectId: project.id,
    author,
    approver,
    authorPerson,
    approverPerson,
    contractor,
    unqualified,
    stranger,
    evaluatorPerson,
    rival,
    reviewerPerson,
  };
}

/**
 * A fresh RESTRICTED tender in draft, open for bids from now until
 * `closesInMs` from now, both contractors invited and — unless `criteria` is
 * false — its criteria written out: everything a publication needs but the
 * approval. Its id, its closing and the version a publication binds.
 */
export async function draftTender(
  cast: TenderCast,
  closesInMs: number,
  { criteria = true }: { readonly criteria?: boolean } = {},
): Promise<{ readonly id: string; readonly closesAt: number; readonly version: number }> {
  const { author } = cast;
  const drafted = versioned.parse(
    await gateway(author, 'POST', `/v1/projects/${cast.projectId}/tenders`, 201, {
      title: 'بهسازی راه دسترسی',
      scopeOfWork: 'Resurfacing of two kilometres of the access road',
    }),
  );
  const id = drafted.id;
  const opensAt = Date.now();
  const closesAt = opensAt + closesInMs;
  let current = versioned.parse(
    await gateway(author, 'PATCH', `/v1/tenders/${id}`, 200, {
      expectedVersion: drafted.version,
      procurementNature: 'FORMAL_TENDER',
      visibility: 'RESTRICTED',
      bidOpeningAt: new Date(opensAt).toISOString(),
      bidClosingAt: new Date(closesAt).toISOString(),
    }),
  );
  const invitees = [cast.contractor, cast.unqualified, ...(cast.rival ? [cast.rival] : [])];
  for (const invited of invitees.map((who) => who.organizationId)) {
    await gateway(author, 'POST', `/v1/tenders/${id}/invitations`, 201, {
      organizationId: invited,
    });
  }
  current = versioned.parse(await gateway(author, 'GET', `/v1/tenders/${id}`, 200));
  if (criteria) {
    await gateway(author, 'PUT', `/v1/tenders/${id}/criteria`, 200, {
      expectedVersion: current.version,
      criteria: TENDER_CRITERIA,
    });
    current = versioned.parse(await gateway(author, 'GET', `/v1/tenders/${id}`, 200));
  }
  return { id, closesAt, version: current.version };
}

/**
 * A fresh tender as `draftTender` makes it, published through its approval
 * round. Its id and its closing.
 */
export async function publishedTender(
  cast: TenderCast,
  closesInMs: number,
): Promise<{ readonly id: string; readonly closesAt: number }> {
  const { author, approver } = cast;
  const { id, closesAt, version } = await draftTender(cast, closesInMs);

  // Publication: asked, granted by a second person, then executed on the same version.
  const asked = z.object({ steps: z.array(z.object({ approvalId: z.string() })).min(1) }).parse(
    await gateway(author, 'POST', `/v1/tenders/${id}/publish`, 202, {
      expectedVersion: version,
    }),
  );
  await grant(approver, asked.steps[0]!.approvalId);
  z.object({ status: z.literal('PUBLISHED') }).parse(
    await gateway(author, 'POST', `/v1/tenders/${id}/publish`, 200, {
      expectedVersion: version,
    }),
  );
  return { id, closesAt };
}

/** A contractor's bid on an open tender, through the gateway: `priceMinor` and one answer. */
export async function contractorBid(
  cast: TenderCast,
  tenderId: string,
  priceMinor: string,
  bidder: ProvisionedPerson = cast.contractor,
): Promise<void> {
  await gateway(await provisionedAccessToken(bidder), 'POST', `/v1/tenders/${tenderId}/bids`, 201, {
    content: {
      priceMinor,
      answers: [{ criterionCode: 'technical', response: 'روش اجرا با ماشین‌آلات خودی' }],
    },
  });
}

/** One gateway call; its status and body, whatever they are. */
async function attempt(
  token: string,
  path: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(gatewayUrl(path), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': `e2e-bids-${randomUUID()}`,
    },
    body: '{}',
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * A fresh tender as `publishedTender` makes it, bid on by the contractor and
 * the rival (a `{ evaluation: true }` cast), closed by construction-service at
 * its deadline, and opened by two people through the gateway: the author
 * proposes, the approver opens — again while audit-service is still catching
 * up with the receipts (`EVIDENCE_BEHIND`, `503`), each a refusal that opened
 * nothing. Its id, once it is `EVALUATING`.
 */
export async function openedTender(
  cast: TenderCast,
  prices: { readonly contractor: string; readonly rival: string },
): Promise<{ readonly id: string }> {
  if (!cast.rival) throw new Error('openedTender needs a cast made with { evaluation: true }');
  const { id, closesAt } = await publishedTender(cast, 60_000);
  await contractorBid(cast, id, prices.contractor);
  await contractorBid(cast, id, prices.rival, cast.rival);
  const status = async () =>
    z
      .object({ status: z.string() })
      .parse(await gateway(cast.author, 'GET', `/v1/tenders/${id}`, 200)).status;
  // construction-service closes it itself at the deadline; nobody closes it by hand.
  const until = closesAt + 120_000;
  while ((await status()) !== 'CLOSED') {
    if (Date.now() > until) throw new Error(`tender ${id} was not closed at its deadline`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await gateway(cast.author, 'POST', `/v1/tenders/${id}/open-bids/proposal`, 200, {});
  const giveUp = Date.now() + 90_000;
  for (;;) {
    const opened = await attempt(cast.approver, `/v1/tenders/${id}/open-bids`);
    if (opened.status === 200) break;
    const code = (opened.body as { code?: unknown } | null)?.code;
    const behind = opened.status === 422 && JSON.stringify(opened.body).includes('EVIDENCE_BEHIND');
    if (Date.now() > giveUp || (opened.status !== 503 && !behind)) {
      throw new Error(`opening ${id} answered ${opened.status} (${String(code)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if ((await status()) !== 'EVALUATING') throw new Error(`tender ${id} is not EVALUATING`);
  return { id };
}

/**
 * The cast with its people's tokens taken anew: a test that starts long after
 * the cast was made acts on tokens of its own, not on ones that may have run
 * out by then.
 */
export async function freshCast(cast: TenderCast): Promise<TenderCast> {
  const [author, approver] = await Promise.all([
    provisionedAccessToken(cast.authorPerson),
    provisionedAccessToken(cast.approverPerson),
  ]);
  return { ...cast, author, approver };
}

const matrixBids = z.object({
  bids: z.array(z.object({ bidId: z.string(), bidderOrganizationId: z.string() })),
});

/** The tender's bids by their bidders, as the evaluator's matrix names them. */
async function bidsOf(evaluator: string, id: string): Promise<Map<string, string>> {
  const { bids } = matrixBids.parse(
    await gateway(evaluator, 'GET', `/v1/tenders/${id}/evaluation`, 200),
  );
  return new Map(bids.map((bid) => [bid.bidderOrganizationId, bid.bidId]));
}

/**
 * A fresh tender as `openedTender` makes it, evaluated through the gateway by
 * the evaluator — the contractor qualified and scored (8.5 and a pass: rank 1),
 * the rival disqualified — and completed. Its id and the contractor's bid, once
 * it is `EVALUATED`.
 */
export async function evaluatedTender(
  cast: TenderCast,
  prices: { readonly contractor: string; readonly rival: string },
): Promise<{ readonly id: string; readonly bidId: string }> {
  const { id } = await openedTender(cast, prices);
  const evaluator = await provisionedAccessToken(cast.evaluatorPerson!);
  const bids = await bidsOf(evaluator, id);
  const bidId = bids.get(cast.contractor.organizationId)!;
  const rivalBid = bids.get(cast.rival!.organizationId)!;
  const tender = `/v1/tenders/${id}`;
  await gateway(evaluator, 'POST', `${tender}/bids/${bidId}/qualification`, 200, {
    decision: 'QUALIFIED',
  });
  await gateway(evaluator, 'POST', `${tender}/bids/${rivalBid}/qualification`, 200, {
    decision: 'DISQUALIFIED',
    reasonCode: 'NON_RESPONSIVE',
    reasonText: 'مدارک فنی پیوست نشده بود (آزمون)',
  });
  const [technical, compliance] = TENDER_CRITERIA;
  await gateway(evaluator, 'POST', `${tender}/bids/${bidId}/scores`, 200, {
    scores: [
      { criterionCode: technical.code, scoreScaled: 850, expectedRevision: 0 },
      {
        criterionCode: compliance.code,
        scoreScaled: compliance.maxScore * 100,
        expectedRevision: 0,
      },
    ],
  });
  await gateway(evaluator, 'POST', `${tender}/evaluate`, 200, {});
  return { id, bidId };
}

/**
 * A fresh tender as `evaluatedTender` makes it, its award to the contractor
 * asked for by the author: the request pending on the reviewer's step. Its id,
 * the bid and the step.
 */
export async function awardRequestedTender(
  cast: TenderCast,
  prices: { readonly contractor: string; readonly rival: string },
): Promise<{ readonly id: string; readonly bidId: string; readonly approvalId: string }> {
  const { id, bidId } = await evaluatedTender(cast, prices);
  const asked = z
    .object({ steps: z.array(z.object({ approvalId: z.string() })).min(1) })
    .parse(await gateway(cast.author, 'POST', `/v1/tenders/${id}/award`, 202, { bidId }));
  return { id, bidId, approvalId: asked.steps[0]!.approvalId };
}

/** A fresh tender as `awardRequestedTender` makes it, its award granted by the reviewer. */
export async function awardApprovedTender(
  cast: TenderCast,
  prices: { readonly contractor: string; readonly rival: string },
): Promise<{ readonly id: string; readonly bidId: string }> {
  const { id, bidId, approvalId } = await awardRequestedTender(cast, prices);
  await grant(await provisionedAccessToken(cast.reviewerPerson!), approvalId);
  return { id, bidId };
}

/**
 * A fresh tender as `awardApprovedTender` makes it, the award executed by the
 * author through the gateway — again while audit-service or supplier-service
 * is still catching up (`503`/`504`), each a refusal that awarded nothing. Its
 * id, once it is `AWARDED`.
 */
export async function awardedTender(
  cast: TenderCast,
  prices: { readonly contractor: string; readonly rival: string },
): Promise<{ readonly id: string }> {
  const { id, bidId } = await awardApprovedTender(cast, prices);
  const giveUp = Date.now() + 90_000;
  for (;;) {
    const response = await fetch(gatewayUrl(`/v1/tenders/${id}/award`), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cast.author}`,
        'content-type': 'application/json',
        'idempotency-key': `e2e-bids-${randomUUID()}`,
      },
      body: JSON.stringify({ bidId }),
    });
    if (response.status === 200) break;
    if (Date.now() > giveUp || (response.status !== 503 && response.status !== 504)) {
      throw new Error(`awarding ${id} answered ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return { id };
}
