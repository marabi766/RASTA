import { randomUUID } from 'node:crypto';
import { test, expect, errorCode, type Actor } from '../../src/api';
import { e2eConfig, ORG } from '../../src/env';
import { waitFor } from '../../src/events';

/**
 * AUD-004 Phases C1–C8, black-box, over the real stack (ADR-053 § 4): one
 * scenario per instrumented identity refusal site (C1, C3, C4, C5, C6, C7, C8),
 * plus the uninstrumented `POST /v1/registration-requests/:id/reject` beside
 * the C8 approval as the comparison and the negative probe.
 *
 *   HTTP 403 ×N → identity-service's RefusalAuditExceptionFilter
 *               → one security_event_outbox row counting N (identity's own database)
 *               → window closes → refusal relay → rasta.audit.trail.v1 (the real broker)
 *               → audit-service's AuditTrailConsumer → audit_event (audit's own database)
 *               → GET /v1/audit-events (the real read API)
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
 *   - identity-service:  `test/security-event-outbox.int-spec.ts` (capture),
 *                         `test/security-event-aggregation.int-spec.ts`
 *                         (aggregation, claim boundary, races) and
 *                         `test/security-event-kafka.int-spec.ts` (real
 *                         publish, aggregated count, lease fencing).
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
 * ## Aggregation, observed from outside (Phase C2)
 *
 * The scenario refuses the same caller `REFUSALS` times and expects **one**
 * audit record whose `occurrenceCount` is `REFUSALS`. identity-service decides
 * windows with the database clock, which a black-box test cannot read, so the
 * burst is sent early in a fresh window on the runner's clock — with a margin
 * either side for skew between the runner and the database container — and
 * every refusal carries one shared correlation id. If the burst ever did
 * straddle a boundary, the search by that id would return two records and the
 * test would fail naming them, rather than passing on a lucky sum. The window
 * is `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS`, read from the same variable
 * the running service reads (CI: 10 seconds — configuration, not a bypass).
 *
 * ## Why `dehyari.admin` needs no new fixture
 *
 * `identity-service`'s seed (`prisma/seed.ts`) already places `dehyari.admin`
 * (`tenantA`) in `ORG-DEH-0001` only. `ORG-DEH-0002` (`ORG.b`) is a real,
 * seeded organization the same user simply does not belong to. Asking to
 * switch into it is a genuine, unmodified `TENANT_MISMATCH` — the existing
 * Keycloak realm and identity seed already express the exact membership
 * mismatch this scenario needs, so no test-only seed or auth bypass is
 * required.
 */

const REFUSALS = 5;
/** How far into a window the burst may start, and how much must remain after it. */
const WINDOW_START_MARGIN_MS = 1_000;
const BURST_BUDGET_MS = 4_000;

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the runner's clock is just past the start of an aggregation window. */
async function atFreshWindow(windowMs: number): Promise<void> {
  for (;;) {
    const offset = Date.now() % windowMs;
    if (offset >= WINDOW_START_MARGIN_MS && windowMs - offset >= BURST_BUDGET_MS) return;
    const wait =
      offset < WINDOW_START_MARGIN_MS
        ? WINDOW_START_MARGIN_MS - offset
        : windowMs - offset + WINDOW_START_MARGIN_MS;
    await sleep(wait);
  }
}

