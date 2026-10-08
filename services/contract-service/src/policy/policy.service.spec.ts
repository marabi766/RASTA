import { runWithContext, type RequestContext } from '@rasta/nest-common';
import type { ContractEnv } from '../config/env';
import type { EventPublisher } from '../events/publisher';
import type { OrganizationDirectory } from '../organization/organization-directory';
import type { PrismaService } from '../prisma/prisma.service';
import { PolicyAccess } from './policy.access';
import type { PolicyRepository, PolicyWithSteps } from './policy.repository';
import { PolicyService } from './policy.service';

/**
 * The branches of the policy service that need a database to misbehave on cue: two writers
 * drawing the same version, a retry racing a transition, the listing's page boundary, and the
 * start-up warning. The behaviour against a real database is `test/approval-policy.int-spec.ts`.
 */

const env = (overrides: Partial<ContractEnv> = {}) =>
  ({
    CONTRACT_READER_ROLES: ['ORGANIZATION_ADMIN'],
    CONTRACT_POLICY_FOUR_EYES: true,
    ...overrides,
  }) as ContractEnv;

const as = <T>(roles: string[], fn: () => T, organizationId = 'ORG_UNION'): T =>
  runWithContext(
    {
      requestId: 'r',
      correlationId: 'c',
      authType: 'USER',
      organizationId,
      userId: 'USR_1',
      roles,
      startedAt: Date.now(),
    } as unknown as RequestContext,
    fn,
  );

function service(options: {
  config?: ContractEnv;
  transaction?: (fn: unknown) => Promise<unknown>;
  rows?: PolicyWithSteps[];
}) {
  const prisma = {
    client: {},
    transaction: options.transaction ?? (async () => undefined),
  } as unknown as PrismaService;
  const repository = {
    listPolicies: async () => options.rows ?? [],
  } as unknown as PolicyRepository;
  const config = options.config ?? env();
  return new PolicyService(
    prisma,
    repository,
    {} as EventPublisher,
    new PolicyAccess(config),
    { isWithin: async () => true } as unknown as OrganizationDirectory,
    config,
  );
}

const dto = {
  organizationId: 'ORG_EMPLOYER',
  workflowKey: 'contract.signature' as const,
  label: 'Who signs',
  rationale: 'For the unit suite',
  isSample: true,
  steps: [
    {
      authorityOrganizationId: 'ORG_EMPLOYER',
      authorityRole: 'ORGANIZATION_ADMIN',
      authorityLabel: 'Signer',
    },
  ],
};

describe('PolicyService', () => {
  it('turns two writers who drew the same version into a retryable CONFLICT, not a 500', async () => {
    const svc = service({
      transaction: async () => {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      },
    });
    await expect(as(['UNION_ADMIN'], () => svc.create(dto))).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/Another policy version was created at the same time/),
    });
  });

  it('lets any other failure through untouched', async () => {
    const boom = new Error('the database went away');
    const svc = service({
      transaction: async () => {
        throw boom;
      },
    });
    await expect(as(['UNION_ADMIN'], () => svc.create(dto))).rejects.toBe(boom);
  });

  it('pages the listing: one more row than the limit means there is another page, keyed by the last shown', async () => {
    const row = (id: string) => ({ id, steps: [] }) as unknown as PolicyWithSteps;
    const rows = [row('APL_3'), row('APL_2'), row('APL_1')].map((r) => ({
      ...r,
      organizationId: 'ORG_EMPLOYER',
      authorOrganizationId: 'ORG_UNION',
      authorRole: 'UNION_ADMIN',
      workflowKey: 'contract.signature',
      policyVersion: 1,
      status: 'DRAFT',
      label: 'x',
      rationale: 'y',
      isSample: false,
      createdAt: new Date(),
      createdBy: 'USR_1',
      submittedAt: null,
      submittedBy: null,
      activatedAt: null,
      activatedBy: null,
      rejectedAt: null,
      rejectedBy: null,
      rejectionReason: null,
      retiredAt: null,
      retiredBy: null,
      version: 1,
    })) as unknown as PolicyWithSteps[];
    const svc = service({ rows });

    const first = await as(['UNION_ADMIN'], () => svc.list({ limit: 2 }));
    expect(first.items.map((item) => item.id)).toEqual(['APL_3', 'APL_2']);
    expect(first).toMatchObject({ hasMore: true, nextCursor: 'APL_2' });

    const all = await as(['UNION_ADMIN'], () => svc.list({ limit: 5 }));
    expect(all).toMatchObject({ hasMore: false, nextCursor: null });
    expect(all.items).toHaveLength(3);
  });

  it('says so, once, at start-up when four eyes are switched off — and is silent when on', () => {
    const warn = jest.fn();
    const quiet = service({});
    (quiet as unknown as { logger: { warn: typeof warn } }).logger = { warn };
    quiet.onModuleInit();
    expect(warn).not.toHaveBeenCalled();

    const relaxed = service({ config: env({ CONTRACT_POLICY_FOUR_EYES: false }) });
    (relaxed as unknown as { logger: { warn: typeof warn } }).logger = { warn };
    relaxed.onModuleInit();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/CONTRACT_POLICY_FOUR_EYES is off/);
  });
});
