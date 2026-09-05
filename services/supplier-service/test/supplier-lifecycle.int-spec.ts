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
 * The whole lifecycle, against a real PostgreSQL.
 *
 * **NOT RUN.** Written in a phase that may not touch shared infrastructure —
 * no `docker compose`, no `pnpm infra:*`, no migration against any database —
 * so this file is prepared and unexecuted. Running it is an Integration Handoff
 * item. Nothing in the phase report claims it passed.
 *
 * What it covers that a unit test cannot: the transactional coupling of a
 * decision and the event announcing it, the conditional updates that decide a
 * race, and the fact that a suspension withholds a qualification without
 * touching the row that recorded it.
 */
describe('supplier lifecycle', () => {
  let w: Wiring;
  const organizations: string[] = [];

  beforeAll(() => {
    w = wire();
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

  it('registers a profile and publishes SUPPLIER_REGISTERED in the same transaction', async () => {
    const org = organization();

    const supplier = await asSupplier(org, () =>
      w.suppliers.register({
        displayName: 'A workshop',
        capabilities: ['WORKSHOP_SERVICE', 'GOODS_SUPPLY'],
      }),
    );

    expect(supplier.organizationId).toBe(org);
    expect(supplier.status).toBe('ACTIVE');
    // Registering grants nothing.
    expect(supplier.qualifiedFor).toEqual([]);
    expect(supplier.capabilities).toEqual(['GOODS_SUPPLY', 'WORKSHOP_SERVICE']);

    const outbox = await outboxFor(w.prisma, org);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].eventName).toBe('SUPPLIER_REGISTERED');
    // Stream identity, not aggregate identity (docs/07 § 7.7).
    expect(outbox[0].partitionKey).toBe(supplier.id);
    expect(outbox[0].publishedAt).toBeNull();
  });

  it('refuses a second profile for the same organization', async () => {
    const org = organization();
    const register = () =>
      asSupplier(org, () =>
        w.suppliers.register({ displayName: 'First', capabilities: ['GOODS_SUPPLY'] }),
      );

    await register();

    // A 409 rather than returning the existing row: quietly handing back
    // somebody else's profile would hide that the second call did nothing.
    await expect(register()).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('carries a submission through approval and publishes SUPPLIER_QUALIFIED', async () => {
    const org = organization();

    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] }),
    );

    const submitted = await asSupplier(org, () =>
      w.qualifications.submit(supplier.id, {
        capability: 'WORKSHOP_SERVICE',
        statement: 'We service heavy machinery',
        evidence: [{ documentId: 'DOC_OPAQUE_1', label: 'Trade licence' }],
      }),
    );

    expect(submitted.state).toBe('SUBMITTED');
    expect(submitted.current).toBe(false);
    // Stored, never resolved. Nothing fetched this document.
    expect(submitted.evidence[0].documentId).toBe('DOC_OPAQUE_1');

    // A submission is not a platform fact: no event.
    expect(await outboxFor(w.prisma, org)).toHaveLength(1);

    const approved = await asOperator(() =>
      w.qualifications.approve(supplier.id, submitted.id, { note: 'Called the referee' }),
    );

    expect(approved.state).toBe('APPROVED');
    expect(approved.current).toBe(true);
    expect(approved.decidedBy).toBeTruthy();
    expect(approved.decidedAt).toBeTruthy();

    const outbox = await outboxFor(w.prisma, org);
    expect(outbox.map((row) => row.eventName)).toEqual([
      'SUPPLIER_REGISTERED',
      'SUPPLIER_QUALIFIED',
    ]);

    // The reviewer's private note stays in the database.
    expect(JSON.stringify(outbox[1].payload)).not.toContain('referee');
    // And so does the evidence identifier.
    expect(JSON.stringify(outbox[1].payload)).not.toContain('DOC_OPAQUE_1');
  });

  it('refuses to decide an already-decided qualification', async () => {
    const org = organization();
    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'A supplier', capabilities: ['GOODS_SUPPLY'] }),
    );
    const submitted = await asSupplier(org, () =>
      w.qualifications.submit(supplier.id, { capability: 'GOODS_SUPPLY', evidence: [] }),
    );

    await asOperator(() =>
      w.qualifications.reject(supplier.id, submitted.id, {
        reason: 'The submission named no evidence at all',
      }),
    );

    // Both end states are terminal: changing a decision means a new submission
    // that leaves the first one standing in the record.
    await expect(
      asOperator(() => w.qualifications.approve(supplier.id, submitted.id, {})),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('refuses a second submission while one is open, and allows one after a rejection', async () => {
    const org = organization();
    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'A supplier', capabilities: ['CONTRACTING'] }),
    );

    const first = await asSupplier(org, () =>
      w.qualifications.submit(supplier.id, { capability: 'CONTRACTING', evidence: [] }),
    );

    await expect(
      asSupplier(org, () =>
        w.qualifications.submit(supplier.id, { capability: 'CONTRACTING', evidence: [] }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

    await asOperator(() =>
      w.qualifications.reject(supplier.id, first.id, { reason: 'Not enough detail supplied' }),
    );

    // Refusal is not a permanent bar.
    await expect(
      asSupplier(org, () =>
        w.qualifications.submit(supplier.id, { capability: 'CONTRACTING', evidence: [] }),
      ),
    ).resolves.toMatchObject({ state: 'SUBMITTED' });
  });

  it('refuses a submission for a capability that is already approved', async () => {
    const org = organization();
    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'A supplier', capabilities: ['GOODS_SUPPLY'] }),
    );
    const submitted = await asSupplier(org, () =>
      w.qualifications.submit(supplier.id, { capability: 'GOODS_SUPPLY', evidence: [] }),
    );
    await asOperator(() => w.qualifications.approve(supplier.id, submitted.id, {}));

    // With no expiry rule, a second approval would mean the platform had
    // invented a renewal cycle.
    await expect(
      asSupplier(org, () =>
        w.qualifications.submit(supplier.id, { capability: 'GOODS_SUPPLY', evidence: [] }),
      ),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('suspends without revoking, and reinstates without a new decision', async () => {
    const org = organization();
    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] }),
    );
    const submitted = await asSupplier(org, () =>
      w.qualifications.submit(supplier.id, { capability: 'WORKSHOP_SERVICE', evidence: [] }),
    );
    await asOperator(() => w.qualifications.approve(supplier.id, submitted.id, {}));

    const suspended = await asOperator(() =>
      w.suspensions.suspend(supplier.id, {
        reason: 'Two buyers reported undelivered orders in one week',
      }),
    );

    expect(suspended.status).toBe('SUSPENDED');
    // Withheld, not revoked.
    expect(suspended.qualifiedFor).toEqual([]);
    expect(suspended.qualifications[0].state).toBe('APPROVED');
    expect(suspended.qualifications[0].current).toBe(false);
    expect(suspended.suspensions[0].open).toBe(true);

    const events = await outboxFor(w.prisma, org);
    expect(events.map((row) => row.eventName)).toEqual([
      'SUPPLIER_REGISTERED',
      'SUPPLIER_QUALIFIED',
      'SUPPLIER_SUSPENDED',
    ]);
    // Always null: a suspension runs until an explicit reinstatement.
    expect((events[2].payload as { payload: { until: unknown } }).payload.until).toBeNull();

    const reinstated = await asOperator(() =>
      w.suspensions.reinstate(supplier.id, {
        reason: 'The two orders were delivered late, not never',
      }),
    );

    expect(reinstated.status).toBe('ACTIVE');
    // Restored with no new decision.
    expect(reinstated.qualifiedFor).toEqual(['WORKSHOP_SERVICE']);
    // The episode is stamped, never deleted.
    expect(reinstated.suspensions).toHaveLength(1);
    expect(reinstated.suspensions[0].open).toBe(false);
    expect(reinstated.suspensions[0].reinstatedBy).toBeTruthy();

    // The reinstatement gap: no SUPPLIER_REINSTATED exists in the platform
    // catalogue, so nothing new is published. A consumer that hid this
    // supplier must re-read the service. Asserted so the gap is visible in the
    // suite rather than only in a comment.
    expect(await outboxFor(w.prisma, org)).toHaveLength(3);
  });

  it('refuses suspending twice and reinstating what is not suspended', async () => {
    const org = organization();
    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'A supplier', capabilities: ['GOODS_SUPPLY'] }),
    );

    await expect(
      asOperator(() => w.suspensions.reinstate(supplier.id, { reason: 'Nothing to lift here' })),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });

    await asOperator(() => w.suspensions.suspend(supplier.id, { reason: 'A stated reason' }));

    await expect(
      asOperator(() => w.suspensions.suspend(supplier.id, { reason: 'Another stated reason' })),
    ).rejects.toMatchObject({ code: 'BUSINESS_RULE_VIOLATION' });
  });

  it('excludes a suspended supplier from ListQualifiedFor', async () => {
    const org = organization();
    const supplier = await asSupplier(org, () =>
      w.suppliers.register({ displayName: 'A workshop', capabilities: ['WORKSHOP_SERVICE'] }),
    );
    const submitted = await asSupplier(org, () =>
      w.qualifications.submit(supplier.id, { capability: 'WORKSHOP_SERVICE', evidence: [] }),
    );
    await asOperator(() => w.qualifications.approve(supplier.id, submitted.id, {}));

    const before = await asOperator(() =>
      w.suppliers.listQualifiedFor({ capability: 'WORKSHOP_SERVICE', limit: 200 }),
    );
    expect(before.items.map((item) => item.id)).toContain(supplier.id);

    await asOperator(() => w.suspensions.suspend(supplier.id, { reason: 'A stated reason' }));

    // Filtered in SQL, before pagination: filtering the page afterwards would
    // return short pages and, past the first, drop rows entirely.
    const after = await asOperator(() =>
      w.suppliers.listQualifiedFor({ capability: 'WORKSHOP_SERVICE', limit: 200 }),
    );
    expect(after.items.map((item) => item.id)).not.toContain(supplier.id);
  });
});
