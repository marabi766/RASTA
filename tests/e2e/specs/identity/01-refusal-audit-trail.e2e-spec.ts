import { test, expect, errorCode, type Actor } from '../../src/api';
import { ORG } from '../../src/env';
import { waitFor } from '../../src/events';

/**
 * AUD-004 Phase C1, black-box, over the real stack (ADR-053 § 4).
 *
 *   HTTP 403 → identity-service's RefusalAuditExceptionFilter
 *            → security_event_outbox (identity's own database)
 *            → refusal relay → rasta.audit.trail.v1 (the real broker)
 *            → audit-service's AuditTrailConsumer → audit_event (audit's own database)
 *            → GET /v1/audit-events (the real read API)
 *
 * ## Why this project exists, and what it replaces
 *
 * `refusal-audit-flow.int-spec.ts` used to prove this same path by composing
 * `AuditTrailConsumer` from `services/audit-service/src/**` in-process inside
 * an identity-service test file. AGENTS.md A-02 forbids a service importing
 * another service's source — a test file is not an exception — and
 * `scripts/check-service-boundaries.mjs` now refuses that on every
 * `pnpm verify`.
 *
 * This project proves the identical production path with no such import:
 * identity-service and audit-service run as two separately started
 * processes (`.github/workflows/ci.yml`, "End-to-end"), and this test talks
 * to each of them only the way any other client would — HTTP through the
 * gateway, and nothing else. What each service does internally with the
 * message the other side of Kafka delivers is that service's own claim,
 * proved in its own suite:
 *
 *   - identity-service:  `test/security-event-outbox.int-spec.ts` (capture)
 *                         and `test/security-event-kafka.int-spec.ts` (real
 *                         publish, contract-valid envelope, lease fencing).
 *   - audit-service:      `test/trail-ingestion.int-spec.ts` (persistence,
 *                         idempotent redelivery, tenant agreement) and
 *                         `test/kafka-projector.int-spec.ts` (consuming the
 *                         real topic, dead-lettering an invalid message).
 *
 * Redelivery is therefore not re-proved here: forcing a real duplicate
 * Kafka delivery from outside both processes has no safe, non-racy handle in
 * a black-box harness, and the property it would demonstrate — that a
 * duplicate collapses to one record — is already proved against real
 * PostgreSQL in `trail-ingestion.int-spec.ts`. What this project adds that
 * no other suite can is the one thing black-box observation is for: that the
 * two real, separately deployed processes agree on the wire, end to end.
 *
 * ## Why `dehyari.admin` needs no new fixture
 *
 * `identity-service`'s seed (`prisma/seed.ts`) already places `dehyari.admin`
 * (`tenantA`) in `ORG-DEH-0001` only. `ORG-DEH-0002` (`ORG.b`) is a real,
 * seeded organization the same user simply does not belong to. Asking to
 * switch into it is a genuine, unmodified `TENANT_MISMATCH` — the existing
 * Keycloak realm and identity seed already express the exact membership
 * mismatch this scenario needs, so no test-only seed or auth bypass is
 * required (`CodexPrompt.md` § 4's escape hatch is not exercised).
 */

interface AuditRecord {
  id: string;
  organizationId: string | null;
  action: string;
  actorType: string;
  actorId: string | null;
  actorRoles: string[];
  resourceType: string;
  resourceId: string | null;
  outcome: string;
  errorCode: string | null;
  occurrenceCount: number;
  sourceService: string;
  sourceTopic: string;
  correlationId: string;
}

interface AuditPage {
  items: AuditRecord[];
}

function recentWindow(): { from: string; to: string } {
  const to = new Date(Date.now() + 60_000);
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function findByCorrelation(
  actor: Actor,
  correlationId: string,
): Promise<{ status: number; page: AuditPage }> {
  const parameters = new URLSearchParams({
    ...recentWindow(),
    correlationId,
    limit: '10',
  }).toString();
  const response = await actor.get(`/v1/audit-events?${parameters}`);
  return { status: response.status, page: response.body as AuditPage };
}

test.describe('AUD-004 Phase C1 — a real identity refusal becomes a queryable audit record', () => {
  test('POST /v1/users/me/active-organization refused with TENANT_MISMATCH is recorded as one REFUSED record', async ({
    tenantA,
    systemAdmin,
  }) => {
    // The refusal itself, exactly as production returns it — asserted before
    // anything else, so a change to this behavior fails here rather than
    // being noticed only as a missing audit record.
    const response = await tenantA.post('/v1/users/me/active-organization', {
      body: { organizationId: ORG.b },
    });

    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe('TENANT_MISMATCH');

    let record: AuditRecord | undefined;
    await waitFor(
      `an audit record for correlation ${response.correlationId}`,
      async () => {
        const { status, page } = await findByCorrelation(systemAdmin, response.correlationId);
        if (status !== 200 || page.items.length === 0) return false;
        record = page.items[0];
        return true;
      },
      // Two hops slower than a domain event: identity's own relay poll, then
      // audit-service's consumer transaction.
      120_000,
    );

    expect(record).toBeDefined();
    expect(record!.outcome).toBe('REFUSED');
    expect(record!.errorCode).toBe('TENANT_MISMATCH');
    expect(record!.action).toBe('identity.active_organization.switch');
    expect(record!.resourceType).toBe('User');
    expect(record!.actorType).toBe('USER');
    expect(record!.occurrenceCount).toBe(1);
    expect(record!.sourceService).toBe('identity-service');
    expect(record!.sourceTopic).toBe('rasta.audit.trail.v1');
    expect(record!.correlationId).toBe(response.correlationId);
    expect(Array.isArray(record!.actorRoles)).toBe(true);
    expect(record!.actorRoles.length).toBeGreaterThan(0);

    // The evidence belongs to the caller's own tenant, never the one they
    // asked for and were refused — the specific misattribution a shared
    // `resolveOrganization` bug would produce.
    expect(record!.organizationId).toBe(ORG.a);
    expect(record!.organizationId).not.toBe(ORG.b);
    expect(record!.resourceId).not.toBe(ORG.b);

    // No secret and no attacker-controlled value reached a column this
    // endpoint would ever answer with.
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain(ORG.b);
  });

  test('the caller who was refused cannot read the record their own refusal created', async ({
    tenantA,
  }) => {
    // ADR-053 § 10: reading audit evidence is SYSTEM_ADMIN/UNION_ADMIN only.
    // The subject of a REFUSED record has no special standing to read it.
    const response = await tenantA.get(
      `/v1/audit-events?${new URLSearchParams(recentWindow()).toString()}`,
    );
    expect(response.status).toBe(403);
  });
});
