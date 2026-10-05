import { withUtcSession } from '@rasta/config';
import {
  RastaError,
  getContext,
  runWithContext,
  runUnscoped,
  type RequestContext,
} from '@rasta/nest-common';
import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { eventEnvelopeSchema } from '@rasta/contracts';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventPublisher } from '../src/events/publisher';
import { ProjectRepository } from '../src/project/project.repository';
import { ProjectService } from '../src/project/project.service';
import { NeedService } from '../src/project/need.service';
import { ProjectAccess } from '../src/access/access';
import { IdempotencyStore } from '../src/shared/idempotency';
import { ApprovalRepository } from '../src/approval/approval.repository';
import type { WorkflowKey } from '../src/approval/approval.state-machine';
import { TenderRepository } from '../src/tender/tender.repository';
import { TenderService } from '../src/tender/tender.service';
import { CriteriaRepository } from '../src/tender/criteria.repository';
import { CriteriaService } from '../src/tender/criteria.service';
import { PublicationRepository } from '../src/tender/publication.repository';
import { PublicationService } from '../src/tender/publication.service';
import { EnvKekProvider } from '../src/tender/sealing/key-provider';
import { ApprovalService } from '../src/approval/approval.service';
import { PolicyService } from '../src/approval/policy.service';
import { PolicySuspensionService } from '../src/approval/policy-suspension.service';
import { PolicyReconciliationRepository } from '../src/approval/policy-reconciliation.repository';
import {
  PolicyReconciliationSweeper,
  type SweeperOptions,
} from '../src/approval/policy-reconciliation.sweeper';
import { OrganizationMovedConsumer } from '../src/events/organization-moved.consumer';
import { SupplierStandingConsumer } from '../src/events/supplier-standing.consumer';
import { BidRepository } from '../src/tender/bid.repository';
import { BidService } from '../src/tender/bid.service';
import { TenderClock } from '../src/tender/tender-clock';
import { TenderOpenRepository } from '../src/tender/tender-open.repository';
import { TenderOpenService } from '../src/tender/tender-open.service';
import { BidAccessAudit } from '../src/tender/bid-access-audit';
import { BidContentReader } from '../src/tender/bid-content-reader';
import { OwnerIdentity } from '../src/tender/owner-identity';
import { OwnBidService } from '../src/tender/own-bid.service';
import { EvaluationRepository } from '../src/tender/evaluation.repository';
import { EvaluationService } from '../src/tender/evaluation.service';
import { AwardRepository } from '../src/tender/award.repository';
import { AwardService } from '../src/tender/award.service';
import { TenderApprovalRepository } from '../src/tender/tender-approval.repository';
import { TenderApprovalAudit } from '../src/tender/tender-approval.audit';
import { TenderApprovalService } from '../src/tender/tender-approval.service';
import { TenderApprovalGate } from '../src/tender/tender-approval.gate';
import type { TenderApprovalRequestView } from '../src/tender/tender-approval.dto';
import type { TenderView } from '../src/tender/dto';
import type { TenderAwardView } from '../src/tender/award.dto';
import { AwardStandingCheckRepository } from '../src/tender/award-standing-check.repository';
import { AwardStandingCheckService } from '../src/tender/award-standing-check.service';
import {
  AwardStandingCheckSweeper,
  type AwardStandingCheckSweeperOptions,
} from '../src/tender/award-standing-check.sweeper';
import type { LiveAnswer, LiveMembership, MembershipSource } from '../src/tender/membership.client';
import type { TenderChain, TenderEvidenceSource } from '../src/tender/tender-evidence.client';
import { genesisReceipt } from '../src/tender/sealing/sealing';
import { TenderCloseRepository } from '../src/tender/tender-close.repository';
import { TenderCloseService } from '../src/tender/tender-close.service';
import {
  TenderCloseSweeper,
  type TenderCloseSweeperOptions,
} from '../src/tender/tender-close.sweeper';
import { decisionInstant } from '../src/shared/clock';
import type { ExtendedPrismaClient } from '../src/prisma/prisma.service';
import { ContractorStandingRepository } from '../src/tender/contractor-standing.repository';
import { StandingBootstrap } from '../src/tender/standing-bootstrap';
import { StandingAuthority } from '../src/tender/standing-authority';
import type {
  StandingOfOrganization,
  StandingOfSource,
  StandingSnapshotPage,
  StandingSnapshotSource,
} from '../src/tender/supplier-snapshot.client';
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
  return withUtcSession(url);
}

/**
 * A key-encryption key minted for this test process only (ADR-066 § 2). Random,
 * never written down: a fixed string assigned to a `KEK` is indistinguishable
 * from a real one to a secret scanner (AGENTS.md S-01).
 */
export const TEST_KEK = randomBytes(32).toString('base64');
export const TEST_KEK_ID = 'itest-1';

/**
 * The owner connection the suites' cleanup alone may use to lift a trigger
 * (`DATABASE_URL_CONSTRUCTION_MIGRATOR`, `rasta_construction_migrator`).
 * **Required, with no fallback** to the runtime URL: since D-045 the runtime
 * role owns nothing and cannot lift a trigger at all, and a suite that fell
 * back would fail for a reason that hides the real one — a missing variable.
 */
export function ownerDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_CONSTRUCTION_MIGRATOR;
  if (!url) {
    throw new Error(
      'DATABASE_URL_CONSTRUCTION_MIGRATOR is not set. The suites lift an integrity trigger only ' +
        'through the owner connection, never the runtime one; see .env.migrator.example (docs/23 D-045).',
    );
  }
  return withUtcSession(url);
}