test.describe('AUD-004 — real identity refusals become one aggregated, queryable audit record', () => {
  test(`${REFUSALS} refusals of POST /v1/users/me/active-organization in one window are recorded as one REFUSED record counting ${REFUSALS}`, async ({
    tenantA,
    systemAdmin,
  }) => {
    const windowMs = e2eConfig().identityAggregationWindowSeconds * 1000;
    if (windowMs < BURST_BUDGET_MS + WINDOW_START_MARGIN_MS * 2) {
      throw new Error(
        `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS=${windowMs / 1000} is too short to place ` +
          `${REFUSALS} refusals in one window from outside the service`,
      );
    }
    // One wait for a fresh window, one window to close, then two hops.
    test.setTimeout(windowMs * 2 + 180_000);

    const correlationId = `e2e-refusal-${randomUUID()}`;
    await atFreshWindow(windowMs);
    const burstStartedAt = Date.now();

    // The refusal itself, exactly as production returns it — asserted before
    // anything else, so a change to this behavior fails here rather than
    // being noticed only as a missing audit record.
    for (let i = 0; i < REFUSALS; i += 1) {
      const response = await tenantA.post('/v1/users/me/active-organization', {
        body: { organizationId: ORG.b },
        correlationId,
      });
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('TENANT_MISMATCH');
      expect(response.correlationId).toBe(correlationId);
    }
    expect(Date.now() - burstStartedAt).toBeLessThan(BURST_BUDGET_MS);

    let records: AuditRecord[] = [];
    await waitFor(
      `the aggregated audit record for correlation ${correlationId}`,
      async () => {
        const { status, page } = await findByCorrelation(systemAdmin, correlationId);
        if (status !== 200 || page.items.length === 0) return false;
        records = page.items;
        return true;
      },
      // The window has to close first; then identity's relay poll and
      // audit-service's consumer transaction.
      windowMs + 150_000,
      () => `last seen: ${JSON.stringify(records)}`,
    );

    // Published only after its window closed, so the count is final when it
    // appears. One record, counting every refusal — not one record per probe.
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.occurrenceCount).toBe(REFUSALS);
    expect(record.outcome).toBe('REFUSED');
    expect(record.errorCode).toBe('TENANT_MISMATCH');
    expect(record.action).toBe('identity.active_organization.switch');
    expect(record.resourceType).toBe('User');
    expect(record.actorType).toBe('USER');
    expect(record.sourceService).toBe('identity-service');
    expect(record.sourceTopic).toBe('rasta.audit.trail.v1');
    expect(record.correlationId).toBe(correlationId);
    expect(Array.isArray(record.actorRoles)).toBe(true);
    expect(record.actorRoles.length).toBeGreaterThan(0);

    // The evidence belongs to the caller's own tenant, never the one they
    // asked for and were refused — the specific misattribution a shared
    // `resolveOrganization` bug would produce.
    expect(record.organizationId).toBe(ORG.a);
    expect(record.organizationId).not.toBe(ORG.b);
    expect(record.resourceId).not.toBe(ORG.b);

    // No secret and no attacker-controlled value reached a column this
    // endpoint would ever answer with.
    expect(JSON.stringify(record)).not.toContain(ORG.b);

    // And it stays one: nothing about this burst arrives later as a second record.
    await sleep(3_000);
    const settled = await findByCorrelation(systemAdmin, correlationId);
    expect(settled.status).toBe(200);
    expect(settled.page.items.map((item) => [item.id, item.occurrenceCount])).toEqual([
      [record.id, REFUSALS],
    ]);
  });

  test(`${REFUSALS} role refusals of GET /v1/users in one window are recorded as one INSUFFICIENT_ROLE record counting ${REFUSALS} (AUD-004 Phase C3)`, async ({
    auditor,
    systemAdmin,
  }) => {
    // `province.auditor` holds only AUDITOR, so the platform RolesGuard refuses
    // GET /v1/users (ORGANIZATION_ADMIN | UNION_ADMIN) — a real, unmodified
    // denial through the real gateway, from the existing realm and seed.
    const windowMs = e2eConfig().identityAggregationWindowSeconds * 1000;
    if (windowMs < BURST_BUDGET_MS + WINDOW_START_MARGIN_MS * 2) {
      throw new Error(
        `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS=${windowMs / 1000} is too short to place ` +
          `${REFUSALS} refusals in one window from outside the service`,
      );
    }
    test.setTimeout(windowMs * 2 + 180_000);

    const correlationId = `e2e-role-refusal-${randomUUID()}`;
    const querySecret = `e2e-query-${randomUUID()}`;
    await atFreshWindow(windowMs);
    const burstStartedAt = Date.now();

    for (let i = 0; i < REFUSALS; i += 1) {
      const response = await auditor.get(`/v1/users?q=${querySecret}`, { correlationId });
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('INSUFFICIENT_ROLE');
      expect((response.body as { message?: string }).message).toBe(
        'You do not have permission to perform this action',
      );
      expect(response.correlationId).toBe(correlationId);
    }
    expect(Date.now() - burstStartedAt).toBeLessThan(BURST_BUDGET_MS);

    let records: AuditRecord[] = [];
    await waitFor(
      `the aggregated role-refusal record for correlation ${correlationId}`,
      async () => {
        const { status, page } = await findByCorrelation(systemAdmin, correlationId);
        if (status !== 200 || page.items.length === 0) return false;
        records = page.items;
        return true;
      },
      windowMs + 150_000,
      () => `last seen: ${JSON.stringify(records)}`,
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.occurrenceCount).toBe(REFUSALS);
    expect(record.outcome).toBe('REFUSED');
    expect(record.errorCode).toBe('INSUFFICIENT_ROLE');
    expect(record.action).toBe('identity.users.list');
    expect(record.resourceType).toBe('User');
    expect(record.actorType).toBe('USER');
    expect(record.resourceId).toBe(record.actorId);
    expect(record.sourceService).toBe('identity-service');
    expect(record.sourceTopic).toBe('rasta.audit.trail.v1');
    expect(record.correlationId).toBe(correlationId);
    // The tenant the auditor acted for, from its own token.
    expect(record.organizationId).toBe(ORG.oversight);
    // The actor's own roles are the ADR's evidence; the endpoint's required
    // roles, the query and the error text are not.
    expect(record.actorRoles).toContain('AUDITOR');
    const serialised = JSON.stringify(record);
    for (const leaked of [querySecret, 'ORGANIZATION_ADMIN', 'UNION_ADMIN', 'permission']) {
      expect(serialised).not.toContain(leaked);
    }

    await sleep(3_000);
    const settled = await findByCorrelation(systemAdmin, correlationId);
    expect(settled.page.items.map((item) => [item.id, item.occurrenceCount])).toEqual([
      [record.id, REFUSALS],
    ]);

    // The refused caller cannot read the evidence its refusal produced.
    const own = await auditor.get(
      `/v1/audit-events?${new URLSearchParams({ ...recentWindow(), correlationId }).toString()}`,
    );
    expect(own.status).toBe(403);
  });

  test(`${REFUSALS} role refusals of POST /v1/users in one window are recorded as one INSUFFICIENT_ROLE record counting ${REFUSALS} (AUD-004 Phase C4)`, async ({
    auditor,
    systemAdmin,
  }) => {
    // `province.auditor` holds only AUDITOR, so the platform RolesGuard refuses
    // POST /v1/users (ORGANIZATION_ADMIN | UNION_ADMIN) before the body is
    // read — a real, unmodified denial through the real gateway. The body
    // names a user the caller wanted to create; none of it is evidence.
    const windowMs = e2eConfig().identityAggregationWindowSeconds * 1000;
    if (windowMs < BURST_BUDGET_MS + WINDOW_START_MARGIN_MS * 2) {
      throw new Error(
        `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS=${windowMs / 1000} is too short to place ` +
          `${REFUSALS} refusals in one window from outside the service`,
      );
    }
    test.setTimeout(windowMs * 2 + 180_000);

    const correlationId = `e2e-create-refusal-${randomUUID()}`;
    const bodySecret = `e2e-body-${randomUUID()}`;
    await atFreshWindow(windowMs);
    const burstStartedAt = Date.now();

    for (let i = 0; i < REFUSALS; i += 1) {
      const response = await auditor.post('/v1/users', {
        body: {
          username: `${bodySecret}-${i}`,
          email: `${bodySecret}@e2e.invalid`,
          firstName: bodySecret,
          lastName: bodySecret,
          organizationId: ORG.b,
          roles: ['SYSTEM_ADMIN'],
        },
        correlationId,
      });
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('INSUFFICIENT_ROLE');
      expect((response.body as { message?: string }).message).toBe(
        'You do not have permission to perform this action',
      );
      expect(response.correlationId).toBe(correlationId);
      expect(JSON.stringify(response.body)).not.toContain(bodySecret);
    }
    expect(Date.now() - burstStartedAt).toBeLessThan(BURST_BUDGET_MS);

    let records: AuditRecord[] = [];
    await waitFor(
      `the aggregated create-refusal record for correlation ${correlationId}`,
      async () => {
        const { status, page } = await findByCorrelation(systemAdmin, correlationId);
        if (status !== 200 || page.items.length === 0) return false;
        records = page.items;
        return true;
      },
      windowMs + 150_000,
      () => `last seen: ${JSON.stringify(records)}`,
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.occurrenceCount).toBe(REFUSALS);
    expect(record.outcome).toBe('REFUSED');
    expect(record.errorCode).toBe('INSUFFICIENT_ROLE');
    expect(record.action).toBe('identity.users.create');
    expect(record.resourceType).toBe('User');
    expect(record.actorType).toBe('USER');
    // A refused create has no created user: the resource is the caller.
    expect(record.resourceId).toBe(record.actorId);
    expect(record.sourceService).toBe('identity-service');
    expect(record.sourceTopic).toBe('rasta.audit.trail.v1');
    expect(record.correlationId).toBe(correlationId);
    expect(record.organizationId).toBe(ORG.oversight);
    expect(record.actorRoles).toContain('AUDITOR');
    const serialised = JSON.stringify(record);
    for (const leaked of [
      bodySecret,
      ORG.b,
      'SYSTEM_ADMIN',
      'ORGANIZATION_ADMIN',
      'UNION_ADMIN',
      'permission',
    ]) {
      expect(serialised).not.toContain(leaked);
    }

    await sleep(3_000);
    const settled = await findByCorrelation(systemAdmin, correlationId);
    expect(settled.page.items.map((item) => [item.id, item.occurrenceCount])).toEqual([
      [record.id, REFUSALS],
    ]);

    // The refused caller cannot read the evidence its refusal produced.
    const own = await auditor.get(
      `/v1/audit-events?${new URLSearchParams({ ...recentWindow(), correlationId }).toString()}`,
    );
    expect(own.status).toBe(403);
  });

  test(`${REFUSALS} role refusals of POST /v1/users/:id/memberships with varying targets and bodies are recorded as one INSUFFICIENT_ROLE record counting ${REFUSALS} (AUD-004 Phase C5)`, async ({
    auditor,
    systemAdmin,
  }) => {
    // `province.auditor` holds only AUDITOR, so the platform RolesGuard refuses
    // POST /v1/users/:id/memberships (ORGANIZATION_ADMIN | UNION_ADMIN) before
    // the path id or the body is read. Every refusal names a different target
    // user and a different body; the record must aggregate by the caller alone.
    const windowMs = e2eConfig().identityAggregationWindowSeconds * 1000;
    if (windowMs < BURST_BUDGET_MS + WINDOW_START_MARGIN_MS * 2) {
      throw new Error(
        `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS=${windowMs / 1000} is too short to place ` +
          `${REFUSALS} refusals in one window from outside the service`,
      );
    }
    test.setTimeout(windowMs * 2 + 180_000);

    const correlationId = `e2e-membership-refusal-${randomUUID()}`;
    const targets = Array.from({ length: REFUSALS }, () => `USR-e2e-target-${randomUUID()}`);
    const bodySecrets = Array.from({ length: REFUSALS }, () => `e2e-body-${randomUUID()}`);
    await atFreshWindow(windowMs);
    const burstStartedAt = Date.now();

    for (let i = 0; i < REFUSALS; i += 1) {
      const response = await auditor.post(`/v1/users/${targets[i]}/memberships`, {
        body: {
          organizationId: ORG.b,
          roles: ['SYSTEM_ADMIN'],
          note: bodySecrets[i],
        },
        correlationId,
      });
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('INSUFFICIENT_ROLE');
      expect((response.body as { message?: string }).message).toBe(
        'You do not have permission to perform this action',
      );
      expect(response.correlationId).toBe(correlationId);
      // The platform's error body echoes the caller's own path (the target id)
      // back to them, unchanged and the same for every route; the body is
      // never echoed. Neither may reach the audit record, asserted below.
      expect(JSON.stringify(response.body)).not.toContain(bodySecrets[i]!);
    }
    expect(Date.now() - burstStartedAt).toBeLessThan(BURST_BUDGET_MS);

    let records: AuditRecord[] = [];
    await waitFor(
      `the aggregated membership-refusal record for correlation ${correlationId}`,
      async () => {
        const { status, page } = await findByCorrelation(systemAdmin, correlationId);
        if (status !== 200 || page.items.length === 0) return false;
        records = page.items;
        return true;
      },
      windowMs + 150_000,
      () => `last seen: ${JSON.stringify(records)}`,
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.occurrenceCount).toBe(REFUSALS);
    expect(record.outcome).toBe('REFUSED');
    expect(record.errorCode).toBe('INSUFFICIENT_ROLE');
    expect(record.action).toBe('identity.memberships.create');
    expect(record.resourceType).toBe('Membership');
    expect(record.actorType).toBe('USER');
    // The verified caller, never any of the targets the paths named.
    expect(record.resourceId).toBe(record.actorId);
    expect(record.sourceService).toBe('identity-service');
    expect(record.sourceTopic).toBe('rasta.audit.trail.v1');
    expect(record.correlationId).toBe(correlationId);
    expect(record.organizationId).toBe(ORG.oversight);
    expect(record.actorRoles).toContain('AUDITOR');
    const serialised = JSON.stringify(record);
    for (const leaked of [
      ...targets,
      ...bodySecrets,
      'USR-e2e-target-',
      ORG.b,
      '/memberships',
      'SYSTEM_ADMIN',
      'ORGANIZATION_ADMIN',
      'UNION_ADMIN',
      'permission',
    ]) {
      expect(serialised).not.toContain(leaked);
    }

    await sleep(3_000);
    const settled = await findByCorrelation(systemAdmin, correlationId);
    expect(settled.status).toBe(200);
    expect(settled.page.items.map((item) => [item.id, item.occurrenceCount])).toEqual([
      [record.id, REFUSALS],
    ]);

    // The refused caller cannot read the evidence its refusal produced.
    const own = await auditor.get(
      `/v1/audit-events?${new URLSearchParams({ ...recentWindow(), correlationId }).toString()}`,
    );
    expect(own.status).toBe(403);
  });

  test(`${REFUSALS} role refusals of POST /v1/memberships/:id/roles with varying memberships and bodies are recorded as one INSUFFICIENT_ROLE record counting ${REFUSALS} (AUD-004 Phase C6)`, async ({
    auditor,
    systemAdmin,
  }) => {
    // `province.auditor` holds only AUDITOR, so the platform RolesGuard refuses
    // POST /v1/memberships/:id/roles (ORGANIZATION_ADMIN | UNION_ADMIN) before
    // the membership is looked up or the body is read. Every refusal names a
    // different membership and a different body; the record must aggregate by
    // the caller alone.
    const windowMs = e2eConfig().identityAggregationWindowSeconds * 1000;
    if (windowMs < BURST_BUDGET_MS + WINDOW_START_MARGIN_MS * 2) {
      throw new Error(
        `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS=${windowMs / 1000} is too short to place ` +
          `${REFUSALS} refusals in one window from outside the service`,
      );
    }
    test.setTimeout(windowMs * 2 + 180_000);

    const correlationId = `e2e-roles-refusal-${randomUUID()}`;
    const targets = Array.from({ length: REFUSALS }, () => `MBR-e2e-target-${randomUUID()}`);
    const bodySecrets = Array.from({ length: REFUSALS }, () => `e2e-reason-${randomUUID()}`);
    await atFreshWindow(windowMs);
    const burstStartedAt = Date.now();

    for (let i = 0; i < REFUSALS; i += 1) {
      const response = await auditor.post(`/v1/memberships/${targets[i]}/roles`, {
        body: { roles: ['SYSTEM_ADMIN'], reason: bodySecrets[i] },
        correlationId,
      });
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('INSUFFICIENT_ROLE');
      expect((response.body as { message?: string }).message).toBe(
        'You do not have permission to perform this action',
      );
      expect(response.correlationId).toBe(correlationId);
      // The platform's error body echoes the caller's own path back to them,
      // unchanged and the same for every route; the body is never echoed.
      expect(JSON.stringify(response.body)).not.toContain(bodySecrets[i]!);
    }
    expect(Date.now() - burstStartedAt).toBeLessThan(BURST_BUDGET_MS);

    let records: AuditRecord[] = [];
    await waitFor(
      `the aggregated roles-refusal record for correlation ${correlationId}`,
      async () => {
        const { status, page } = await findByCorrelation(systemAdmin, correlationId);
        if (status !== 200 || page.items.length === 0) return false;
        records = page.items;
        return true;
      },
      windowMs + 150_000,
      () => `last seen: ${JSON.stringify(records)}`,
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.occurrenceCount).toBe(REFUSALS);
    expect(record.outcome).toBe('REFUSED');
    expect(record.errorCode).toBe('INSUFFICIENT_ROLE');
    expect(record.action).toBe('identity.memberships.roles.replace');
    expect(record.resourceType).toBe('Membership');
    expect(record.actorType).toBe('USER');
    // The verified caller, never any of the memberships the paths named.
    expect(record.resourceId).toBe(record.actorId);
    expect(record.sourceService).toBe('identity-service');
    expect(record.sourceTopic).toBe('rasta.audit.trail.v1');
    expect(record.correlationId).toBe(correlationId);
    expect(record.organizationId).toBe(ORG.oversight);
    expect(record.actorRoles).toContain('AUDITOR');
    const serialised = JSON.stringify(record);
    for (const leaked of [
      ...targets,
      ...bodySecrets,
      'MBR-e2e-target-',
      '/memberships',
      '/roles',
      'SYSTEM_ADMIN',
      'ORGANIZATION_ADMIN',
      'UNION_ADMIN',
      'permission',
    ]) {
      expect(serialised).not.toContain(leaked);
    }

    await sleep(3_000);
    const settled = await findByCorrelation(systemAdmin, correlationId);
    expect(settled.status).toBe(200);
    expect(settled.page.items.map((item) => [item.id, item.occurrenceCount])).toEqual([
      [record.id, REFUSALS],
    ]);

    // The refused caller cannot read the evidence its refusal produced.
    const own = await auditor.get(
      `/v1/audit-events?${new URLSearchParams({ ...recentWindow(), correlationId }).toString()}`,
    );
    expect(own.status).toBe(403);
  });

  test(`${REFUSALS} role refusals of POST /v1/memberships/:id/revoke with varying memberships and reasons are recorded as one INSUFFICIENT_ROLE record counting ${REFUSALS} (AUD-004 Phase C7)`, async ({
    auditor,
    systemAdmin,
  }) => {
    // `province.auditor` holds only AUDITOR, so the platform RolesGuard refuses
    // POST /v1/memberships/:id/revoke (ORGANIZATION_ADMIN | UNION_ADMIN) before
    // the membership is looked up or the body is read. Every refusal names a
    // different membership and a different reason; the record must aggregate by
    // the caller alone.
    const windowMs = e2eConfig().identityAggregationWindowSeconds * 1000;
    if (windowMs < BURST_BUDGET_MS + WINDOW_START_MARGIN_MS * 2) {
      throw new Error(
        `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS=${windowMs / 1000} is too short to place ` +
          `${REFUSALS} refusals in one window from outside the service`,
      );
    }
    test.setTimeout(windowMs * 2 + 180_000);

    const correlationId = `e2e-revoke-refusal-${randomUUID()}`;
    const targets = Array.from({ length: REFUSALS }, () => `MBR-e2e-revoke-${randomUUID()}`);
    const bodySecrets = Array.from({ length: REFUSALS }, () => `e2e-revoke-reason-${randomUUID()}`);
    await atFreshWindow(windowMs);
    const burstStartedAt = Date.now();

    for (let i = 0; i < REFUSALS; i += 1) {
      const response = await auditor.post(`/v1/memberships/${targets[i]}/revoke`, {
        body: { reason: bodySecrets[i] },
        correlationId,
      });
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('INSUFFICIENT_ROLE');
      expect((response.body as { message?: string }).message).toBe(
        'You do not have permission to perform this action',
      );
      expect(response.correlationId).toBe(correlationId);
      // The platform's error body echoes the caller's own path back to them,
      // unchanged and the same for every route; the body is never echoed.
      expect(JSON.stringify(response.body)).not.toContain(bodySecrets[i]!);
    }
    expect(Date.now() - burstStartedAt).toBeLessThan(BURST_BUDGET_MS);

    let records: AuditRecord[] = [];
    await waitFor(
      `the aggregated revoke-refusal record for correlation ${correlationId}`,
      async () => {
        const { status, page } = await findByCorrelation(systemAdmin, correlationId);
        if (status !== 200 || page.items.length === 0) return false;
        records = page.items;
        return true;
      },
      windowMs + 150_000,
      () => `last seen: ${JSON.stringify(records)}`,
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.occurrenceCount).toBe(REFUSALS);
    expect(record.outcome).toBe('REFUSED');
    expect(record.errorCode).toBe('INSUFFICIENT_ROLE');
    expect(record.action).toBe('identity.memberships.revoke');
    expect(record.resourceType).toBe('Membership');
    expect(record.actorType).toBe('USER');
    // The verified caller, never any of the memberships the paths named.
    expect(record.resourceId).toBe(record.actorId);
    expect(record.sourceService).toBe('identity-service');
    expect(record.sourceTopic).toBe('rasta.audit.trail.v1');
    expect(record.correlationId).toBe(correlationId);
    expect(record.organizationId).toBe(ORG.oversight);
    expect(record.actorRoles).toContain('AUDITOR');
    const serialised = JSON.stringify(record);
    for (const leaked of [
      ...targets,
      ...bodySecrets,
      'MBR-e2e-revoke-',
      '/memberships',
      '/revoke',
      'ORGANIZATION_ADMIN',
      'UNION_ADMIN',
      'permission',
    ]) {
      expect(serialised).not.toContain(leaked);
    }

    await sleep(3_000);
    const settled = await findByCorrelation(systemAdmin, correlationId);
    expect(settled.status).toBe(200);
    expect(settled.page.items.map((item) => [item.id, item.occurrenceCount])).toEqual([
      [record.id, REFUSALS],
    ]);

    // The refused caller cannot read the evidence its refusal produced.
    const own = await auditor.get(
      `/v1/audit-events?${new URLSearchParams({ ...recentWindow(), correlationId }).toString()}`,
    );
    expect(own.status).toBe(403);
  });

  test(`${REFUSALS} role refusals of POST /v1/registration-requests/:id/approve with varying request ids and body secrets are recorded as one INSUFFICIENT_ROLE record counting ${REFUSALS} (AUD-004 Phase C8)`, async ({
    auditor,
    systemAdmin,
  }) => {
    // `province.auditor` holds only AUDITOR, so it lacks UNION_ADMIN and the
    // platform RolesGuard refuses POST /v1/registration-requests/:id/approve
    // before the registration request is looked up or the body is read. Every
    // refusal names a different request and a different body secret; the record
    // must aggregate by the caller alone.
    const windowMs = e2eConfig().identityAggregationWindowSeconds * 1000;
    if (windowMs < BURST_BUDGET_MS + WINDOW_START_MARGIN_MS * 2) {
      throw new Error(
        `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS=${windowMs / 1000} is too short to place ` +
          `${REFUSALS} refusals in one window from outside the service`,
      );
    }
    test.setTimeout(windowMs * 2 + 180_000);

    const correlationId = `e2e-approve-refusal-${randomUUID()}`;
    const targets = Array.from({ length: REFUSALS }, () => `REG-e2e-approve-${randomUUID()}`);
    const bodySecrets = Array.from(
      { length: REFUSALS },
      () => `e2e-approve-secret-${randomUUID()}`,
    );
    await atFreshWindow(windowMs);
    const burstStartedAt = Date.now();

    for (let i = 0; i < REFUSALS; i += 1) {
      const response = await auditor.post(`/v1/registration-requests/${targets[i]}/approve`, {
        body: { organizationId: `ORG-${bodySecrets[i]}`, roles: ['UNION_ADMIN'] },
        correlationId,
      });
      expect(response.status).toBe(403);
      expect(errorCode(response.body)).toBe('INSUFFICIENT_ROLE');
      expect((response.body as { message?: string }).message).toBe(
        'You do not have permission to perform this action',
      );
      expect(response.correlationId).toBe(correlationId);
      // The platform's error body echoes the caller's own path back to them,
      // unchanged and the same for every route; the body is never echoed.
      expect(JSON.stringify(response.body)).not.toContain(bodySecrets[i]!);
    }
    expect(Date.now() - burstStartedAt).toBeLessThan(BURST_BUDGET_MS);

    // The sibling review outcome is uninstrumented: the same method, the same
    // prefix and the same single required role produce the identical response
    // and no record of their own.
    const rejectCorrelationId = `e2e-reject-probe-${randomUUID()}`;
    const rejection = await auditor.post(`/v1/registration-requests/${randomUUID()}/reject`, {
      body: { reason: `e2e-reject-${randomUUID()}` },
      correlationId: rejectCorrelationId,
    });
    expect(rejection.status).toBe(403);
    expect(errorCode(rejection.body)).toBe('INSUFFICIENT_ROLE');
    expect((rejection.body as { message?: string }).message).toBe(
      'You do not have permission to perform this action',
    );

    let records: AuditRecord[] = [];
    await waitFor(
      `the aggregated approve-refusal record for correlation ${correlationId}`,
      async () => {
        const { status, page } = await findByCorrelation(systemAdmin, correlationId);
        if (status !== 200 || page.items.length === 0) return false;
        records = page.items;
        return true;
      },
      windowMs + 150_000,
      () => `last seen: ${JSON.stringify(records)}`,
    );

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.occurrenceCount).toBe(REFUSALS);
    expect(record.outcome).toBe('REFUSED');
    expect(record.errorCode).toBe('INSUFFICIENT_ROLE');
    expect(record.action).toBe('identity.registration_requests.approve');
    expect(record.resourceType).toBe('RegistrationRequest');
    expect(record.actorType).toBe('USER');
    // The verified caller, never any of the registration requests the paths named.
    expect(record.resourceId).toBe(record.actorId);
    expect(record.sourceService).toBe('identity-service');
    expect(record.sourceTopic).toBe('rasta.audit.trail.v1');
    expect(record.correlationId).toBe(correlationId);
    expect(record.organizationId).toBe(ORG.oversight);
    expect(record.actorRoles).toContain('AUDITOR');
    const serialised = JSON.stringify(record);
    for (const leaked of [
      ...targets,
      ...bodySecrets,
      'REG-e2e-approve-',
      '/registration-requests',
      '/approve',
      'UNION_ADMIN',
      'permission',
    ]) {
      expect(serialised).not.toContain(leaked);
    }

    await sleep(3_000);
    const settled = await findByCorrelation(systemAdmin, correlationId);
    expect(settled.status).toBe(200);
    expect(settled.page.items.map((item) => [item.id, item.occurrenceCount])).toEqual([
      [record.id, REFUSALS],
    ]);

    // The uninstrumented rejection produced no record at all.
    const probe = await findByCorrelation(systemAdmin, rejectCorrelationId);
    expect(probe.status).toBe(200);
    expect(probe.page.items).toHaveLength(0);

    // The refused caller cannot read the evidence its refusal produced.
    const own = await auditor.get(
      `/v1/audit-events?${new URLSearchParams({ ...recentWindow(), correlationId }).toString()}`,
    );
    expect(own.status).toBe(403);
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
