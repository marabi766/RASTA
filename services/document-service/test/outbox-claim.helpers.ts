import { PrismaService } from '../src/prisma/prisma.service';
import { databaseUrl } from './helpers';

/**
 * An isolated `outbox_message` for the ADR-050 protocol suite.
 *
 * Its own schema, for a reason the suite depends on: `claimPending` is
 * deliberately unscoped — it serves every organization, so a tenant filter
 * there would strand another tenant's events — and it returns the **oldest**
 * rows in the table. Against the shared `public` schema, "two claimers get
 * disjoint batches" or "exactly `limit` rows come back" would be assertions
 * about what every other suite happens to have left behind, not about the
 * protocol. AGENTS.md § 5 forbids exactly that dependency.
 *
 * The table is created with `LIKE public.outbox_message INCLUDING ALL`, so it
 * carries the real column types, defaults, the five CHECK constraints and the
 * three partial indexes — whatever the migration actually produced, rather
 * than a hand-copied approximation that could drift from it.
 */
export const PROTOCOL_SCHEMA = 'outbox_claim_protocol_test';

function schemaUrl(schema: string): string {
  const url = new URL(databaseUrl());
  url.searchParams.set('schema', schema);
  return url.toString();
}

/** A connection to the isolated schema. Each one is an independent "replica". */
export function newProtocolPrisma(): PrismaService {
  return new PrismaService(schemaUrl(PROTOCOL_SCHEMA));
}

/**
 * Creates the isolated schema and table.
 *
 * Run against `public`, because the schema it creates does not exist yet.
 */
export async function createProtocolSchema(): Promise<void> {
  const admin = new PrismaService(databaseUrl());
  try {
    await admin.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PROTOCOL_SCHEMA}" CASCADE`);
    await admin.client.$executeRawUnsafe(`CREATE SCHEMA "${PROTOCOL_SCHEMA}"`);
    await admin.client.$executeRawUnsafe(
      `CREATE TABLE "${PROTOCOL_SCHEMA}".outbox_message
         (LIKE public.outbox_message INCLUDING ALL)`,
    );
  } finally {
    await admin.onModuleDestroy();
  }
}

export async function dropProtocolSchema(): Promise<void> {
  const admin = new PrismaService(databaseUrl());
  try {
    await admin.client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PROTOCOL_SCHEMA}" CASCADE`);
  } finally {
    await admin.onModuleDestroy();
  }
}

export interface SeedOptions {
  organizationId?: string;
  /** Forces `created_at`, so ties and ordering can be constructed on purpose. */
  createdAt?: Date;
  attempts?: number;
}

/**
 * Inserts one unpublished row.
 *
 * Written with raw SQL rather than the Prisma model so the suite can set
 * `created_at` exactly — the tie-break test needs several rows sharing a
 * millisecond, which `@default(now())` cannot produce on demand.
 */
export async function seedRow(
  prisma: PrismaService,
  id: string,
  options: SeedOptions = {},
): Promise<string> {
  await prisma.client.$executeRawUnsafe(
    `INSERT INTO outbox_message
       (id, aggregate_type, aggregate_id, event_name, event_version, topic,
        partition_key, payload, headers, organization_id, correlation_id,
        created_at, attempts, claim_count)
     VALUES ($1, 'Probe', $1, 'PROBE', 1, 't.probe', $1,
             '{}'::jsonb, '{}'::jsonb, $2, $3, $4, $5, 0)`,
    id,
    options.organizationId ?? 'ORG-PROTOCOL',
    `COR-${id}`,
    options.createdAt ?? new Date(),
    options.attempts ?? 0,
  );
  return id;
}

/** Everything the suite needs to see about a row, without a Prisma model round-trip. */
export interface RowState {
  id: string;
  published_at: Date | null;
  claim_token: string | null;
  claim_owner: string | null;
  claim_expires_at: Date | null;
  claim_count: number;
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
}

export async function readRow(prisma: PrismaService, id: string): Promise<RowState> {
  const rows = await prisma.client.$queryRawUnsafe<RowState[]>(
    `SELECT id, published_at, claim_token, claim_owner, claim_expires_at,
            claim_count, attempts, next_attempt_at, last_error
       FROM outbox_message WHERE id = $1`,
    id,
  );
  const row = rows[0];
  if (!row) throw new Error(`no outbox row ${id}`);
  return row;
}

export async function truncate(prisma: PrismaService): Promise<void> {
  await prisma.client.$executeRawUnsafe(`TRUNCATE outbox_message`);
}

/** A publisher whose completion the test controls, for the long-publish cases. */
export class GatedPublisher {
  private release?: () => void;
  private rejectWith?: (error: Error) => void;
  readonly started: Promise<void>;
  private startedResolve!: () => void;
  calls: string[][] = [];

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.startedResolve = resolve;
    });
  }

  publish = async (rows: readonly { id: string }[]): Promise<void> => {
    this.calls.push(rows.map((row) => row.id));
    this.startedResolve();
    await new Promise<void>((resolve, reject) => {
      this.release = resolve;
      this.rejectWith = reject;
    });
  };

  finish(): void {
    this.release?.();
  }

  fail(message: string): void {
    this.rejectWith?.(new Error(message));
  }
}

/** Advances a row's lease into the past without waiting for wall-clock time. */
export async function expireLease(prisma: PrismaService, id: string): Promise<void> {
  await prisma.client.$executeRawUnsafe(
    `UPDATE outbox_message SET claim_expires_at = now() - interval '1 second' WHERE id = $1`,
    id,
  );
}
