import { test, expect, errorCode, idempotencyKey, type Actor } from '../../src/api';
import { ORG } from '../../src/env';
import { waitFor } from '../../src/events';

/**
 * AUD-002 through the whole stack: a real Keycloak token, the real gateway, the
 * real broker and the real append-only store.
 *
 * ## What this project proves, and the two corrections it makes to the plan
 *
 * `ADR-053-implementation-plan.md` § 6.6 names two E2E scenarios. Both are
 * implemented here, with one narrowing and one substitution, both stated rather
 * than quietly absorbed:
 *
 * **Scenario 1 uses an economic event, not an asset decommissioning.**
 * asset-service is not part of the E2E stack — the job starts economic,
 * marketplace, document, audit and the gateway — so an `ASSET_DECOMMISSIONED`
 * could not be produced without adding a sixth service to the run. The property
 * under test is not which event it was: it is that a real domain action becomes
 * a queryable audit record with the right actor, resource and outcome, that
 * `SYSTEM_ADMIN` can read it, and that `AUDITOR` cannot. A wallet top-up
 * exercises exactly that, through the same projector and the same ten-topic
 * subscription.
 *
 * **Scenario 2 proves the refusal and the absence of a leak, and stops there.**
 * The plan's wording also asks that the refused query be *recorded* as a
 * `REFUSED` audit record. That recording is AUD-004 — the explicit audit trail
 * with `actorRoles`, origin and outcome, which depends on this step and does not
 * exist yet (ADR-053 § 4, plan § 5). Asserting it here would fail; asserting a
 * weakened version of it would be worse. So the scenario is split: what AUD-002
 * can prove is proved, and the deferred half is named in the test title so a
 * reader of the report cannot mistake its absence for coverage.
 */

