import { RastaError, runWithContext, runUnscoped, type RequestContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventPublisher } from '../src/events/publisher';
import { ProjectRepository } from '../src/project/project.repository';
import { ProjectService } from '../src/project/project.service';
import { NeedService } from '../src/project/need.service';
import { ProjectAccess } from '../src/access/access';
import { IdempotencyStore } from '../src/shared/idempotency';
import { ApprovalRepository } from '../src/approval/approval.repository';
import { ApprovalService } from '../src/approval/approval.service';
import { PolicyService } from '../src/approval/policy.service';
import { ExecutionService } from '../src/project/execution.service';
import { ProgressService } from '../src/progress/progress.service';
import { OrganizationDirectory } from '../src/organization/organization-directory';
import { loadConstructionEnv, type ConstructionEnv } from '../src/config/env';
import type { CreateProjectDto } from '../src/project/dto';

/**
 * Scaffolding for the integration suites.
 *
 * Everything asserted under `test/` is a property only PostgreSQL has: the
 * row lock and the compare-and-set that decide a race, the CHECK constraints,
 * the tenant-bound foreign key, PostGIS validity, and the transactional
 * coupling of a state change with its outbox row. None of it is visible to a
 * unit test. The helpers are deliberately thin so the tests touch the real
 * database.
 *
 * Needs `DATABASE_URL_CONSTRUCTION` pointing at `rasta_construction` with this
 * service's migration applied (`pnpm --filter @rasta/construction-service db:migrate`).
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_CONSTRUCTION;
  if (!url) {
    throw new Error(
      'DATABASE_URL_CONSTRUCTION is not set. These tests run against a real PostgreSQL with ' +
        "PostGIS; start it with `pnpm infra:up` and apply this service's migration first.",
    );
  }
  return url;
}

export function testEnv(overrides: Record<string, string> = {}): ConstructionEnv {
  return loadConstructionEnv({
    ...process.env,
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? 'localhost:9092',
    // Never used by these suites: they call the domain with an explicit
    // RequestContext. Throwaway values the schema demands.
    OIDC_ISSUER_URL: process.env.OIDC_ISSUER_URL ?? 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI:
      process.env.OIDC_JWKS_URI ??
      'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: process.env.OIDC_AUDIENCE ?? 'rasta-api',
    INTERNAL_TOKEN_SECRET:
      process.env.INTERNAL_TOKEN_SECRET ?? 'integration_suite_unused_secret_32_chars',
    ...overrides,
  });
}

export interface Wiring {
  prisma: PrismaService;
  env: ConstructionEnv;
  repository: ProjectRepository;
  projects: ProjectService;
  needs: NeedService;
  approvalRepository: ApprovalRepository;
  approvals: ApprovalService;
  policies: PolicyService;
  /** The organization hierarchy these suites see instead of organization-service. */
  hierarchy: FakeHierarchy;
  execution: ExecutionService;
  progress: ProgressService;
  close(): Promise<void>;
}

/**
 * The domain, wired by hand — no Nest container, no relay (so outbox rows stay
 * where a test can read them), no Kafka.
 */
export function wire(env: ConstructionEnv = testEnv()): Wiring {
  const prisma = new PrismaService(databaseUrl());
  const hierarchy = new FakeHierarchy();
  const events = new EventPublisher(env);
  const repository = new ProjectRepository(prisma);
  const access = new ProjectAccess(env);
  const idempotency = new IdempotencyStore(prisma, env);
  const approvalRepository = new ApprovalRepository(prisma);
  const projects = new ProjectService(
    prisma,
    repository,
    events,
    access,
    idempotency,
    env,
    approvalRepository,
  );
  const approvals = new ApprovalService(
    prisma,
    approvalRepository,
    repository,
    projects,
    events,
    access,
    env,
  );
  return {
    prisma,
    env,
    repository,
    projects,
    needs: new NeedService(prisma, repository, events, access, idempotency),
    approvalRepository,
    approvals,
    policies: new PolicyService(
      prisma,
      approvalRepository,
      events,
      access,
      hierarchy as unknown as OrganizationDirectory,
      env,
    ),
    hierarchy,
    execution: new ExecutionService(
      prisma,
      repository,
      projects,
      approvals,
      approvalRepository,
      events,
      access,
      env,
    ),
    progress: new ProgressService(prisma, repository, events, access, env),
    close: () => prisma.onModuleDestroy(),
  };
}

