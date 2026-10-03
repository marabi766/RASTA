import { runUnscoped } from '@rasta/nest-common';
import type { CriterionInput } from '../src/tender/criteria.dto';
import type { TenderApprovalRequestView } from '../src/tender/tender-approval.dto';
import {
  activePolicy,
  approvedProject,
  asAdmin,
  asApprover,
  cleanup,
  ensureGatePolicy,
  newOrganizationId,
  outboxFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * Tenant isolation of the tender approval gates (CON-002 PR 11, AGENTS.md § tenant isolation): A's tender, its
 * requests, their steps and their log are invisible to B — a 404 everywhere, never a 403 — and what B does
 * leaves nothing of A's changed. The authority a policy names is the one outsider that may see a step; it sees
 * that step and nothing else of the tender.
 */

const WHOLE: CriterionInput[] = [
  { code: 'PRICE', label: 'Price', weightBp: 6000, scoringMethod: 'MANUAL_SCORE', maxScore: 100 },
  { code: 'LICENCE', label: 'Licence', weightBp: 4000, scoringMethod: 'PASS_FAIL', maxScore: 1 },
];
const DAY = 24 * 60 * 60 * 1000;

describe('tenant isolation — tender approval gates', () => {
  let w: Wiring;
  const a = newOrganizationId();
  const b = newOrganizationId();
  const authority = newOrganizationId();
  let tenderId: string;
  let version: number;
  let request: TenderApprovalRequestView;
  let outboxBeforeA: number;
  let outboxBeforeB: number;

  const codeOf = async (call: Promise<unknown>) =>
    ((await call.then(
      () => undefined,
      (e: unknown) => e,
    )) ?? {}) as { code?: string };

  const draft = async (organizationId: string) => {
    const project = await approvedProject(w, organizationId);
    const tender = await asAdmin(organizationId, () =>
      w.tenders.create(project.id, {
        title: 'Road resurfacing',
        scopeOfWork: 'Two kilometres of the main road',
        procurementNature: 'FORMAL_TENDER',
        visibility: 'PUBLIC',
        bidOpeningAt: new Date(Date.now() + DAY).toISOString(),
        bidClosingAt: new Date(Date.now() + 30 * DAY).toISOString(),
      }),
    );
    const set = await asAdmin(organizationId, () =>
      w.criteria.setCriteria(tender.id, { expectedVersion: tender.version, criteria: WHOLE }),
    );
    return { tenderId: tender.id, version: set.version };
  };

  beforeAll(async () => {
    w = wire();
    // A's policy names an outside authority; A has asked to publish.
    ({ tenderId, version } = await draft(a));
    await activePolicy(w, a, [{ authorityOrganizationId: authority }], 'tender.publication');
    const answer = await asAdmin(a, () =>
      w.publication.publish(tenderId, { expectedVersion: version }),
    );
    if (answer.executed) throw new Error('expected a request');
    request = answer.request;
    // B has its own tender and its own gate.
    await draft(b);
    await ensureGatePolicy(w, b, 'tender.publication');
    outboxBeforeA = (await outboxFor(w.prisma, a)).length;
    outboxBeforeB = (await outboxFor(w.prisma, b)).length;
  });

  afterAll(async () => {
    await cleanup(w.prisma, [a, b, authority]);
    await w.close();
  });

  afterEach(async () => {
    // Whatever B tried, A's tender, request, steps, log and event stream are as they were.
    expect(await asAdmin(a, () => w.tenders.get(tenderId))).toMatchObject({
      status: 'DRAFT',
      version,
    });
    expect(await w.tenderApprovalRepository.log(w.prisma.client, a, tenderId)).toHaveLength(1);
    expect(await outboxFor(w.prisma, a)).toHaveLength(outboxBeforeA);
    expect(await outboxFor(w.prisma, b)).toHaveLength(outboxBeforeB);
    const steps = await runUnscoped('the suite reads the steps', () =>
      w.prisma.client.approval.findMany({ where: { tenderId } }),
    );
    expect(steps.map((s) => s.status)).toEqual(['PENDING']);
  });

  it('B cannot publish, award or cancel A’s tender: 404, nothing written, nothing logged', async () => {
    expect(
      (
        await codeOf(
          asAdmin(b, () => w.publication.publish(tenderId, { expectedVersion: version })),
        )
      ).code,
    ).toBe('NOT_FOUND');
    expect(
      (
        await codeOf(
          asAdmin(b, () =>
            w.tenders.cancel(tenderId, {
              expectedVersion: version,
              reason: 'Cross-tenant attempt',
              reasonCode: 'OWNER_REQUEST',
            }),
          ),
        )
      ).code,
    ).toBe('NOT_FOUND');
    expect(
      (await codeOf(asAdmin(b, () => w.award.award(tenderId, { bidId: 'BID_ANY' })))).code,
    ).toBe('NOT_FOUND');
  });

  it('B cannot list A’s requests: 404', async () => {
    expect(
      (await codeOf(asAdmin(b, () => w.tenderApprovals.listForTender(tenderId, { limit: 25 }))))
        .code,
    ).toBe('NOT_FOUND');
  });

  it('B cannot read or decide A’s approval: 404, and its inbox does not list it', async () => {
    const stepId = request.steps[0]!.approvalId;
    expect((await codeOf(asApprover(b, () => w.approvals.get(stepId)))).code).toBe('NOT_FOUND');
    expect(
      (
        await codeOf(
          asApprover(b, () =>
            w.approvals.decide(stepId, { decision: 'GRANT', expectedVersion: 1 }),
          ),
        )
      ).code,
    ).toBe('NOT_FOUND');
    const inbox = await asApprover(b, () => w.approvals.inbox({ limit: 50, status: 'PENDING' }));
    expect(inbox.items.some((item) => item.id === stepId)).toBe(false);
  });

  it('the authority the policy names sees its step, and nothing else of A’s tender', async () => {
    const stepId = request.steps[0]!.approvalId;
    const seen = await asApprover(authority, () => w.approvals.get(stepId));
    expect(seen).toMatchObject({ id: stepId, tenderId, workflowKey: 'tender.publication' });
    // It is not the owner: A’s tender, its requests and its commands are still A's alone.
    expect(
      (
        await codeOf(
          asApprover(authority, () => w.tenderApprovals.listForTender(tenderId, { limit: 5 })),
        )
      ).code,
    ).toBe('NOT_FOUND');
    expect(
      (
        await codeOf(
          asAdmin(authority, () => w.publication.publish(tenderId, { expectedVersion: version })),
        )
      ).code,
    ).toBe('NOT_FOUND');
  });

  it('every repository read and write names the tender’s organization: B’s never reaches A’s rows', async () => {
    const repo = w.tenderApprovalRepository;
    const client = w.prisma.client;
    expect(await repo.findLive(client, b, tenderId, 'tender.publication')).toBeNull();
    expect(await repo.findById(client, b, request.id)).toBeNull();
    expect(await repo.listOfTender(client, b, tenderId, { limit: 10 })).toEqual([]);
    expect(await repo.log(client, b, tenderId)).toEqual([]);
    expect(await repo.bidderOrganizationIds(client, b, tenderId)).toEqual([]);
    const matched = await w.prisma.transaction(async (tx) => ({
      ended: await repo.end(tx, {
        organizationId: b,
        id: request.id,
        reason: 'STALE',
        at: new Date(),
      }),
      consumed: await repo.consume(tx, {
        organizationId: b,
        id: request.id,
        by: 'USR_X',
        identity: { issuer: null, subject: null },
        at: new Date(),
      }),
    }));
    expect(matched).toEqual({ ended: 0, consumed: 0 });
  });

  it('under the tenant guard a caller reads only its own requests and log', async () => {
    const own = await asAdmin(b, async () => ({
      requests: await w.prisma.client.tenderApprovalRequest.findMany(),
      log: await w.prisma.client.tenderApprovalLog.findMany(),
    }));
    expect(own.requests.every((row) => row.organizationId === b)).toBe(true);
    expect(own.log.every((row) => row.organizationId === b)).toBe(true);
    const mine = await asAdmin(a, async () =>
      w.prisma.client.tenderApprovalRequest.findMany({ where: { tenderId } }),
    );
    expect(mine.map((row) => row.id)).toEqual([request.id]);
  });
});
