import { PrismaOutboxStore } from './outbox.store';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * The predicate behind `rasta_outbox_pending_total`.
 *
 * This gauge is how an operator learns that events have stopped reaching
 * Kafka, so the two ways it can lie are both serious: counting published rows
 * makes a healthy relay look permanently behind, and a wrong predicate — a
 * `not: null`, a tenant filter, a missing `where` — makes a stalled one look
 * idle. Neither shows up as an error anywhere; the number is simply wrong.
 *
 * An integration test cannot pin this down. `pendingCount()` is deliberately
 * global, so against a shared database its exact value depends on every other
 * suite's rows, and the assertion that used to live there — "the count grew by
 * exactly the two rows I just inserted" — is not a property of the
 * implementation at all. It is a property of nobody else touching the table,
 * which nothing establishes.
 *
 * So the exact query is asserted here, where it is deterministic, and the
 * integration suite asserts what it can genuinely own: its own rows.
 */
/**
 * Column mapping, against a controlled raw row.
 *
 * `claimPending` is raw SQL selecting snake_case columns, and `toOutboxRow`
 * renames every one of them. A slip there — `partition_key` landing nowhere,
 * `headers` arriving as null — publishes an event with a missing field, and
 * the relay does not care: it hands whatever it got to Kafka.
 *
 * This used to be asserted in the integration suite by seeding a row and
 * finding it in `claimPending(100)`. That only worked while the shared
 * database held fewer than a hundred older pending rows, because the query
 * deliberately returns the *oldest* hundred — so the assertion depended on the
 * whole platform's outbox being nearly empty (D-025). The mapping does not
 * need a database to be proven, so it is proven here, and the integration
 * suite asserts the window properties that do.
 */
describe('claimPending', () => {
  const queryRaw = jest.fn();
  const claiming = new PrismaOutboxStore({
    client: { $queryRawUnsafe: queryRaw },
  } as unknown as PrismaService);

  /** Every column the query selects, each with a value only it could produce. */
  const RAW = {
    id: 'OBX_MAPPING',
    aggregate_type: 'Document',
    aggregate_id: 'DOC_MAPPING',
    event_name: 'DOCUMENT_UPLOADED',
    event_version: 3,
    topic: 'rasta.document.v1',
    partition_key: 'DOC_MAPPING',
    payload: { documentId: 'DOC_MAPPING' },
    headers: { 'x-correlation-id': 'COR-MAPPING' },
    organization_id: 'ORG-MAPPING',
    correlation_id: 'COR-MAPPING',
    created_at: new Date('2026-01-02T03:04:05.000Z'),
    published_at: null,
    attempts: 2,
    last_error: 'broker refused the write',
  };

  it('maps every selected column onto the field the relay reads', async () => {
    queryRaw.mockResolvedValue([RAW]);

    expect(await claiming.claimPending(10)).toEqual([
      {
        id: 'OBX_MAPPING',
        aggregateType: 'Document',
        aggregateId: 'DOC_MAPPING',
        eventName: 'DOCUMENT_UPLOADED',
        eventVersion: 3,
        topic: 'rasta.document.v1',
        partitionKey: 'DOC_MAPPING',
        payload: { documentId: 'DOC_MAPPING' },
        headers: { 'x-correlation-id': 'COR-MAPPING' },
        organizationId: 'ORG-MAPPING',
        correlationId: 'COR-MAPPING',
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        publishedAt: null,
        attempts: 2,
        lastError: 'broker refused the write',
      },
    ]);
  });

  it('turns absent headers into an empty object rather than null', async () => {
    // The publisher spreads these into the Kafka message headers; null there
    // is a crash at the point of sending, which is the worst place for one.
    queryRaw.mockResolvedValue([{ ...RAW, headers: null }]);

    expect((await claiming.claimPending(10))[0]?.headers).toEqual({});
  });

  it('returns nothing when the backlog is empty', async () => {
    queryRaw.mockResolvedValue([]);

    expect(await claiming.claimPending(10)).toEqual([]);
  });

  it('asks the database for the oldest unpublished rows, up to the limit', async () => {
    // The clauses that define the window, pinned so none can be dropped: an
    // unpublished filter, an oldest-first ordering, and a bound.
    //
    // `FOR UPDATE SKIP LOCKED` is asserted as the SQL that is currently there,
    // and nothing more is claimed for it. Its lock lasts only while the
    // transaction holding it is open, and this SELECT stands alone: by the
    // time `claimPending` returns, the transaction has ended and every lock
    // with it. The relay then publishes to Kafka and calls `markPublished`
    // afterwards, in a separate statement, so between those two points the
    // rows are reserved by nothing.
    //
    // Two relay instances therefore can and do claim the same rows. Measured,
    // not reasoned about: two stores on independent connections, the second
    // claiming after the first returned and before it marked, produced an
    // intersection of 10 rows out of 10 — a complete overlap. What actually
    // excludes a row from a later claim is `published_at`, and only once it is
    // set. Recorded as D-026; a durable claim needs an ADR, not a comment.
    queryRaw.mockResolvedValue([]);
    await claiming.claimPending(25);

    const [statement, ...values] = queryRaw.mock.calls.at(-1) as [string, ...unknown[]];
    const sql = statement.replace(/\s+/g, ' ');

    expect(sql).toContain('FROM outbox_message');
    expect(sql).toContain('WHERE published_at IS NULL');
    expect(sql).toContain('ORDER BY created_at');
    expect(sql).toContain('LIMIT');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');

    // Platform plumbing: the relay serves every organization, so the claim is
    // unscoped by design. A tenant filter here would strand another tenant's
    // events unpublished for as long as nobody noticed.
    expect(sql).not.toContain('organization_id =');

    // The limit is a bound parameter, not interpolated text.
    expect(values).toEqual([25]);
  });
});

describe('pendingCount', () => {
  const count = jest.fn();
  const store = new PrismaOutboxStore({
    client: { outboxMessage: { count } },
  } as unknown as PrismaService);

  it('counts unpublished rows, and only those', () => {
    // `publishedAt: null` is the whole definition of "pending". A row with a
    // timestamp has reached Kafka and must not be counted as outstanding.
    count.mockResolvedValue(0);
    void store.pendingCount();

    expect(count).toHaveBeenCalledWith({ where: { publishedAt: null } });
  });

  it('counts across the whole table, with no tenant filter', () => {
    // Platform plumbing, not tenant data (ADR-006). The relay serves every
    // organization, so a gauge scoped to one would under-report the backlog
    // and hide exactly the outage it exists to reveal. Asserted as an exact
    // argument so a filter cannot be added here without this failing.
    count.mockResolvedValue(0);
    void store.pendingCount();

    const [argument] = count.mock.calls.at(-1) as [{ where: Record<string, unknown> }];
    expect(Object.keys(argument.where)).toEqual(['publishedAt']);
    expect(argument.where).not.toHaveProperty('organizationId');
  });

  it('returns what the database reports', async () => {
    count.mockResolvedValue(7);

    expect(await store.pendingCount()).toBe(7);
  });

  it('reports an empty backlog as zero rather than as nothing', async () => {
    // The gauge is set unconditionally on every tick; a nullish return here
    // would publish `NaN` and the dashboard would go blank rather than green.
    count.mockResolvedValue(0);

    expect(await store.pendingCount()).toBe(0);
  });
});