export function testEnv(overrides: Record<string, string> = {}): ConstructionEnv {
  return loadConstructionEnv({
    ...process.env,
    CONSTRUCTION_TENDER_KEKS: `${TEST_KEK_ID}:${TEST_KEK}`,
    CONSTRUCTION_TENDER_KEK_CURRENT: TEST_KEK_ID,
    // The service's default is the strict awarder rule (Q-93); the suites run with every optional
    // rule off unless one asks (`CONSTRUCTION_COI_RULES`), since their evaluator rows hold a user id only.
    CONSTRUCTION_COI_RULES: '',
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

/** A sweep big enough to drain what one suite queued, and a retry that is quick. */
const TEST_SWEEPER: SweeperOptions = {
  intervalMs: 60_000,
  batchSize: 500,
  leaseSeconds: 120,
  backoffSeconds: 30,
  backoffMaxSeconds: 900,
};

export interface Wiring {
  prisma: PrismaService;
  env: ConstructionEnv;
  repository: ProjectRepository;
  projects: ProjectService;
  needs: NeedService;
  tenderRepository: TenderRepository;
  tenders: TenderService;
  publicationRepository: PublicationRepository;
  /** The provider the wiring publishes with; a test asks it to unwrap what publishing stored. */
  keys: EnvKekProvider;
  publication: PublicationService;
  criteriaRepository: CriteriaRepository;
  criteria: CriteriaService;
  approvalRepository: ApprovalRepository;
  approvals: ApprovalService;
  policies: PolicyService;
  /** The organization hierarchy these suites see instead of organization-service. */
  hierarchy: FakeHierarchy;
  execution: ExecutionService;
  progress: ProgressService;
  /** Q-83: policies follow an ORGANIZATION_MOVED. */
  suspension: PolicySuspensionService;
  reconciliations: PolicyReconciliationRepository;
  /** The sweeper, driven by `runOnce()`; it never ticks in these suites. */
  sweeper: PolicyReconciliationSweeper;
  sweeperWith(overrides?: Partial<SweeperOptions>): PolicyReconciliationSweeper;
  /** The consumer's handler, without a broker: `moves.handle(envelope)`. */
  moves: OrganizationMovedConsumer;
  /** Contractor standing (CON-002 PR 5): the read model and its consumer's handler. */
  standing: ContractorStandingRepository;
  supplierEvents: SupplierStandingConsumer;
  /** CON-002 PR 6: bids, over a clock a test may pin (`clock.fixed`); unpinned it is the database's. */
  bidRepository: BidRepository;
  bids: BidService;
  clock: TestTenderClock;
  /** CON-002 PR 7: closing a tender past its deadline, and the sweeper that does it (driven by `runOnce()`). */
  tenderCloses: TenderCloseRepository;
  tenderClose: TenderCloseService;
  tenderCloseSweeper: TenderCloseSweeper;
  tenderCloseSweeperWith(overrides?: Partial<TenderCloseSweeperOptions>): TenderCloseSweeper;
  /** CON-002 PR 8: opening the bids, over an evidence source a test controls (what audit-service holds). */
  evidence: FakeTenderEvidence;
  /** identity-service as the approval of an opening sees it: who belongs to which organization now. */
  memberships: FakeMemberships;
  tenderOpens: TenderOpenRepository;
  tenderOpen: TenderOpenService;
  /** CON-002 PR 9: evaluating the opened bids, and a contractor reading its own opened bid. */
  evaluation: EvaluationService;
  ownBids: OwnBidService;
  /** CON-002 PR 10, gated by the approval round since PR 11: awarding an evaluated tender. */
  award: AwardService;
  /** CON-002 PR 11: the requests and log of the tender approval gates, and the authority's side of them. */
  tenderApprovalRepository: TenderApprovalRepository;
  tenderApprovals: TenderApprovalService;
  /** The standing check after an award: its rows, and the sweeper that makes it (driven by `runOnce(tenderId)`; it never ticks here). */
  awardChecks: AwardStandingCheckRepository;
  awardCheckService: AwardStandingCheckService;
  awardCheckSweeper: AwardStandingCheckSweeper;
  awardCheckSweeperWith(
    overrides?: Partial<AwardStandingCheckSweeperOptions>,
  ): AwardStandingCheckSweeper;
  close(): Promise<void>;
}

/** The tender clock with an optional pinned instant; the module's provider seam (ADR-065 § 2). */
export class TestTenderClock extends TenderClock {
  fixed: Date | undefined;
  /**
   * A one-shot barrier: the next command to reach its decision — which is after it
   * took the tender lock — reads its instant, then runs this and waits for it before
   * going on. That is the deadline crossing between the decision and the write. The
   * first to arrive consumes it, so a command queued behind the lock is not held by
   * it. Deterministic ordering for the races, with no `sleep`.
   */
  onDecision: (() => Promise<void>) | undefined;

  async decisionInstant(tx: ExtendedPrismaClient): Promise<Date> {
    const at = this.fixed ?? (await decisionInstant(tx));
    const hook = this.onDecision;
    this.onDecision = undefined;
    if (hook) await hook();
    return at;
  }
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
  const tenderRepository = new TenderRepository(prisma);
  const criteriaRepository = new CriteriaRepository(prisma);
  const publicationRepository = new PublicationRepository(prisma);
  const keys = new EnvKekProvider(
    env.CONSTRUCTION_TENDER_KEKS,
    env.CONSTRUCTION_TENDER_KEK_CURRENT,
  );
  const projects = new ProjectService(
    prisma,
    repository,
    events,
    access,
    idempotency,
    env,
    approvalRepository,
    tenderRepository,
  );
  const standing = new ContractorStandingRepository(prisma);
  const bidRepository = new BidRepository(prisma);
  const clock = new TestTenderClock();
  const reconciliations = new PolicyReconciliationRepository(prisma);
  const suspension = new PolicySuspensionService(
    prisma,
    approvalRepository,
    events,
    reconciliations,
  );
  const memberships = new FakeMemberships();
  const identity = new OwnerIdentity(access, memberships);
  const tenderApprovalRepository = new TenderApprovalRepository(prisma);
  const tenderApprovalAudit = new TenderApprovalAudit(prisma, tenderApprovalRepository, events);
  const tenderApprovals = new TenderApprovalService(
    prisma,
    approvalRepository,
    tenderApprovalRepository,
    tenderApprovalAudit,
    tenderRepository,
    access,
    identity,
    env,
  );
  const approvals = new ApprovalService(
    prisma,
    approvalRepository,
    repository,
    projects,
    events,
    access,
    env,
    hierarchy as unknown as OrganizationDirectory,
    suspension,
    tenderApprovals,
  );
  const gate = new TenderApprovalGate(
    approvals,
    tenderApprovalRepository,
    tenderApprovalAudit,
    tenderApprovals,
  );
  /** A sweeper over this wiring's hierarchy; `sweeperWith` for other options. */
  const sweeperWith = (overrides: Partial<SweeperOptions> = {}) =>
    new PolicyReconciliationSweeper(
      reconciliations,
      suspension,
      hierarchy as unknown as OrganizationDirectory,
      { ...TEST_SWEEPER, ...overrides },
    );
  const tenderCloses = new TenderCloseRepository(prisma);
  const bidAudit = new BidAccessAudit(bidRepository, events);
  const evidence = new FakeTenderEvidence(prisma);
  const tenderOpens = new TenderOpenRepository(prisma);
  const reader = new BidContentReader(evidence, keys);
  const tenderClose = new TenderCloseService(prisma, tenderCloses, events, clock);
  const tenderCloseSweeperWith = (overrides: Partial<TenderCloseSweeperOptions> = {}) =>
    new TenderCloseSweeper(tenderCloses, tenderClose, {
      intervalMs: 60_000,
      batchSize: 500,
      leaseSeconds: 60,
      retryBackoffBaseSeconds: 10,
      retryBackoffMaxSeconds: 900,
      ...overrides,
    });
  const awardChecks = new AwardStandingCheckRepository(prisma);
  const awardCheckService = new AwardStandingCheckService(
    prisma,
    awardChecks,
    events,
    new StandingAuthority(SUPPLIER),
  );
  const awardCheckSweeperWith = (overrides: Partial<AwardStandingCheckSweeperOptions> = {}) =>
    new AwardStandingCheckSweeper(awardChecks, awardCheckService, {
      intervalMs: 60_000,
      batchSize: 50,
      leaseSeconds: 60,
      retryBackoffBaseSeconds: 30,
      retryBackoffMaxSeconds: 900,
      ...overrides,
    });
  return {
    prisma,
    env,
    repository,
    projects,
    awardChecks,
    awardCheckService,
    awardCheckSweeper: awardCheckSweeperWith(),
    awardCheckSweeperWith,
    evidence,
    memberships,
    tenderOpens,
    tenderOpen: new TenderOpenService(
      prisma,
      tenderOpens,
      bidAudit,
      events,
      access,
      env,
      clock,
      reader,
      identity,
      memberships,
    ),
    evaluation: new EvaluationService(
      prisma,
      new EvaluationRepository(),
      tenderOpens,
      bidAudit,
      events,
      access,
      identity,
      new StandingAuthority(SUPPLIER),
      clock,
      env,
    ),
    ownBids: new OwnBidService(prisma, bidRepository, reader, bidAudit, access),
    award: new AwardService(
      prisma,
      new EvaluationRepository(),
      new AwardRepository(),
      bidRepository,
      tenderOpens,
      bidAudit,
      events,
      access,
      identity,
      new StandingAuthority(SUPPLIER),
      reader,
      clock,
      env,
      gate,
      tenderApprovalRepository,
    ),
    tenderApprovalRepository,
    tenderApprovals,
    tenderCloses,
    tenderClose,
    tenderCloseSweeper: tenderCloseSweeperWith(),
    tenderCloseSweeperWith,
    suspension,
    reconciliations,
    sweeper: sweeperWith(),
    sweeperWith,
    moves: new OrganizationMovedConsumer(
      () => {
        throw new Error('the integration suites call handle() and never subscribe');
      },
      suspension,
      { info: () => undefined, warn: () => undefined, debug: () => undefined },
    ),
    standing,
    supplierEvents: new SupplierStandingConsumer(
      () => {
        throw new Error('the integration suites call handle() and never subscribe');
      },
      standing,
      { info: () => undefined, warn: () => undefined, debug: () => undefined },
    ),
    bidRepository,
    clock,
    bids: new BidService(
      prisma,
      bidRepository,
      new StandingAuthority(SUPPLIER),
      events,
      access,
      clock,
    ),
    needs: new NeedService(prisma, repository, events, access, idempotency),
    tenderRepository,
    tenders: new TenderService(
      prisma,
      tenderRepository,
      repository,
      events,
      access,
      idempotency,
      gate,
      tenderApprovalRepository,
    ),
    publicationRepository,
    keys,
    publication: new PublicationService(
      prisma,
      tenderRepository,
      criteriaRepository,
      publicationRepository,
      events,
      access,
      env,
      keys,
      hierarchy as unknown as OrganizationDirectory,
      gate,
      tenderApprovalRepository,
    ),
    criteriaRepository,
    criteria: new CriteriaService(
      prisma,
      criteriaRepository,
      tenderRepository,
      events,
      access,
      idempotency,
    ),
    approvalRepository,
    approvals,
    policies: new PolicyService(
      prisma,
      approvalRepository,
      events,
      access,
      hierarchy as unknown as OrganizationDirectory,
      env,
      idempotency,
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
    progress: new ProgressService(prisma, repository, events, access, env, idempotency),
    close: () => prisma.onModuleDestroy(),
  };
}

/** The announced receipt of one bid revision, as BID_SUBMITTED / BID_REVISED carry it. */
interface AnnouncedLink {
  tenderId: string;
  bidId: string;
  revision: number;
  receivedAt: string;
  ciphertextSha256: string;
  contentCommitment: string;
  previousReceipt: string;
  receipt: string;
}

/**
 * What audit-service holds, built the way it builds it: from the receipts the events
 * announced, linked from the genesis by `previousReceipt` (not "the last one written"),
 * under the organization that owns the tender. Never from this service's `bid_receipt`.
 */
export async function chainFromEvents(
  prisma: PrismaService,
  organizationId: string,
  tenderId: string,
): Promise<TenderChain> {
  const announced = (await outboxFor(prisma, organizationId))
    .filter((row) => ['BID_SUBMITTED', 'BID_REVISED'].includes(row.eventName))
    .map((row) => eventEnvelopeSchema.parse(row.payload).payload as AnnouncedLink)
    .filter((payload) => payload.tenderId === tenderId);
  const genesis = genesisReceipt(tenderId);
  const links: TenderChain['links'] = [];
  let previous = genesis;
  for (let found = announced.find((p) => p.previousReceipt === previous); found;) {
    links.push({
      seq: links.length + 1,
      bidId: found.bidId,
      revision: found.revision,
      receivedAt: found.receivedAt,
      ciphertextSha256: found.ciphertextSha256,
      contentCommitment: found.contentCommitment,
      previousReceipt: found.previousReceipt,
      receipt: found.receipt,
    });
    previous = found.receipt;
    found = announced.find((p) => p.previousReceipt === previous);
  }
  return { tenderId, genesis, head: previous, links };
}

/**
 * audit-service as the opening of bids sees it: by default the chain the events
 * announced under the asked organization; a test can make it fail, or serve another
 * chain, per tender.
 */
export class FakeTenderEvidence implements TenderEvidenceSource {
  /** Makes every read fail, as an unreachable audit-service would. */
  failure: Error | undefined;
  /** A chain to serve for a tender instead of the announced one (a lag, a forgery). */
  readonly served = new Map<string, TenderChain>();
  readonly asked: { organizationId: string; tenderId: string }[] = [];
  /** Runs once, right after the next read answered: what happens between the read and the lock. */
  afterRead: (() => Promise<void>) | undefined;

  constructor(private readonly prisma: PrismaService) {}

  async fetchChain(organizationId: string, tenderId: string): Promise<TenderChain> {
    this.asked.push({ organizationId, tenderId });
    if (this.failure) throw this.failure;
    const chain =
      this.served.get(tenderId) ?? (await chainFromEvents(this.prisma, organizationId, tenderId));
    const hook = this.afterRead;
    this.afterRead = undefined;
    if (hook) await hook();
    return chain;
  }
}

/**
 * identity-service as the approval of an opening sees it: by default nobody belongs to
 * anything (the token's own organizations are checked besides); a test sets who belongs
 * where now, or makes the read fail.
 */
export class FakeMemberships implements MembershipSource {
  failure: Error | undefined;
  /** Extra organizations a user belongs to now (each with the owner role set), besides the one they act for. */
  readonly of = new Map<string, readonly string[]>();
  readonly asked: string[] = [];
  /**
   * By default identity-service agrees with the request: the caller belongs to the
   * organization they act for, with the roles of their token. These say otherwise.
   */
  readonly revoked = new Set<string>();
  readonly rolesOf = new Map<string, readonly string[]>();
  /** Who held a membership where over the interval after an opening; absent = as `of`. */
  readonly since = new Map<string, readonly string[]>();
  readonly askedSince: { userId: string; from: Date }[] = [];
  /** identity-service's clock as it answers the interval query; absent = now. */
  intervalAsOf: Date | undefined;

  /** Runs once, before identity-service answers for that user: something happens in the race. */
  readonly beforeAnswer = new Map<string, () => Promise<void>>();

  /** identity-service's clock as it answers a live read; absent = now. */
  liveAsOf: Date | undefined;
  /**
   * Memberships by the instants they held, answered over the interval after an opening
   * honestly: one that ended before `from` is not in the answer.
   */
  readonly history = new Map<string, { organizationId: string; start: Date; end: Date | null }[]>();

  async fetchMemberships(userId: string): Promise<LiveAnswer> {
    this.asked.push(userId);
    if (this.failure) throw this.failure;
    const hook = this.beforeAnswer.get(userId);
    if (hook) {
      this.beforeAnswer.delete(userId);
      await hook();
    }
    const byOrganization = new Map<string, LiveMembership>();
    for (const organizationId of this.of.get(userId) ?? []) {
      byOrganization.set(organizationId, { organizationId, roles: ['ORGANIZATION_ADMIN'] });
    }
    const request = currentRequest();
    if (request?.userId === userId && request.organizationId && !this.revoked.has(userId)) {
      byOrganization.set(request.organizationId, {
        organizationId: request.organizationId,
        roles: this.rolesOf.get(userId) ?? request.roles,
      });
    }
    return { memberships: [...byOrganization.values()], asOf: this.liveAsOf ?? new Date() };
  }

  /** Back to the default: nobody belongs to anything, nothing fails, nothing asked. */
  reset(): void {
    this.failure = undefined;
    this.sinceFailure = undefined;
    this.intervalAsOf = undefined;
    this.liveAsOf = undefined;
    this.history.clear();
    this.of.clear();
    this.revoked.clear();
    this.rolesOf.clear();
    this.beforeAnswer.clear();
    this.since.clear();
    this.asked.length = 0;
    this.askedSince.length = 0;
  }

  /** Fails only the interval read (the check after an opening), leaving the live reads working. */
  sinceFailure: Error | undefined;

  async fetchOrganizationIdsSince(
    userId: string,
    from: Date,
  ): Promise<{ organizationIds: readonly string[]; asOf: Date }> {
    this.askedSince.push({ userId, from });
    if (this.failure ?? this.sinceFailure) throw (this.failure ?? this.sinceFailure)!;
    const asOf = this.intervalAsOf ?? new Date();
    const held = (this.history.get(userId) ?? [])
      .filter((m) => m.start <= asOf && (m.end === null || m.end >= from))
      .map((m) => m.organizationId);
    return {
      organizationIds: [
        ...new Set([...(this.since.get(userId) ?? this.of.get(userId) ?? []), ...held]),
      ],
      asOf,
    };
  }
}

function currentRequest(): RequestContext | undefined {
  try {
    return getContext();
  } catch {
    return undefined;
  }
}

/** A fresh organization id per test, so suites never collide or share rows. */
export function newOrganizationId(): string {
  return `ORG_${ulid()}`;
}

export function newUserId(): string {
  return `USR_${ulid()}`;
}

/** The issuer every test token is verified against (a user token always has one, #188). */
export const TEST_ISSUER = 'http://test.invalid/realms/rasta';

/**
 * A request context as the auth guard leaves it. A user's stable identity (#188) is the
 * issuer and subject: each test user id gets a subject of its own (`sub-<userId>`), so two
 * user ids are two people unless a test says otherwise (`subject` in `overrides`).
 */
export function context(overrides: Partial<RequestContext>): RequestContext {
  const userId = overrides.userId;
  return {
    requestId: ulid(),
    correlationId: ulid(),
    authType: 'USER',
    roles: [],
    startedAt: Date.now(),
    ...(userId !== undefined && (overrides.authType ?? 'USER') === 'USER'
      ? { issuer: TEST_ISSUER, subject: `sub-${userId}`, platformUserId: true }
      : {}),
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
export async function cleanup(_prisma: PrismaService, organizationIds: string[]): Promise<void> {
  if (organizationIds.length === 0) return;
  const where = { organizationId: { in: organizationIds } };
  // The suite's own removal of what it wrote goes through the **owner**
  // connection (the one migrations use), never the runtime `PrismaService` under
  // test: a trigger that protects rows from the service must not be switched off
  // with the service's connection, or the suites would teach the code to do it.
  // The owner client carries no tenant guard, so it needs no `runUnscoped`.
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    // A cancelled or published tender's criteria are frozen, and a criteria
    // template is append-only, for every writer (threat C3), so both are lifted
    // for the length of one transaction — DDL is transactional, so a failure
    // puts them back.
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "tender_criterion" DISABLE TRIGGER "tg_tender_criterion_freeze"',
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE "criteria_template" DISABLE TRIGGER "tg_criteria_template_append_only"',
      );
      await tx.tenderCriterion.deleteMany({ where });
      await tx.criteriaTemplate.deleteMany({ where });
      await tx.$executeRawUnsafe(
        'ALTER TABLE "criteria_template" ENABLE TRIGGER "tg_criteria_template_append_only"',
      );
      await tx.$executeRawUnsafe(
        'ALTER TABLE "tender_criterion" ENABLE TRIGGER "tg_tender_criterion_freeze"',
      );
      // A tender key is never deleted by the service (`tg_tender_key_guard`);
      // a suite's own keys are removed the same way, for one transaction.
      await tx.$executeRawUnsafe('ALTER TABLE "tender_key" DISABLE TRIGGER "tg_tender_key_guard"');
      await tx.tenderKey.deleteMany({ where });
      await tx.$executeRawUnsafe('ALTER TABLE "tender_key" ENABLE TRIGGER "tg_tender_key_guard"');
      // A bid is never deleted, and its receipts, access log and evaluation are append-only.
      const APPEND_ONLY = [
        ['bid', 'tg_bid_guard'],
        ['bid_receipt', 'tg_bid_receipt_append_only'],
        ['bid_access_log', 'tg_bid_access_log_append_only'],
        ['bid_qualification', 'tg_bid_qualification_append_only'],
        ['bid_evaluation', 'tg_bid_evaluation_append_only'],
        ['bid_evaluation_recusal', 'tg_bid_recusal_append_only'],
        ['bid_evaluation_score', 'tg_bid_score_append_only'],
        ['tender_award', 'tg_tender_award_append_only'],
        ['tender_award_standing_check', 'tg_award_standing_check_no_delete'],
        ['tender_approval_log', 'tg_tender_approval_log_append_only'],
        ['tender_approval_request', 'tg_tender_approval_request_guard'],
      ] as const;
      for (const [table, trigger] of APPEND_ONLY) {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
      }
      await tx.tenderApprovalLog.deleteMany({ where });
      await tx.tenderApprovalRequest.deleteMany({ where });
      await tx.tenderAwardStandingCheck.deleteMany({ where });
      await tx.tenderAward.deleteMany({ where });
      await tx.bidEvaluationScore.deleteMany({ where });
      await tx.bidEvaluation.deleteMany({ where });
      await tx.bidEvaluationRecusal.deleteMany({ where });
      await tx.bidQualification.deleteMany({ where });
      await tx.bidAccessLog.deleteMany({ where });
      await tx.bidReceipt.deleteMany({ where });
      await tx.bid.deleteMany({ where });
      for (const [table, trigger] of APPEND_ONLY) {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
      }
    });
    await owner.tenderInvitation.deleteMany({ where });
    await owner.approval.deleteMany({ where });
    await owner.tender.deleteMany({ where });
    await owner.progressReport.deleteMany({ where });
    await owner.policyReconciliationTask.deleteMany({ where });
    await owner.approvalPolicyStep.deleteMany({ where });
    await owner.approvalPolicy.deleteMany({ where });
    await owner.projectNeed.deleteMany({ where });
    await owner.project.deleteMany({ where });
    await owner.idempotencyKey.deleteMany({ where });
    await owner.contractorSuspension.deleteMany({ where });
    await owner.contractorStanding.deleteMany({ where });
    await owner.outboxMessage.deleteMany({ where });
  } finally {
    await owner.$disconnect();
  }
}

/**
 * Every outbox row one organization produced, by `createdAt`.
 *
 * `createdAt` is the instant the producing transaction *started* (`now()`,
 * `src/shared/clock.ts`), taken before it waits for the project lock. For
 * commands that ran one after another that is commit order; for commands that
 * ran concurrently it is not. Use `outboxStream` when the order of two
 * concurrent commands is what is being asserted.
 */
export async function outboxFor(prisma: PrismaService, organizationId: string) {
  return runUnscoped('the outbox carries its own tenant column', () =>
    prisma.client.outboxMessage.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: 'asc' }, { streamSeq: 'asc' }],
    }),
  );
}

