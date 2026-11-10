import { Prisma } from '../src/generated/prisma';
import { PrismaService } from '../src/prisma/prisma.service';
import { ScanRepository } from '../src/scanning/scan.repository';
import { ownerDatabaseUrl } from './helpers';

describe('document claim evaluation boundary', () => {
  let db: PrismaService;
  beforeAll(async () => {
    const url = new URL(ownerDatabaseUrl());
    url.searchParams.set('connection_limit', '1');
    db = new PrismaService(url.toString());
    // A connection-local queue: no fixed fixtures or other run's work can be claimed.
    await db.client.$executeRawUnsafe(`
      CREATE TEMP TABLE document AS SELECT i::text AS id, (i % 2)::text AS organization_id,
        i::text AS object_key, 'application/pdf'::text AS content_type, 10::bigint AS size_bytes,
        'CONTRACT'::text AS document_class, 0 AS scan_attempts, 'PENDING'::text AS scan_state,
        'REGISTERED'::text AS status, NULL::timestamptz AS scan_next_attempt_at,
        NULL::timestamptz AS scan_lease_expires_at, NULL::text AS scan_lease_owner,
        to_timestamp(i) AS scan_queued_at, to_timestamp(i) AS created_at
      FROM generate_series(1, 40) i`);
    await db.client.$executeRawUnsafe('CREATE UNIQUE INDEX ON document(id)');
    await db.client.$executeRawUnsafe('CREATE INDEX ON document(scan_queued_at, created_at)');
    for (const option of [
      'enable_material',
      'enable_hashjoin',
      'enable_mergejoin',
      'enable_hashagg',
      'enable_sort',
      'jit',
    ]) {
      await db.client.$executeRawUnsafe(`SET ${option} = off`);
    }
  });
  afterAll(async () => {
    await db?.stop();
  });

  it('evaluates the real picker once and updates one of 40 rows under a forced nested-loop plan', async () => {
    let captured: Prisma.Sql | undefined;
    const repository = new ScanRepository({
      client: {
        $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
          captured = Prisma.sql(strings, ...values);
          // Execute this exact production statement once below, through EXPLAIN ANALYZE.
          return Promise.resolve([]);
        },
      },
    } as unknown as PrismaService);
    await repository.claim({ owner: 'limit-probe', limit: 1, leaseSeconds: 60 });
    expect(captured).toBeDefined();
    const [result] = await db.client.$queryRawUnsafe<
      { 'QUERY PLAN': { Plan: Record<string, unknown> }[] }[]
    >(`EXPLAIN (ANALYZE, FORMAT JSON) ${captured!.text}`, ...captured!.values);
    const nodes: Record<string, unknown>[] = [];
    const visit = (node: Record<string, unknown>): void => {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
    };
    visit(result!['QUERY PLAN'][0]!.Plan);
    expect(nodes.some((n) => n['Node Type'] === 'Nested Loop')).toBe(true);
    const picker = nodes.find((n) => n['Subplan Name'] === 'CTE due');
    expect(picker).toMatchObject({ 'Node Type': 'Limit', 'Actual Rows': 1, 'Actual Loops': 1 });
    const [count] = await db.client.$queryRaw<{ claimed: number }[]>`
      SELECT count(*)::int AS claimed FROM document WHERE scan_lease_expires_at IS NOT NULL`;
    expect(count?.claimed).toBe(1);
  });
});
