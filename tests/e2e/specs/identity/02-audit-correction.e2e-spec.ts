import { randomUUID } from 'node:crypto';
import { test, expect, errorCode, idempotencyKey, type Actor } from '../../src/api';
import { e2eConfig, ORG } from '../../src/env';
import { waitFor } from '../../src/events';

/**
 * The audit correction command, black-box, over the real stack (ADR-053 § 7,
 * the correction half of AUD-003).
 *
 *   POST /v1/audit-corrections (gateway → identity-service)
 *     → identity asks audit-service's internal lookup whether the target exists
 *     → one AUDIT_EVENT_RECORDED v1 on identity's standard outbox, same transaction
 *       as the command's idempotency record
 *     → standard relay → rasta.audit.trail.v1 → audit-service's path-B consumer
 *     → a NEW audit_event, chained, linked by correctionOf
 *     → GET /v1/audit-events/{id} shows both directions of the link
 *
 * Nothing here writes to audit-service directly or reads either database: every
 * observation is an HTTP answer from the gateway, as a client would see it.
 *
 * ## The record being corrected
 *
 * Created by this scenario, so it is known exactly: one real role refusal of
 * `GET /v1/users` by `province.auditor` (the Phase C3 site), waited for until
 * audit-service has recorded it. The correction then targets that record by its
 * id and its own `occurredAt`.
 *
 * ## Budgets
 *
 * `users` and `audit-events` run on the platform default (300 per minute per
 * user) and `audit-corrections` has no override. This scenario spends one
 * `users` call for the auditor and a handful of commands for the system
 * administrator; the rate-limited `registration-requests` prefix is not touched,
 * so the Phase C8/C9 budgets are unchanged. Nothing raises, resets or bypasses a
 * limit.
 */

interface AuditRecord {
  id: string;
  occurredAt: string;
  organizationId: string | null;
  action: string;
  actorType: string;
  actorId: string | null;
  actorRoles: string[];
  resourceType: string;
  resourceId: string | null;
  outcome: string;
  errorCode: string | null;
  reason: string | null;
  changes: unknown;
  occurrenceCount: number;
  sourceService: string;
  sourceEventId: string;
  sourceTopic: string;
  correlationId: string;
  correctionOf: string | null;
  correctedBy: string[];
}

interface AuditPage {
  items: AuditRecord[];
}

