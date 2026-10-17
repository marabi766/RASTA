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
 *
 * ## Once per test (`publishedTender`)
 *
 * A fresh RESTRICTED tender on that project, both contractors invited, its
 * criteria written out, its window set, published through its approval round
 * — so a retry of a test bids on a tender nobody has bid on.
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
  readonly contractor: ProvisionedPerson;
  readonly unqualified: ProvisionedPerson;
  readonly stranger: ProvisionedPerson;
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
          authorityOrganizationId: owner,
          authorityRole: OWNER_ROLE,
          authorityLabel: 'Owner administrator (sample)',
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

/** The cast of one run; see the module header. `run` names everything it makes. */
export async function castForRun(run: string): Promise<TenderCast> {
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
  const contractorToken = await provisionedAccessToken(contractor);
  const supplier = withId.parse(
    await gateway(contractorToken, 'POST', '/v1/suppliers', 201, {
      displayName: `E2E bid contractor ${run}`,
      capabilities: ['CONTRACTING'],
    }),
  );
  const qualification = withId.parse(
    await gateway(contractorToken, 'POST', `/v1/suppliers/${supplier.id}/qualifications`, 201, {
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

  await policy(union, systemAdmin, owner, 'project.execution', 'Execution approval (sample)');
  await policy(union, systemAdmin, owner, 'tender.publication', 'Publication approval (sample)');

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
    contractor,
    unqualified,
    stranger,
  };
}

/**
 * A fresh RESTRICTED tender, published, open for bids from now until
 * `closesInMs` from now, both contractors invited. Its id and its closing.
 */
export async function publishedTender(
  cast: TenderCast,
  closesInMs: number,
): Promise<{ readonly id: string; readonly closesAt: number }> {
  const { author, approver } = cast;
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
  for (const invited of [cast.contractor.organizationId, cast.unqualified.organizationId]) {
    await gateway(author, 'POST', `/v1/tenders/${id}/invitations`, 201, {
      organizationId: invited,
    });
  }
  current = versioned.parse(await gateway(author, 'GET', `/v1/tenders/${id}`, 200));
  await gateway(author, 'PUT', `/v1/tenders/${id}/criteria`, 200, {
    expectedVersion: current.version,
    criteria: TENDER_CRITERIA,
  });
  current = versioned.parse(await gateway(author, 'GET', `/v1/tenders/${id}`, 200));

  // Publication: asked, granted by a second person, then executed on the same version.
  const asked = z.object({ steps: z.array(z.object({ approvalId: z.string() })).min(1) }).parse(
    await gateway(author, 'POST', `/v1/tenders/${id}/publish`, 202, {
      expectedVersion: current.version,
    }),
  );
  await grant(approver, asked.steps[0]!.approvalId);
  z.object({ status: z.literal('PUBLISHED') }).parse(
    await gateway(author, 'POST', `/v1/tenders/${id}/publish`, 200, {
      expectedVersion: current.version,
    }),
  );
  return { id, closesAt };
}
