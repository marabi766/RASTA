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

  /** The store mints its own token, so the fake database must echo it back. */
  const echoToken = (rows: Record<string, unknown>[]) =>
    queryRaw.mockImplementation((_sql: string, token: string) =>
      Promise.resolve(rows.map((row) => ({ claim_token: token, reclaimed: false, ...row }))),
    );

  const claim = (limit: number) =>
    claiming.claimPending({ limit, owner: 'spec', leaseSeconds: 60 });

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
    echoToken([RAW]);

    expect((await claim(10)).rows).toEqual([
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
    echoToken([{ ...RAW, headers: null }]);

    expect((await claim(10)).rows[0]?.headers).toEqual({});
  });

  it('returns nothing when the backlog is empty', async () => {
    queryRaw.mockResolvedValue([]);

    // No rows means no fence to hold: the token is null rather than a value
    // the relay could mistakenly mutate with.
    expect(await claim(10)).toEqual({ token: null, rows: [], reclaimed: 0 });
  });

  it('asks the database for the oldest unpublished rows, up to the limit', async () => {
    // The clauses that define the window, pinned so none can be dropped: an
    // unpublished filter, an oldest-first ordering, and a bound.
    //
    // `FOR UPDATE SKIP LOCKED` remains in the subquery, but it is no longer
    // asked to reserve anything: its lock ends with this statement. What
    // reserves the row is `claim_token`, written by the same statement that
    // selects it (ADR-050). Both are pinned here so neither can be dropped.
    queryRaw.mockResolvedValue([]);
    await claim(25);

    const [statement, ...values] = queryRaw.mock.calls.at(-1) as [string, ...unknown[]];
    const sql = statement.replace(/\s+/g, ' ');

    expect(sql).toContain('FROM outbox_message');
    expect(sql).toContain('WHERE published_at IS NULL');
    // Eligibility: no live lease, and no retry that is not yet due.
    expect(sql).toContain('claim_expires_at IS NULL OR claim_expires_at <= now()');
    expect(sql).toContain('next_attempt_at IS NULL OR next_attempt_at <= now()');
    // The total order. `created_at` alone leaves same-millisecond ties
    // arbitrary, which is what made claim windows non-deterministic.
    expect(sql).toContain('ORDER BY created_at, id');
    expect(sql).toContain('LIMIT');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    // The fence is written by the claiming statement and returned by it.
    expect(sql).toContain('SET claim_token');
    expect(sql).toContain('RETURNING');

    // Platform plumbing: the relay serves every organization, so the claim is
    // unscoped by design. A tenant filter here would strand another tenant's
    // events unpublished for as long as nobody noticed.
    expect(sql).not.toContain('organization_id =');

    // Every value is bound, never interpolated: token, owner, lease, limit.
    expect(values).toHaveLength(4);
    expect(values[1]).toBe('spec');
    expect(values[2]).toBe(60);
    expect(values[3]).toBe(25);
    // A fresh, unguessable token per attempt — not the process identity.
    expect(values[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
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
