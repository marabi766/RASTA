import { ulid } from 'ulid';
import { PrismaService } from '../src/prisma/prisma.service';
import { id } from './helpers';

/**
 * Rows written straight into the real database, as the runtime role.
 *
 * The read suites are about what a query returns, not about how a row got
 * there — ingestion has its own suites against a real broker. Seeding through
 * Prisma keeps the subject of each test visible in the test, and it still goes
 * through the real table: the real partitions, the real constraints, the real
 * append-only privileges. The runtime role holds `INSERT` and no `DELETE`,
 * which is why cleanup runs as the migrator (`cleanupRun`).
 */

/** Every identifier carries `RUN_TAG`, so `cleanupRun` can find it and nothing else. */
export const orgId = (label: string): string => id(`ORG-${label}`);

export interface SeedOptions {
  organizationId: string | null;
  occurredAt: Date;
  actorId?: string | null;
  actorType?: 'USER' | 'SERVICE' | 'SYSTEM' | 'ANONYMOUS';
  action?: string;
  resourceType?: string;
  resourceId?: string | null;
  outcome?: 'SUCCESS' | 'FAILURE' | 'REFUSED';
  correlationId?: string;
  sourceTopic?: string;
  sourceStreamSeq?: bigint | null;
}

export interface SeededEvent {
  id: string;
  occurredAt: Date;
  organizationId: string | null;
}

/** Writes one audit row and returns the composite identity a read needs. */
export async function seedAuditEvent(
  prisma: PrismaService,
  options: SeedOptions,
): Promise<SeededEvent> {
  const rowId = ulid();
  const correlationId = options.correlationId ?? id('CORR');

  await prisma.client.auditEvent.create({
    data: {
      id: rowId,
      occurredAt: options.occurredAt,
      actorType: options.actorType ?? 'USER',
      actorId: options.actorId === undefined ? id('USR') : options.actorId,
      actorRoles: [],
      organizationId: options.organizationId,
      action: options.action ?? 'asset.decommissioned',
      resourceType: options.resourceType ?? 'Asset',
      resourceId: options.resourceId === undefined ? id('AST') : options.resourceId,
      outcome: options.outcome ?? 'SUCCESS',
      occurrenceCount: 1,
      sourceService: 'asset-service',
      sourceServiceVersion: '1.0.0',
      // Carries the run tag, which is what `cleanupRun` deletes on.
      sourceEventId: id('EVT'),
      sourceEventName: 'ASSET_DECOMMISSIONED',
      sourceTopic: options.sourceTopic ?? 'rasta.asset.v1',
      correlationId,
      sourceStreamSeq: options.sourceStreamSeq ?? null,
    },
  });

  return { id: rowId, occurredAt: options.occurredAt, organizationId: options.organizationId };
}

export interface ProjectedOrganization {
  organizationId: string;
  parentOrganizationId?: string | null;
  status?: string;
  /** `UNKNOWN` is what an organization this service has only *seen* looks like. */
  relationState?: 'UNKNOWN' | 'PROJECTED';
  relationObservedAt?: Date | null;
}

/**
 * Writes one hierarchy projection row.
 *
 * Raw SQL rather than Prisma's `create`, because `relation_state` is a
 * PostgreSQL enum the generated client types as its own union and these suites
 * need to write the *invalid-looking* combinations on purpose — a `PROJECTED`
 * row with no status, an `UNKNOWN` row with a parent — to prove the subtree
 * walk refuses them.
 */
export async function projectOrganization(
  prisma: PrismaService,
  organization: ProjectedOrganization,
): Promise<void> {
  const state = organization.relationState ?? 'PROJECTED';
  const observedAt =
    organization.relationObservedAt === undefined
      ? state === 'PROJECTED'
        ? new Date()
        : null
      : organization.relationObservedAt;

  await prisma.client.$executeRawUnsafe(
    `INSERT INTO organization_ref (
       organization_id, parent_organization_id, status, relation_state, relation_observed_at
     ) VALUES ($1, $2, $3, $4::organization_relation_state, $5)
     ON CONFLICT (organization_id) DO UPDATE
        SET parent_organization_id = EXCLUDED.parent_organization_id,
            status                 = EXCLUDED.status,
            relation_state         = EXCLUDED.relation_state,
            relation_observed_at   = EXCLUDED.relation_observed_at`,
    organization.organizationId,
    organization.parentOrganizationId ?? null,
    organization.status ?? 'ACTIVE',
    state,
    observedAt,
  );
}

/**
 * A fixed window inside one monthly partition.
 *
 * `2026-10` is a real partition — `20260908120000_init_audit` pre-builds
 * eighteen months from `2026-09` — so these suites exercise the pruned path
 * rather than the `DEFAULT` partition. Fixed rather than relative to "now", so
 * a run at a month boundary cannot straddle two partitions, and so a failure is
 * reproducible on a different day.
 */
export const WINDOW_FROM = new Date('2026-10-01T00:00:00.000Z');
export const WINDOW_TO = new Date('2026-10-31T00:00:00.000Z');

/** The mandatory window, as query parameters. Thirty days, inside the ceiling. */
export function queryWindow(): { from: string; to: string } {
  return { from: WINDOW_FROM.toISOString(), to: WINDOW_TO.toISOString() };
}

/** An instant inside the window. `minutes` separates rows deterministically. */
export const at = (minutes: number): Date => new Date(WINDOW_FROM.getTime() + minutes * 60 * 1000);