/**
 * One project's event stream in stream order — the order the events were
 * allocated, under the project's lock, and so the order they committed in
 * (ADR-051 B3; `EventPublisher`). This is the order a consumer of the topic
 * relies on; wall-clock `createdAt` is not.
 */
export async function outboxStream(
  prisma: PrismaService,
  organizationId: string,
  projectId: string,
) {
  return runUnscoped('the outbox carries its own tenant column', () =>
    prisma.client.outboxMessage.findMany({
      where: { organizationId, partitionKey: projectId },
      orderBy: { streamSeq: 'asc' },
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

/**
 * Waits until some database session is blocked on a lock — proof, not hope, that
 * a command started while another holds a row lock is really queued behind it
 * (Codex, LOW on #162: a gated test released the first command without showing
 * the second was waiting). Bounded by wall clock, not by turns; suites run in
 * band, so a waiting session is the one the test started.
 */
export async function untilASessionWaitsOnALock(
  prisma: PrismaService,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.client.$queryRawUnsafe<{ waiting: bigint }[]>(
      `SELECT count(*) AS waiting
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()`,
    );
    if (Number(rows[0]?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error(`No session was waiting on a lock after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
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

/** Runs `fn` as a contractor of `organizationId` (the bidder side, ADR-066 § 4). */
export function asBidder<T>(organizationId: string, fn: () => T, userId = newUserId()): T {
  return asUser(organizationId, ['CONTRACTOR'], fn, userId);
}

/**
 * supplier-service's own record of who is qualified and suspended, as a bid is decided
 * against it (`StandingAuthority`, ADR-061 § 4). A module-level singleton, shared by
 * every wiring and by the booted application of the API suites (which override the
 * source with it), so `qualify` in a test is what the decision sees. Nothing known
 * about an organization means no approval and no episodes: not qualified.
 */
export class FakeSupplier implements StandingOfSource {
  private readonly approved = new Map<string, string>();
  private readonly episodes = new Map<
    string,
    { suspensionId: string; suspendedAt: string; reinstatedAt: string | null }[]
  >();
  /** Makes every answer fail, as an unreachable supplier-service would. */
  failure: Error | undefined;
  readonly asked: string[] = [];

  approve(organizationId: string, at = new Date(Date.now() - 60_000)): void {
    this.approved.set(organizationId, at.toISOString());
  }

  suspend(organizationId: string, suspensionId: string): void {
    const list = this.episodes.get(organizationId) ?? [];
    list.push({ suspensionId, suspendedAt: new Date().toISOString(), reinstatedAt: null });
    this.episodes.set(organizationId, list);
  }

  reinstate(organizationId: string, suspensionId: string): void {
    for (const episode of this.episodes.get(organizationId) ?? []) {
      if (episode.suspensionId === suspensionId) episode.reinstatedAt = new Date().toISOString();
    }
  }

  async fetchStanding(organizationId: string): Promise<StandingOfOrganization> {
    this.asked.push(organizationId);
    if (this.failure) throw this.failure;
    const answer = {
      organizationId,
      contractingApprovedAt: this.approved.get(organizationId) ?? null,
      suspensions: (this.episodes.get(organizationId) ?? []).map((e) => ({ ...e })),
      asOf: new Date().toISOString(),
    };
    // What happens in supplier-service right after it answered, before the caller commits.
    const hook = this.afterAnswer;
    this.afterAnswer = undefined;
    hook?.();
    return answer;
  }

  /** Runs once, right after the next answer: a change that lands between check and commit. */
  afterAnswer: (() => void) | undefined;
}

export const SUPPLIER = new FakeSupplier();

/** Makes `organizationId` an eligible contractor: approved for CONTRACTING, not suspended. */
export async function qualify(_w: Wiring, organizationId: string): Promise<void> {
  SUPPLIER.approve(organizationId);
}

/**
 * A PUBLISHED tender of a fresh organization that bidders may bid on right now:
 * the window opened an hour ago and closes in two, criteria PRICE and LICENCE, and
 * — when RESTRICTED — `invited` invited. Published through the real approval gate
 * (`publishApproved`: a policy, a request, other people's approval, the command again).
 */
export async function publishedForBids(
  w: Wiring,
  organizationId: string,
  options: { visibility?: 'PUBLIC' | 'RESTRICTED'; invited?: string[] } = {},
): Promise<{ tenderId: string; keyId: string }> {
  const project = await approvedProject(w, organizationId);
  const visibility = options.visibility ?? 'PUBLIC';
  const tender = await asAdmin(organizationId, () =>
    w.tenders.create(project.id, {
      title: 'Road resurfacing',
      scopeOfWork: 'Two kilometres of the main road',
      procurementNature: 'FORMAL_TENDER',
      visibility,
      bidOpeningAt: new Date(Date.now() - 3_600_000).toISOString(),
      bidClosingAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    }),
  );
  const set = await asAdmin(organizationId, () =>
    w.criteria.setCriteria(tender.id, {
      expectedVersion: tender.version,
      criteria: [
        {
          code: 'PRICE',
          label: 'Price',
          weightBp: 6000,
          scoringMethod: 'MANUAL_SCORE',
          maxScore: 100,
        },
        {
          code: 'LICENCE',
          label: 'Licence',
          weightBp: 4000,
          scoringMethod: 'PASS_FAIL',
          maxScore: 1,
        },
      ],
    }),
  );
  for (const invitee of options.invited ?? []) {
    await asAdmin(organizationId, () =>
      w.publication.invite(tender.id, { organizationId: invitee }),
    );
  }
  const published = await asAdmin(organizationId, () =>
    publishApproved(w, tender.id, { expectedVersion: set.version }),
  );
  const key = await asAdmin(
    organizationId,
    async () => await w.prisma.client.tenderKey.findFirst({ where: { tenderId: published.id } }),
  );
  return { tenderId: published.id, keyId: key!.keyId };
}

/** A bid's content, with a price and an answer to the tender's two criteria. */
export const bidContent = (priceMinor = '1250000000') => ({
  priceMinor,
  answers: [
    { criterionCode: 'PRICE', response: 'Fixed price, materials included' },
    { criterionCode: 'LICENCE', response: 'Licence 1234, valid' },
  ],
  note: 'Mobilisation within ten days',
});

/** A snapshot page list for the bootstrap, with a hook between a fetch and the next (a live event arriving). */
export class FakeSnapshot implements StandingSnapshotSource {
  readonly fetched: (string | null)[] = [];
  /** Throws on the n-th fetch (1-based), once. */
  failOnFetch: number | undefined;
  /** Runs after a page is handed out and before it is applied. */
  afterFetch: ((pageIndex: number) => Promise<void>) | undefined;

  constructor(
    private readonly pages: Omit<StandingSnapshotPage, 'nextCursor' | 'hasMore'>[],
    private readonly at = '2026-10-01T09:00:00.000Z',
  ) {}

  async fetchPage(cursor: string | null): Promise<StandingSnapshotPage> {
    this.fetched.push(cursor);
    if (this.failOnFetch === this.fetched.length) {
      this.failOnFetch = undefined;
      throw new Error('supplier-service is unavailable');
    }
    // The cursor is the 1-based index of the last page served: opaque to the caller.
    const index = cursor ? Number(cursor) : 0;
    const page = this.pages[index];
    const hasMore = index + 1 < this.pages.length;
    const result: StandingSnapshotPage = {
      items: page?.items ?? [],
      snapshotAt: page?.snapshotAt ?? this.at,
      hasMore,
      nextCursor: hasMore ? String(index + 1) : null,
    };
    // The page is read as it is now; whatever the hook does (a live event, say)
    // happens while it is "in flight", before the caller applies it.
    if (this.afterFetch) await this.afterFetch(index);
    return result;
  }
}

/** Builds the bootstrap over this wiring's database and a snapshot source. */
export function bootstrapOf(w: Wiring, source: StandingSnapshotSource): StandingBootstrap {
  return new StandingBootstrap(
    w.prisma,
    w.standing,
    source,
    { CONSTRUCTION_STANDING_BOOTSTRAP_RETRY_MS: 100 },
    { info: () => undefined, warn: () => undefined },
  );
}

/**
 * Makes the standing "loaded" the way a real start would, from an empty snapshot,
 * unless it already is. The suites that ask about eligibility need it: until the
 * marker exists nobody is eligible (fail closed).
 */
export async function loadStanding(w: Wiring): Promise<void> {
  await bootstrapOf(
    w,
    new FakeSnapshot([{ items: [], snapshotAt: '2026-10-01T09:00:00.000Z' }]),
  ).runOnce();
}

/**
 * Removes the bootstrap marker through the owner connection (the trigger forbids it
 * for everybody else), so a suite can show the state before the standing is loaded.
 */
export async function forgetBootstrap(): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "standing_bootstrap" DISABLE TRIGGER "tg_standing_bootstrap_guard"',
      );
      await tx.standingBootstrap.deleteMany({});
      await tx.$executeRawUnsafe(
        'ALTER TABLE "standing_bootstrap" ENABLE TRIGGER "tg_standing_bootstrap_guard"',
      );
    });
  } finally {
    await owner.$disconnect();
  }
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

  /** Organizations organization-service does not know; every other id exists. */
  readonly missing = new Set<string>();

  async exists(organizationId: string): Promise<boolean> {
    if (this.unavailable) throw RastaError.upstreamUnavailable('organization-service');
    if (this.timedOut) throw RastaError.upstreamTimeout('organization-service', 3000);
    return !this.missing.has(organizationId);
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

/**
 * A `tender.publication` policy in force for `organizationId`, written the decided way (a union administrator
 * writes it, a different platform administrator approves it; one step, decided by the organization's own
 * `ORGANIZATION_ADMIN`). Since PR 11 the module writes them; nothing is put in the table by hand.
 */
export function activatePublicationPolicy(w: Wiring, organizationId: string): Promise<string> {
  return ensureGatePolicy(w, organizationId, 'tender.publication');
}

/** The same for `tender.award`. */
export function activateAwardPolicy(w: Wiring, organizationId: string): Promise<string> {
  return ensureGatePolicy(w, organizationId, 'tender.award');
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
  workflowKey: WorkflowKey = 'project.execution',
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

/**
 * A project that reached APPROVED the decided way: a policy in force naming its
 * own administrator as the one authority, a request, and that authority's grant.
 * Returns the project's id and current version.
 */
export async function approvedProject(
  w: Wiring,
  organizationId: string,
): Promise<{ id: string; version: number }> {
  await activePolicy(w, organizationId, [{ authorityOrganizationId: organizationId }]);
  const project = await readyProject(w, organizationId);
  await asAdmin(organizationId, () =>
    w.approvals.request(project.id, { expectedVersion: project.version }),
  );
  const [step] = await approvalsOf(w, organizationId, project.id);
  await asAdmin(organizationId, () =>
    w.approvals.decide(step!.id, { expectedVersion: 1, decision: 'GRANT' }),
  );
  const approved = await asAdmin(organizationId, () => w.projects.get(project.id));
  return { id: approved.id, version: approved.version };
}

/** The approvals of a project, read as its own administrator. */
export async function approvalsOf(w: Wiring, organizationId: string, projectId: string) {
  return asAdmin(organizationId, () => w.approvals.listForProject(projectId, {}));
}

/**
 * A tender in EVALUATING (CON-002 PR 9): published with the criteria PRICE (6000 bp, MANUAL_SCORE,
 * 0..100) and LICENCE (4000 bp, PASS_FAIL), `count` qualified contractors each with one bid, the
 * deadline passed, closed, and opened by its owner — which needs a wiring with four-eyes off
 * (`CONSTRUCTION_TENDER_OPEN_FOUR_EYES=false`, development and test only). The organizations are
 * recorded in `organizations` for the suite's cleanup.
 */
export async function evaluatingTender(
  w: Wiring,
  organizations: string[],
  count = 2,
  /** The price bid `i` seals, in minor units; by default `1000 + i`. */
  prices: readonly string[] = [],
): Promise<{
  owner: string;
  tenderId: string;
  bids: { bidder: string; bidId: string }[];
}> {
  const owner = newOrganizationId();
  organizations.push(owner);
  const { tenderId } = await publishedForBids(w, owner);
  const bids: { bidder: string; bidId: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const bidder = newOrganizationId();
    organizations.push(bidder);
    await qualify(w, bidder);
    const view = await asBidder(bidder, () =>
      w.bids.submit(tenderId, { content: bidContent(prices[i] ?? String(1_000 + i)) }),
    );
    bids.push({ bidder, bidId: view.bidId });
  }
  await runUnscoped('the suite lets the deadline pass', () =>
    w.prisma.client.$executeRawUnsafe(
      `UPDATE "tender" SET "bid_opening_at" = now() - interval '2 hours',
         "bid_closing_at" = now() - interval '1 minute' WHERE "id" = '${tenderId}'`,
    ),
  );
  await w.tenderClose.close({ organizationId: owner, tenderId });
  await asAdmin(owner, () => w.tenderOpen.open(tenderId));
  return { owner, tenderId, bids };
}

/**
 * Runs statements on a standing check as the OWNER, with the check's guard lifted for the length of
 * one transaction: how a suite lets a backoff or a lease lapse without waiting for the clock. The
 * guard exists to refuse exactly this from the runtime role (D-045: the owner connection is the
 * migrations', never the service's); every other suite goes through the runtime role.
 */
export async function ownerSql(statements: string[]): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    await owner.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "tender_award_standing_check" DISABLE TRIGGER "tg_award_standing_check_guard"',
      );
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
      await tx.$executeRawUnsafe(
        'ALTER TABLE "tender_award_standing_check" ENABLE TRIGGER "tg_award_standing_check_guard"',
      );
    });
  } finally {
    await owner.$disconnect();
  }
}

/**
 * A tender in EVALUATED (CON-002 PR 10): `evaluatingTender`, then every bid qualified and scored in
 * full by one evaluator, who also completes the evaluation. Bid `i` scores `9000 - 1000 × i` on
 * PRICE (and full marks on LICENCE), so the bids rank 1, 2, 3 … in the order returned — or, with
 * `tie`, all score alike and share the first rank. The tender is the owner's; the bidders each
 * hold a standing in supplier-service's fake. Needs a wiring with four-eyes off, as
 * `evaluatingTender` does.
 */
export async function evaluatedTender(
  w: Wiring,
  organizations: string[],
  options: { count?: number; tie?: boolean; prices?: readonly string[] } = {},
): Promise<{
  owner: string;
  tenderId: string;
  /** The one person who decided on every bid, scored it, and completed the evaluation. */
  evaluator: string;
  bids: { bidder: string; bidId: string }[];
}> {
  const { owner, tenderId, bids } = await evaluatingTender(
    w,
    organizations,
    options.count ?? 2,
    options.prices,
  );
  const evaluator = newUserId();
  for (const [index, bid] of bids.entries()) {
    await asAdmin(
      owner,
      () => w.evaluation.qualify(tenderId, bid.bidId, { decision: 'QUALIFIED' }),
      evaluator,
    );
    await asAdmin(
      owner,
      () =>
        w.evaluation.score(tenderId, bid.bidId, {
          scores: [
            { criterionCode: 'PRICE', scoreScaled: options.tie ? 8_000 : 9_000 - index * 1_000 },
            { criterionCode: 'LICENCE', scoreScaled: 100 },
          ],
        }),
      evaluator,
    );
  }
  await asAdmin(owner, () => w.evaluation.evaluate(tenderId), evaluator);
  return { owner, tenderId, evaluator, bids };
}

// ---------------------------------------------------------------------------
// CON-002 PR 11: the approval gates, driven the real way
// ---------------------------------------------------------------------------

export type GateKey = 'tender.publication' | 'tender.award' | 'tender.cancellation';

/** The organization the request being served acts for (the suites' own context). */
function actingOrganization(): string {
  const organizationId = currentRequest()?.organizationId;
  if (!organizationId) throw new Error('a gated command is driven inside a request context');
  return organizationId;
}

/**
 * Puts a policy in force for the gate unless one is, the decided way (Q-70 (7): a union administrator writes
 * and submits it, a different platform administrator approves it): one step, whose authority is the
 * organization itself with `ORGANIZATION_ADMIN` — decided by a person other than the requester. Returns its id.
 */
export async function ensureGatePolicy(
  w: Wiring,
  organizationId: string,
  key: GateKey,
  steps: StepSpec[] = [{ authorityOrganizationId: organizationId }],
): Promise<string> {
  const current = await runUnscoped('the suite looks for the gate policy in force', async () =>
    w.prisma.client.approvalPolicy.findFirst({
      where: { organizationId, workflowKey: key, status: 'ACTIVE' },
    }),
  );
  if (current) return current.id;
  return activePolicy(w, organizationId, steps, key);
}

/** Runs `fn` as a person of the authority a policy step names: a different one each call unless `userId` is given. */
export function asApprover<T>(
  authorityOrganizationId: string,
  fn: () => T,
  userId = newUserId(),
  role = 'ORGANIZATION_ADMIN',
): T {
  // Under the issuer of the request being served: a person of another issuer cannot be told from the
  // requester (UNKNOWN, fail closed), so a suite that gives its requester an issuer gives its approvers it too.
  const issuer = (currentRequest() as { issuer?: string } | undefined)?.issuer;
  return runWithContext(
    context({
      organizationId: authorityOrganizationId,
      organizationIds: [authorityOrganizationId],
      userId,
      roles: [role],
      ...(issuer ? { issuer } : {}),
    } as Partial<RequestContext>),
    fn,
  );
}

/** Grants every step of a request in order, each as a different person of the authority the step names. */
export async function grantRequest(
  w: Wiring,
  request: TenderApprovalRequestView,
  by: () => string = newUserId,
): Promise<void> {
  for (const step of request.steps) {
    const fresh = await asApprover(step.authorityOrganizationId, () =>
      w.approvals.get(step.approvalId),
    );
    await asApprover(
      step.authorityOrganizationId,
      () =>
        w.approvals.decide(step.approvalId, { decision: 'GRANT', expectedVersion: fresh.version }),
      by(),
      step.authorityRole,
    );
  }
}

/**
 * Asks for the publication and has every step granted by other people, in the context being served, and
 * stops there: the request is APPROVED and unused. (A race is then between the commands, not the approval.)
 */
export async function approvePublication(
  w: Wiring,
  tenderId: string,
  dto: { expectedVersion: number },
): Promise<void> {
  await ensureGatePolicy(w, actingOrganization(), 'tender.publication');
  const first = await w.publication.publish(tenderId, dto);
  if (!first.executed) await grantRequest(w, first.request);
}

/**
 * Publishes through the real gate, in the context being served: a policy in force, a request, every step
 * granted by other people, and the same command again. What the suites call where they used the unrouted
 * core before PR 11.
 */
export async function publishApproved(
  w: Wiring,
  tenderId: string,
  dto: { expectedVersion: number },
): Promise<TenderView> {
  await approvePublication(w, tenderId, dto);
  const done = await w.publication.publish(tenderId, dto);
  if (!done.executed) throw new Error('an approved publication was not executed');
  return done.result;
}

/** The same for an award: the awarder asks, other people approve (and the award is not yet made). */
export async function approveAward(
  w: Wiring,
  tenderId: string,
  dto: { bidId: string; justification?: string },
): Promise<void> {
  await ensureGatePolicy(w, actingOrganization(), 'tender.award');
  const first = await w.award.award(tenderId, dto);
  if (!first.executed) await grantRequest(w, first.request);
}

/** The awarder asks, other people approve, the awarder awards. */
export async function awardApproved(
  w: Wiring,
  tenderId: string,
  dto: { bidId: string; justification?: string },
): Promise<TenderAwardView> {
  await approveAward(w, tenderId, dto);
  const done = await w.award.award(tenderId, dto);
  if (!done.executed) throw new Error('an approved award was not executed');
  return done.result;
}

type CancelBody = {
  expectedVersion: number;
  reason: string;
  reasonCode?: 'OWNER_REQUEST' | 'NO_QUALIFIED_BID';
};

/** The same for a cancellation. */
export async function approveCancellation(
  w: Wiring,
  tenderId: string,
  dto: CancelBody,
): Promise<void> {
  await ensureGatePolicy(w, actingOrganization(), 'tender.cancellation');
  const first = await w.tenders.cancel(tenderId, { reasonCode: 'OWNER_REQUEST', ...dto });
  if (!first.executed) await grantRequest(w, first.request);
}

export async function cancelApproved(
  w: Wiring,
  tenderId: string,
  dto: CancelBody,
): Promise<TenderView> {
  await approveCancellation(w, tenderId, dto);
  const done = await w.tenders.cancel(tenderId, { reasonCode: 'OWNER_REQUEST', ...dto });
  if (!done.executed) throw new Error('an approved cancellation was not executed');
  return done.result;
}

/**
 * Lifts, for a suite that moves a tender's status by raw SQL to probe some other guard, the database's rule that a
 * tender becomes PUBLISHED, AWARDED or CANCELLED only by an approved request used in the same transaction
 * (`tg_tender_status_requires_approval`; proven by `tender-approval.int-spec`). On the **owner** connection, like
 * `cleanup`: the service's own connection never switches a trigger off. Put back by `restoreApprovalGuard`.
 */
export async function liftApprovalGuard(): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    await owner.$executeRawUnsafe(
      'ALTER TABLE "tender" DISABLE TRIGGER "tg_tender_status_requires_approval"',
    );
  } finally {
    await owner.$disconnect();
  }
}

export async function restoreApprovalGuard(): Promise<void> {
  const owner = new PrismaClient({ datasources: { db: { url: ownerDatabaseUrl() } } });
  try {
    await owner.$executeRawUnsafe(
      'ALTER TABLE "tender" ENABLE TRIGGER "tg_tender_status_requires_approval"',
    );
  } finally {
    await owner.$disconnect();
  }
}