/** A window wide enough to hold this run and inside the 90-day ceiling. */
function recentWindow(): { from: string; to: string } {
  const to = new Date(Date.now() + 60_000);
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

interface AuditPage {
  items: {
    id: string;
    organizationId: string | null;
    action: string;
    actorType: string;
    actorId: string | null;
    outcome: string;
    correlationId: string;
    sourceTopic: string;
    sourceEventName: string;
    sequenceNo: string;
    changes: unknown;
  }[];
  nextCursor: string | null;
  hasMore: boolean;
}

async function search(
  actor: Actor,
  query: Record<string, string>,
): Promise<{ status: number; page: AuditPage }> {
  const parameters = new URLSearchParams({ ...recentWindow(), ...query }).toString();
  const response = await actor.get(`/v1/audit-events?${parameters}`);
  return { status: response.status, page: response.body as AuditPage };
}

test.describe('AUD-002 — the audit read API over the real stack', () => {
  /** The correlation id of the domain action this project records evidence for. */
  let correlationId: string;
  let walletId: string;

  test('a real financial action becomes a queryable audit record', async ({
    tenantA,
    systemAdmin,
  }) => {
    const wallet = await tenantA.get('/v1/wallets/me');
    expect(wallet.status).toBe(200);
    walletId = (wallet.body as { id: string }).id;

    correlationId = `e2e-audit-${Date.now()}`;
    const topUp = await tenantA.post(`/v1/wallets/${walletId}/top-up`, {
      idempotencyKey: idempotencyKey('audit-topup'),
      correlationId,
      // The same magnitude the economic critical path uses, so this is an
      // ordinary top-up rather than an edge value under test.
      body: { amountMinor: '40000000' },
    });
    expect(topUp.status).toBe(201);

    // The projector consumes from Kafka, so the record arrives after the HTTP
    // response rather than with it. Polled rather than slept on: a fixed wait
    // is either flaky or slow, and this one says what it is waiting for.
    let record: AuditPage['items'][number] | undefined;
    await waitFor(
      `an audit record for correlation ${correlationId}`,
      async () => {
        const { status, page } = await search(systemAdmin, { correlationId, limit: '50' });
        if (status !== 200 || page.items.length === 0) return false;
        record = page.items[0];
        return true;
      },
      120_000,
    );

    expect(record).toBeDefined();
    // The evidence a domain envelope can actually carry (ADR-053 § 1, path A).
    expect(record!.organizationId).toBe(ORG.a);
    expect(record!.correlationId).toBe(correlationId);
    expect(record!.sourceTopic).toBe('rasta.economic.v1');
    expect(record!.outcome).toBe('SUCCESS');
    // A 64-bit column, so a string — never a JSON number, which would lose
    // precision above 2^53 in an ordinary client.
    expect(typeof record!.sequenceNo).toBe('string');
    // Path A stores no payload value. A null here is the documented contract,
    // not a gap: the redacted delta arrives with AUD-004.
    expect(record!.changes).toBeNull();
  });

  test('the oversight role reaches neither audit endpoint', async ({ auditor, systemAdmin }) => {
    // Despite the name, `AUDITOR` is province oversight and has aggregate
    // analytics access only (`docs/04` § 4.15, `docs/09` § 9.3). Refused at the
    // gateway prefix, at `@Roles`, and by `assertNotAuditor()` — three
    // independent layers, and this is the one that proves all three are wired.
    const list = await search(auditor, {});
    expect(list.status).toBe(403);

    const { page } = await search(systemAdmin, { correlationId, limit: '1' });
    const known = page.items[0];
    expect(known).toBeDefined();

    const detail = await auditor.get(
      `/v1/audit-events/${known!.id}?${new URLSearchParams(recentWindow()).toString()}`,
    );
    expect(detail.status).toBe(403);
  });

  test('an unauthenticated caller reaches nothing', async ({ anonymous }) => {
    const response = await anonymous.get(
      `/v1/audit-events?${new URLSearchParams(recentWindow()).toString()}`,
    );
    expect(response.status).toBe(401);
  });

  test('an organization administrator reaches nothing either', async ({ tenantA }) => {
    // Least privilege while "owner of the record" is ambiguous (ADR-053 § 11).
    const response = await search(tenantA, {});
    expect(response.status).toBe(403);
  });

  test('a query with no window is refused before anything is read', async ({ systemAdmin }) => {
    const response = await systemAdmin.get('/v1/audit-events');
    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe('VALIDATION_FAILED');
  });

  test('a window wider than the ceiling is refused, naming the limit', async ({ systemAdmin }) => {
    const response = await systemAdmin.get(
      '/v1/audit-events?from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z',
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('AUDIT_MAX_QUERY_WINDOW_DAYS');
  });

  test('a union administrator sees no other tenant, and no platform-scoped row', async ({
    platformAdmin,
  }) => {
    // `union.admin` is a `UNION_ADMIN` whose active organization is
    // ORG-UNION-YAZD. Its subtree is whatever the local hierarchy projection
    // proves, and in this stack organization-service is not running, so nothing
    // is proved and the scope is its own organization exactly. That is the
    // fail-closed direction: a missing projection narrows, never widens.
    const { status, page } = await search(platformAdmin, { limit: '200' });

    expect(status).toBe(200);
    for (const item of page.items) {
      expect(item.organizationId).toBe(ORG.platform);
    }
    // The specific mistake ADR-053 § 10 names — `organizationId = $1 OR
    // organizationId IS NULL` — asserted on the body rather than the status.
    expect(page.items.map((item) => item.organizationId)).not.toContain(null);
  });

  test('a cross-tenant query is refused and discloses nothing (the REFUSED record itself is AUD-004)', async ({
    platformAdmin,
  }) => {
    const response = await search(platformAdmin, { organizationId: ORG.a, limit: '200' });

    // A tenant the projection does not place beneath the caller is refused,
    // whether it exists or not — so a caller cannot map the hierarchy by
    // probing identifiers.
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.page)).not.toContain('sequenceNo');
  });

  test('a record in another tenant answers 404, exactly as an unknown id does', async ({
    platformAdmin,
    systemAdmin,
  }) => {
    const { page } = await search(systemAdmin, { correlationId, limit: '1' });
    const foreign = page.items[0];
    expect(foreign).toBeDefined();

    const window = new URLSearchParams(recentWindow()).toString();
    const crossTenant = await platformAdmin.get(`/v1/audit-events/${foreign!.id}?${window}`);
    const unknown = await platformAdmin.get(`/v1/audit-events/01JNOSUCHRECORD0000000000?${window}`);

    expect(crossTenant.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Indistinguishable, so the existence of the record is never disclosed
    // (`docs/06` § 6.7).
    expect(errorCode(crossTenant.body)).toBe(errorCode(unknown.body));
  });

  test('there is no write endpoint, for anybody', async ({ systemAdmin }) => {
    // `docs/04` § 4.15: writing is from Kafka only. A structural proof rather
    // than a promise — the route does not exist.
    const response = await systemAdmin.post('/v1/audit-events', { body: { action: 'anything' } });
    expect([404, 405]).toContain(response.status);
  });
});
