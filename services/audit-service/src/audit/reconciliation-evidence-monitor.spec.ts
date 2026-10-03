import { currentUnscopedReason, isUnscoped } from '@rasta/nest-common';
import type { PrismaService } from '../prisma/prisma.service';
import { auditReconciliationEvidenceMissing } from '../observability/metrics';
import { AuditRepository } from './audit.repository';
import { ReconciliationEvidenceMonitor } from './reconciliation-evidence-monitor';

/**
 * The shape of D-046's cross-tenant read (Codex on #204, round 2).
 *
 * The real query runs against PostgreSQL in
 * `test/payment-reconciliation-evidence.int-spec.ts`. What is pinned here is
 * what that suite cannot see: the crossing is made through the named
 * `runUnscoped` path, and nothing but one number leaves it.
 */
describe('countMissingReconciliationEvidence — the unscoped, aggregate-only read', () => {
  interface Seen {
    sql: string;
    values: unknown[];
    unscoped: boolean;
    reason: string | undefined;
  }

  function repositoryReturning(rows: unknown[]): { repository: AuditRepository; seen: Seen[] } {
    const seen: Seen[] = [];
    const client = {
      // A tagged template, as Prisma's `$queryRaw` receives it. It records the
      // unscoped state at the moment the query is issued, which is the moment
      // that matters.
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        seen.push({
          sql: strings.join('?'),
          values,
          unscoped: isUnscoped(),
          reason: currentUnscopedReason(),
        });
        return Promise.resolve(rows);
      },
    };
    return {
      repository: new AuditRepository({ client } as unknown as PrismaService),
      seen,
    };
  }

  it('runs under runUnscoped with a written reason', async () => {
    const { repository, seen } = repositoryReturning([{ missing: 0n }]);
    await repository.countMissingReconciliationEvidence(new Date('2026-10-01T00:00:00.000Z'));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.unscoped).toBe(true);
    expect(seen[0]?.reason).toMatch(/D-046/);
    // The scope closes with the call: nothing after it inherits the crossing.
    expect(isUnscoped()).toBe(false);
  });

  it('selects one count and nothing else — no row, id, tenant or name', async () => {
    const { repository, seen } = repositoryReturning([{ missing: 3n }]);
    const result = await repository.countMissingReconciliationEvidence(
      new Date('2026-10-01T00:00:00.000Z'),
    );

    expect(result).toBe(3);
    expect(typeof result).toBe('number');

    const sql = seen[0]?.sql.replace(/\s+/g, ' ') ?? '';
    const selectList = sql.slice(sql.indexOf('SELECT') + 'SELECT'.length, sql.indexOf(' FROM '));
    expect(selectList.trim()).toBe('count(*) AS missing');
    expect(sql).not.toMatch(/GROUP BY/i);
  });

  it('windows on recorded_at, never occurred_at', async () => {
    const since = new Date('2026-10-01T00:00:00.000Z');
    const { repository, seen } = repositoryReturning([{ missing: 0n }]);
    await repository.countMissingReconciliationEvidence(since);

    const sql = seen[0]?.sql ?? '';
    expect(sql).toMatch(/a\.recorded_at >= \?/);
    expect(sql).not.toMatch(/occurred_at/);
    expect(seen[0]?.values).toContain(since);
  });

  it('exports one unlabelled series', async () => {
    const { repository } = repositoryReturning([{ missing: 2n }]);
    const monitor = new ReconciliationEvidenceMonitor(repository, {
      AUDIT_RECONCILIATION_EVIDENCE_LOOKBACK_HOURS: 24,
    } as never);

    expect(await monitor.sample(new Date('2026-10-03T12:00:00.000Z'))).toBe(2);
    const { values } = await auditReconciliationEvidenceMissing.get();
    expect(values).toEqual([expect.objectContaining({ value: 2, labels: {} })]);
  });

  it('looks back from now by the configured hours', async () => {
    const { repository, seen } = repositoryReturning([{ missing: 0n }]);
    const monitor = new ReconciliationEvidenceMonitor(repository, {
      AUDIT_RECONCILIATION_EVIDENCE_LOOKBACK_HOURS: 24,
    } as never);

    await monitor.sample(new Date('2026-10-03T12:00:00.000Z'));
    expect(seen[0]?.values).toContainEqual(new Date('2026-10-02T12:00:00.000Z'));
  });
});