function recentWindow(): { from: string; to: string } {
  const to = new Date(Date.now() + 60_000);
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function search(
  actor: Actor,
  filters: Record<string, string>,
): Promise<{ status: number; page: AuditPage }> {
  const parameters = new URLSearchParams({ ...recentWindow(), limit: '10', ...filters }).toString();
  const response = await actor.get(`/v1/audit-events?${parameters}`);
  return { status: response.status, page: response.body as AuditPage };
}

async function readOne(actor: Actor, id: string): Promise<{ status: number; record: AuditRecord }> {
  const response = await actor.get(
    `/v1/audit-events/${id}?${new URLSearchParams(recentWindow()).toString()}`,
  );
  return { status: response.status, record: response.body as AuditRecord };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('AUD-003 — an audit record is corrected by a linked record, never by an edit', () => {
  test('SYSTEM_ADMIN corrects a real record through the gateway; both directions link, the original is unchanged', async ({
    auditor,
    systemAdmin,
    platformAdmin,
    tenantA,
  }) => {
    const windowMs = e2eConfig().identityAggregationWindowSeconds * 1000;
    test.setTimeout(windowMs * 2 + 300_000);

    // ---- a known record to correct ----------------------------------------
    const refusalCorrelation = `e2e-correction-target-${randomUUID()}`;
    const refused = await auditor.get('/v1/users', { correlationId: refusalCorrelation });
    expect(refused.status).toBe(403);

    let original: AuditRecord | undefined;
    await waitFor(
      `the refusal record for ${refusalCorrelation}`,
      async () => {
        const { status, page } = await search(systemAdmin, { correlationId: refusalCorrelation });
        original = status === 200 ? page.items[0] : undefined;
        return original !== undefined;
      },
      windowMs + 150_000,
      () => `last seen: ${JSON.stringify(original)}`,
    );
    const target = original!;
    expect(target.correctionOf).toBeNull();
    expect(target.correctedBy).toEqual([]);
    const { correctedBy: _before, ...originalWithoutLinks } = target;

    // ---- the command ------------------------------------------------------
    const secret = `e2e-correction-secret-${randomUUID()}`;
    const key = idempotencyKey('audit-correction');
    const commandCorrelation = `e2e-correction-${randomUUID()}`;
    const body = {
      auditEventId: target.id,
      occurredAt: target.occurredAt,
      reason: 'E2E: the refusal was recorded against the wrong outcome',
      changes: [
        { field: 'outcome', from: 'REFUSED', to: 'SUCCESS' },
        { field: 'credentials.password', from: secret, to: `${secret}-new` },
      ],
    };

    const accepted = await systemAdmin.post('/v1/audit-corrections', {
      body,
      idempotencyKey: key,
      correlationId: commandCorrelation,
    });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({
      status: 'ACCEPTED',
      eventId: expect.any(String),
      correctionOf: target.id,
      acceptedAt: expect.any(String),
    });
    const acceptedBody = accepted.body as { eventId: string };
    // The answer names no tenant and echoes no value.
    expect(JSON.stringify(accepted.body)).not.toContain(ORG.oversight);
    expect(JSON.stringify(accepted.body)).not.toContain(secret);

    // ---- ingestion: a NEW record, linked ----------------------------------
    let correction: AuditRecord | undefined;
    await waitFor(
      `the correction record for ${commandCorrelation}`,
      async () => {
        const { status, page } = await search(systemAdmin, { correlationId: commandCorrelation });
        correction =
          status === 200
            ? page.items.find((item) => item.action === 'audit.correction')
            : undefined;
        return correction !== undefined;
      },
      150_000,
      () => `last seen: ${JSON.stringify(correction)}`,
    );
    const fix = correction!;
    expect(fix.id).not.toBe(target.id);
    expect(fix).toMatchObject({
      correctionOf: target.id,
      correctedBy: [],
      action: 'audit.correction',
      resourceType: 'AuditEvent',
      resourceId: target.id,
      outcome: 'SUCCESS',
      errorCode: null,
      reason: body.reason,
      occurrenceCount: 1,
      actorType: 'USER',
      // The tenant of the record it corrects, from audit-service's own lookup.
      organizationId: target.organizationId,
      sourceService: 'identity-service',
      sourceTopic: 'rasta.audit.trail.v1',
      sourceEventId: acceptedBody.eventId,
      correlationId: commandCorrelation,
    });
    expect(fix.actorRoles).toContain('SYSTEM_ADMIN');
    expect(fix.changes).toEqual([
      { field: 'outcome', from: 'REFUSED', to: 'SUCCESS' },
      { field: 'credentials.password', from: { redacted: true }, to: { redacted: true } },
    ]);
    expect(JSON.stringify(fix)).not.toContain(secret);

    // The original lists it — and is otherwise exactly what it was.
    const reread = await readOne(systemAdmin, target.id);
    expect(reread.status).toBe(200);
    expect(reread.record.correctedBy).toEqual([fix.id]);
    const { correctedBy: _after, ...rereadWithoutLinks } = reread.record;
    expect(rereadWithoutLinks).toEqual(originalWithoutLinks);

    // ---- idempotency ------------------------------------------------------
    const replay = await systemAdmin.post('/v1/audit-corrections', { body, idempotencyKey: key });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(accepted.body);

    const reused = await systemAdmin.post('/v1/audit-corrections', {
      body: { ...body, reason: 'A different reason, same key' },
      idempotencyKey: key,
    });
    expect(reused.status).toBe(409);
    expect(errorCode(reused.body)).toBe('IDEMPOTENCY_KEY_REUSED');

    const withoutKey = await systemAdmin.post('/v1/audit-corrections', { body });
    expect(withoutKey.status).toBe(400);

    // Still exactly one correction of this record, after the replay and the reuse.
    await sleep(windowMs + 5_000);
    const corrections = await search(systemAdmin, {
      action: 'audit.correction',
      resourceType: 'AuditEvent',
      resourceId: target.id,
    });
    expect(corrections.status).toBe(200);
    expect(corrections.page.items.map((item) => item.id)).toEqual([fix.id]);

    // ---- who may not --------------------------------------------------------
    for (const [label, actor] of [
      ['UNION_ADMIN', platformAdmin],
      ['ORGANIZATION_ADMIN', tenantA],
      ['AUDITOR', auditor],
    ] as const) {
      const refusedCorrection = await actor.post('/v1/audit-corrections', {
        body,
        idempotencyKey: idempotencyKey(`audit-correction-${label}`),
      });
      expect(refusedCorrection.status, label).toBe(403);
    }

    // ---- a target that is not exactly a record ----------------------------
    const unknown = await systemAdmin.post('/v1/audit-corrections', {
      body: {
        ...body,
        auditEventId: `01E2ENOPE${randomUUID().replace(/-/g, '').slice(0, 17).toUpperCase()}`,
      },
      idempotencyKey: idempotencyKey('audit-correction-unknown'),
    });
    const wrongInstant = await systemAdmin.post('/v1/audit-corrections', {
      body: { ...body, occurredAt: new Date(Date.parse(target.occurredAt) + 1).toISOString() },
      idempotencyKey: idempotencyKey('audit-correction-wrong-instant'),
    });
    expect(unknown.status).toBe(404);
    expect(wrongInstant.status).toBe(404);
    // Indistinguishable: the same code and message, and neither names a tenant.
    expect(errorCode(wrongInstant.body)).toBe(errorCode(unknown.body));
    expect((wrongInstant.body as { message?: string }).message).toBe(
      (unknown.body as { message?: string }).message,
    );
    for (const answer of [unknown.body, wrongInstant.body]) {
      expect(JSON.stringify(answer)).not.toContain(ORG.oversight);
    }

    // And the correction is itself evidence nobody below SYSTEM_ADMIN/UNION_ADMIN reads.
    expect((await readOne(auditor, fix.id)).status).toBe(403);
  });
});