/** A fresh organization id per test, so suites never collide or share rows. */
export function newOrganizationId(): string {
  return `ORG_${ulid()}`;
}

export function newUserId(): string {
  return `USR_${ulid()}`;
}

export function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    requestId: ulid(),
    correlationId: ulid(),
    authType: 'USER',
    roles: [],
    startedAt: Date.now(),
    ...overrides,
  } as RequestContext;
}

/** Runs `fn` as the organization's administrator — the default project role. */
export function asAdmin<T>(organizationId: string, fn: () => T, userId = newUserId()): T {
  return runWithContext(
    context({
      organizationId,
      organizationIds: [organizationId],
      userId,
      roles: ['ORGANIZATION_ADMIN'],
    }),
    fn,
  );
}

export const PROJECT: CreateProjectDto = {
  title: 'Village road resurfacing',
  operationType: 'road',
  scopeOfWork: 'Resurface two kilometres of the main road',
  locationDescription: 'Main road, north entrance',
};

export const SQUARE = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [54.3, 31.8],
      [54.4, 31.8],
      [54.4, 31.9],
      [54.3, 31.9],
      [54.3, 31.8],
    ],
  ],
};

/** A self-intersecting "bow tie": structurally a closed ring, geometrically invalid. */
export const BOW_TIE = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
      [0, 0],
    ],
  ],
};

/**
 * Removes everything the given organizations wrote. Children before parents:
 * every foreign key is `ON DELETE RESTRICT`.
 */
export async function cleanup(prisma: PrismaService, organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  const where = { organizationId: { in: organizationIds } };
  await runUnscoped('integration cleanup removes exactly what the suite wrote', async () => {
    await prisma.client.approval.deleteMany({ where });
    await prisma.client.progressReport.deleteMany({ where });
    await prisma.client.approvalPolicyStep.deleteMany({ where });
    await prisma.client.approvalPolicy.deleteMany({ where });
    await prisma.client.projectNeed.deleteMany({ where });
    await prisma.client.project.deleteMany({ where });
    await prisma.client.idempotencyKey.deleteMany({ where });
    await prisma.client.outboxMessage.deleteMany({ where });
  });
}

/** Every outbox row one organization produced, oldest first. */
export async function outboxFor(prisma: PrismaService, organizationId: string) {
  return runUnscoped('the outbox carries its own tenant column', () =>
    prisma.client.outboxMessage.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { streamSeq: 'asc' }],
    }),
  );
}

/**
 * The broker list, or `undefined` when none is configured — so the Kafka suite
 * skips visibly on a machine without a broker while the database suites run.
 */
