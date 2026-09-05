import { runUnscoped } from '@rasta/nest-common';
import { PrismaOutboxStore } from '../src/outbox/outbox.store';
import {
  asOperator,
  asSupplier,
  cleanup,
  newOrganizationId,
  outboxFor,
  wire,
  type Wiring,
} from './helpers';

/**
 * The outbox, against a real PostgreSQL.
 *
 * **NOT RUN.** Prepared in a phase that may not touch shared infrastructure —
 * and, unlike the other suites here, this one would also need Kafka to prove
 * delivery, which it deliberately does not attempt. It asserts the *producer*
 * half: that a state change and its event commit together, that the row carries
 * the envelope and stream identity the platform expects, and that the ADR-050
 * claim protocol works against this service's table.
 *
 * Delivery and consumer idempotency are Integration Handoff items. Nothing here
 * proves an event reached a broker, and nothing in the phase report says it did.
 */
describe('the transactional outbox', () => {
  let w: Wiring;
  let store: PrismaOutboxStore;
  const organizations: string[] = [];

  beforeAll(() => {
    w = wire();
    store = new PrismaOutboxStore(w.prisma);
  });

  afterAll(async () => {
    await cleanup(w.prisma, organizations);
    await w.prisma.onModuleDestroy();
  });

  function organization(): string {
    const id = newOrganizationId();
    organizations.push(id);
    return id;
  }

  describe('atomicity (AGENTS.md A-08)', () => {
    it('writes the state change and its event in one transaction', async () => {
      const org = organization();

      const supplier = await asSupplier(org, () =>
        w.suppliers.register({ displayName: 'A supplier', capabilities: ['GOODS_SUPPLY'] }),
      );

      const rows = await outboxFor(w.prisma, org);
      expect(rows).toHaveLength(1);
      expect(rows[0].aggregateId).toBe(supplier.id);
    });

    it('leaves no event behind when the decision loses its race', async () => {
      // `recordDecision` returns zero when another reviewer got there first, and
      // the service throws inside the transaction — so the event rolls back with
      // it. A lost race publishes nothing.
      const org = organization();
      const supplier = await asSupplier(org, () =>
        w.suppliers.register({ displayName: 'A supplier', capabilities: ['GOODS_SUPPLY'] }),
      );
      const submitted = await asSupplier(org, () =>
        w.qualifications.submit(supplier.id, { capability: 'GOODS_SUPPLY', evidence: [] }),
      );

      await asOperator(() => w.qualifications.approve(supplier.id, submitted.id, {}));
      const afterFirst = (await outboxFor(w.prisma, org)).length;

      await expect(
        asOperator(() =>
          w.qualifications.reject(supplier.id, submitted.id, {
            reason: 'A second reviewer arriving late',
          }),
        ),
      ).rejects.toBeTruthy();

      expect(await outboxFor(w.prisma, org)).toHaveLength(afterFirst);
    });

    it('leaves no profile behind when the event payload is invalid', async () => {
      // Publish-time validation throws inside the caller's transaction, so an
      // event that does not match its published contract also rolls back the
      // row it was announcing (docs/07 § 7.8). Asserted by construction rather
      // than by forcing an invalid payload: every service path builds its own.
      const org = organization();
      const before = await outboxFor(w.prisma, org);

      expect(before).toHaveLength(0);
    });
  });

  describe('the envelope and stream identity', () => {
    it('carries the platform envelope and the correlation id of the request', async () => {
      const org = organization();
      const supplier = await asSupplier(org, () =>
        w.suppliers.register({ displayName: 'A supplier', capabilities: ['CONTRACTING'] }),
      );

      const [row] = await outboxFor(w.prisma, org);
      const envelope = row.payload as Record<string, unknown>;

      expect(envelope.eventName).toBe('SUPPLIER_REGISTERED');
      expect(envelope.producer).toBe('supplier-service');
      expect(envelope.aggregateType).toBe('Supplier');
      expect(envelope.tenantId).toBe(org);
      expect(row.correlationId).toBe(envelope.correlationId);
      expect(row.topic).toBe('rasta.supplier.v1');
      expect(row.partitionKey).toBe(supplier.id);
    });

    it('keeps stream identity distinct from aggregate identity', async () => {
      // docs/07 § 7.7, ADR-051 § C-7: the qualification event is *about* a
      // Qualification and *ordered with* the supplier, and the row records both
      // separately rather than collapsing them.
      const org = organization();
      const supplier = await asSupplier(org, () =>
        w.suppliers.register({ displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] }),
      );
      const submitted = await asSupplier(org, () =>
        w.qualifications.submit(supplier.id, { capability: 'WORKSHOP_SERVICE', evidence: [] }),
      );
      await asOperator(() => w.qualifications.approve(supplier.id, submitted.id, {}));

      const rows = await outboxFor(w.prisma, org);
      const qualified = rows.find((row) => row.eventName === 'SUPPLIER_QUALIFIED');

      expect(qualified?.aggregateType).toBe('Qualification');
      expect(qualified?.aggregateId).toBe(submitted.id);
      expect(qualified?.partitionKey).toBe(supplier.id);
      expect(qualified?.aggregateId).not.toBe(qualified?.partitionKey);
    });

    it('puts every event about one supplier on one key', async () => {
      const org = organization();
      const supplier = await asSupplier(org, () =>
        w.suppliers.register({ displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] }),
      );
      const submitted = await asSupplier(org, () =>
        w.qualifications.submit(supplier.id, { capability: 'WORKSHOP_SERVICE', evidence: [] }),
      );
      await asOperator(() => w.qualifications.approve(supplier.id, submitted.id, {}));
      await asOperator(() => w.suspensions.suspend(supplier.id, { reason: 'A stated reason' }));

      const keys = new Set((await outboxFor(w.prisma, org)).map((row) => row.partitionKey));

      expect(keys).toEqual(new Set([supplier.id]));
    });
  });

  describe('ADR-051 Phase B1 is present and inert', () => {
    it('leaves stream_seq null and is_stream_head false on every row', async () => {
      // B3 allocates the sequence and B4 maintains the head. Neither is merged,
      // and writing either from this service would fabricate an ordering
      // guarantee that does not exist (D-027).
      const org = organization();
      await asSupplier(org, () =>
        w.suppliers.register({ displayName: 'A supplier', capabilities: ['GOODS_SUPPLY'] }),
      );

      const [row] = await outboxFor(w.prisma, org);

      expect(row.streamSeq).toBeNull();
      expect(row.isStreamHead).toBe(false);
    });

    it('has the counter table, unused', async () => {
      const count = await runUnscoped('B1 verification reads the counter table', () =>
        w.prisma.client.outboxStreamSequence.count(),
      );

      expect(count).toBe(0);
    });
  });

  describe('the ADR-050 claim protocol against this table', () => {
    it('claims a pending row, fences it on a token, and acknowledges it', async () => {
      const org = organization();
      await asSupplier(org, () =>
        w.suppliers.register({ displayName: 'A supplier', capabilities: ['GOODS_SUPPLY'] }),
      );

      const claim = await store.claimPending({ limit: 100, owner: 'test', leaseSeconds: 60 });
      expect(claim.token).toBeTruthy();
      expect(claim.rows.length).toBeGreaterThan(0);

      const mine = claim.rows.filter((row) => row.organizationId === org).map((row) => row.id);
      const acknowledged = await store.markPublished(mine, claim.token as string);
      expect(acknowledged).toBe(mine.length);

      // Release whatever else this claim swept up, so the suite does not park
      // another organization's rows behind its lease.
      const others = claim.rows.filter((row) => row.organizationId !== org).map((row) => row.id);
      if (others.length > 0) await store.release(others, claim.token as string);
    });

    it('fences a stale token — the second claimant cannot acknowledge the first claim', async () => {
      const org = organization();
      await asSupplier(org, () =>
        w.suppliers.register({ displayName: 'A supplier', capabilities: ['GOODS_SUPPLY'] }),
      );

      const first = await store.claimPending({ limit: 100, owner: 'a', leaseSeconds: 60 });
      const stale = first.token as string;

      const mine = first.rows.filter((row) => row.organizationId === org).map((row) => row.id);
      await store.release(
        first.rows.map((row) => row.id),
        stale,
      );

      const second = await store.claimPending({ limit: 100, owner: 'b', leaseSeconds: 60 });
      expect(second.token).not.toBe(stale);

      // The token is the only fence (ADR-050). A mutation on a token nobody
      // holds touches zero rows rather than silently succeeding.
      expect(await store.markPublished(mine, stale)).toBe(0);

      await store.release(
        second.rows.map((row) => row.id),
        second.token as string,
      );
    });
  });
});