export function brokers(): string[] | undefined {
  const list = (process.env.KAFKA_BROKERS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Waits for `predicate` to hold, bounded by wall clock rather than by turns. */
export async function waitFor<T>(
  predicate: () => T | undefined,
  describe: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describe}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Runs `fn` as a user of `organizationId` with the given roles. */
export function asUser<T>(
  organizationId: string,
  roles: string[],
  fn: () => T,
  userId = newUserId(),
): T {
  return runWithContext(
    context({ organizationId, organizationIds: [organizationId], userId, roles }),
    fn,
  );
}

/** Runs `fn` as the union administrator of `organizationId` (a policy author, Q-70 (7)). */
export function asSetter<T>(organizationId: string, fn: () => T): T {
  return asUser(organizationId, ['UNION_ADMIN'], fn);
}

/** The platform organization the suites' SYSTEM_ADMIN acts for. */
export const PLATFORM_ORG = 'ORG-ITEST-PLATFORM';

/** Runs `fn` as a platform administrator — a different person each call unless `userId` is given. */
export function asPlatform<T>(fn: () => T, userId = newUserId()): T {
  return asUser(PLATFORM_ORG, ['SYSTEM_ADMIN'], fn, userId);
}

/**
 * organization-service's hierarchy, as these suites need it: an organization
 * is within itself and within every ancestor registered with `adopt`. The
 * contract this stands in for is proven twice over — against the real
 * organization-service (`construction-hierarchy-contract.int-spec.ts` there)
 * and, for the HTTP client, in `organization-directory.int-spec.ts` here.
 * `unavailable` makes every answer fail as an unreachable service would.
 */
export class FakeHierarchy {
  private readonly parents = new Map<string, string>();
  unavailable = false;
  timedOut = false;
  readonly asked: [string, string][] = [];

  adopt(parent: string, child: string): void {
    this.parents.set(child, parent);
  }

  /** The organization moved out from under its parent (organization-service's MOVE). */
  disown(child: string): void {
    this.parents.delete(child);
  }

  async isWithin(scope: string, organizationId: string): Promise<boolean> {
    this.asked.push([scope, organizationId]);
    if (this.unavailable) throw RastaError.upstreamUnavailable('organization-service');
    if (this.timedOut) throw RastaError.upstreamTimeout('organization-service', 3000);
    for (
      let current: string | undefined = organizationId;
      current;
      current = this.parents.get(current)
    ) {
      if (current === scope) return true;
    }
    return false;
  }
}

export interface StepSpec {
  authorityOrganizationId: string;
  authorityRole?: string;
  minAmountMinor?: string;
  maxAmountMinor?: string;
  approvalType?: string;
}

/**
 * Puts a policy in force for `organizationId` the decided way (Q-70 (7)): its
 * union administrator writes and submits it, a different platform
 * administrator approves it. Returns its id.
 */
export async function activePolicy(
  w: Wiring,
  organizationId: string,
  steps: StepSpec[],
  workflowKey: 'project.execution' | 'project.completion' = 'project.execution',
): Promise<string> {
  const policy = await asSetter(organizationId, () =>
    w.policies.create({
      organizationId,
      workflowKey,
      label: `Policy for ${workflowKey}`,
      rationale: 'Written by the integration suite to exercise the round',
      isSample: true,
      steps: steps.map((step, index) => ({
        approvalType: step.approvalType ?? `Approval ${index + 1}`,
        authorityOrganizationId: step.authorityOrganizationId,
        authorityRole: (step.authorityRole ?? 'ORGANIZATION_ADMIN') as 'ORGANIZATION_ADMIN',
        authorityLabel: `Authority ${index + 1}`,
        ...(step.minAmountMinor ? { minAmountMinor: step.minAmountMinor } : {}),
        ...(step.maxAmountMinor ? { maxAmountMinor: step.maxAmountMinor } : {}),
      })),
    }),
  );
  await asSetter(organizationId, () => w.policies.submit(policy.id, { expectedVersion: 1 }));
  await asPlatform(() => w.policies.approve(policy.id, { expectedVersion: 2 }));
  return policy.id;
}

/**
 * A project ready to request approval: an estimate and one submitted need.
 * Returns the project id and its current version.
 */
export async function readyProject(
  w: Wiring,
  organizationId: string,
  estimatedCostMinor = '1000000',
): Promise<{ id: string; version: number }> {
  const project = await asAdmin(organizationId, () =>
    w.projects.create({ ...PROJECT, estimatedCostMinor }),
  );
  const need = await asAdmin(organizationId, () =>
    w.needs.add(project.id, { title: 'Gravel', description: 'Base course' }),
  );
  await asAdmin(organizationId, () => w.needs.submit(project.id, need.id, { expectedVersion: 1 }));
  return { id: project.id, version: project.version };
}

/** The approvals of a project, read as its own administrator. */
export async function approvalsOf(w: Wiring, organizationId: string, projectId: string) {
  return asAdmin(organizationId, () => w.approvals.listForProject(projectId, {}));
}
