import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import type { Logger } from '@rasta/logging';
import { AuditQueryService } from './audit.query.service';
import type { AuditReadScope, AuditRepository, AuditSearchFilters } from './audit.repository';
import { decodeAuditCursor, encodeAuditCursor } from './audit.cursor';
import type { AuditEventQuery, AuditEventDetailQuery } from './audit.query.dto';
import type { AuditEventRow } from './audit.view';
import { AuditEventQueryPipe } from './audit.query.pipes';
import type { AuditEnv } from '../config/env';

/**
 * The read model, asserted where its authorization decision is actually taken.
 *
 * Three properties are under test and each one is the answer to a specific way
 * a query API leaks:
 *
 *   **Scope comes from the token.** `organizationId` in the query string is a
 *   request to narrow or to target, never a grant (ADR-053 § 10, defect D-2).
 *
 *   **A subtree is proved, never assumed.** The projection can only *extend*
 *   authority beyond the token's own organization, and it extends nothing it
 *   cannot prove — so a stale, missing or broken relation produces a missing
 *   result, never an extra one.
 *
 *   **The repository is never reached by a request that should not run.** A
 *   refused caller and an invalid window both cost zero queries, which is what
 *   makes the mandatory window a denial-of-service control rather than a
 *   formality.
 */

const UNION = 'ORG-UNION';
const CHILD = 'ORG-CHILD';
const SIBLING = 'ORG-SIBLING';

const FROM = new Date('2026-08-01T00:00:00.000Z');
const TO = new Date('2026-08-31T00:00:00.000Z');

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    requestId: 'req-1',
    correlationId: 'corr-1',
    authType: 'USER',
    roles: [],
    startedAt: 0,
    ...overrides,
  } as RequestContext;
}

const as = <T>(overrides: Partial<RequestContext>, fn: () => Promise<T>): Promise<T> =>
  runWithContext(context(overrides), fn);

function auditRow(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: '01JAUDIT0000000000000001',
    occurredAt: new Date('2026-08-15T12:00:00.000Z'),
    recordedAt: new Date('2026-08-15T12:00:01.000Z'),
    actorType: 'USER',
    actorId: 'USR-1',
    actorRoles: [],
    organizationId: CHILD,
    action: 'asset.decommissioned',
    resourceType: 'Asset',
    resourceId: 'AST-1',
    outcome: 'SUCCESS',
    errorCode: null,
    reason: null,
    changes: null,
    occurrenceCount: 1,
    sourceService: 'asset-service',
    sourceServiceVersion: '1.0.0',
    sourceEventId: '01JEVENT0000000000000001',
    sourceEventName: 'ASSET_DECOMMISSIONED',
    sourceTopic: 'rasta.asset.v1',
    sourceIp: null,
    sourceUserAgent: null,
    correlationId: 'corr-1',
    causationId: null,
    traceparent: null,
    sourceStreamSeq: null,
    sequenceNo: 42n,
    ...overrides,
  };
}

interface RepositoryStub {
  readonly searchCalls: { scope: AuditReadScope; filters: AuditSearchFilters }[];
  readonly detailCalls: { scope: AuditReadScope; id: string }[];
  readonly subtreeCalls: { root: string; target: string }[];
  repository: AuditRepository;
}

function stubRepository(options: {
  rows?: AuditEventRow[];
  hasMore?: boolean;
  detail?: AuditEventRow | null;
  descendants?: readonly string[];
  subtreeThrows?: boolean;
}): RepositoryStub {
  const searchCalls: { scope: AuditReadScope; filters: AuditSearchFilters }[] = [];
  const detailCalls: { scope: AuditReadScope; id: string }[] = [];
  const subtreeCalls: { root: string; target: string }[] = [];

  const repository = {
    search: async (scope: AuditReadScope, filters: AuditSearchFilters) => {
      searchCalls.push({ scope, filters });
      return { rows: options.rows ?? [], hasMore: options.hasMore ?? false };
    },
    findById: async (scope: AuditReadScope, id: string) => {
      detailCalls.push({ scope, id });
      return options.detail ?? null;
    },
    isWithinProjectedSubtree: async (root: string, target: string) => {
      subtreeCalls.push({ root, target });
      if (options.subtreeThrows) throw new Error('projection unavailable');
      return (options.descendants ?? []).includes(target);
    },
  } as unknown as AuditRepository;

  return { searchCalls, detailCalls, subtreeCalls, repository };
}

/**
 * A repository that fails the test if it is touched at all.
 *
 * The positive assertion for "nothing runs before the decision": a refusal that
 * had already issued a query would still answer 403, and no status-code
 * assertion anywhere could tell the difference.
 */
const forbiddenRepository = new Proxy({} as AuditRepository, {
  get(_target, property) {
    return () => {
      throw new Error(`the repository was reached: ${String(property)}`);
    };
  },
});

const query = (overrides: Partial<AuditEventQuery> = {}): AuditEventQuery => ({
  from: FROM,
  to: TO,
  limit: 25,
  ...overrides,
});

const detailQuery = (overrides: Partial<AuditEventDetailQuery> = {}): AuditEventDetailQuery => ({
  from: FROM,
  to: TO,
  ...overrides,
});

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isRastaError(error)) return error.code;
    return `NOT_A_PLATFORM_ERROR: ${String(error)}`;
  }
  return 'NO_ERROR';
}

describe('SYSTEM_ADMIN scope', () => {
  it('queries every tenant when it names no organization', async () => {
    const stub = stubRepository({});
    const service = new AuditQueryService(stub.repository, silentLogger);

    await as({ roles: ['SYSTEM_ADMIN'] }, () => service.search(query()));

    expect(stub.searchCalls[0]?.scope).toEqual({ kind: 'PLATFORM', organizationId: undefined });
  });

  it('narrows to exactly the organization it names', async () => {
    const stub = stubRepository({});
    const service = new AuditQueryService(stub.repository, silentLogger);

    await as({ roles: ['SYSTEM_ADMIN'] }, () => service.search(query({ organizationId: SIBLING })));

    expect(stub.searchCalls[0]?.scope).toEqual({ kind: 'PLATFORM', organizationId: SIBLING });
  });

  it('consults no projection at all', async () => {
    // Platform authority has no root, so there is no subtree to prove. A
    // projection lookup here would make a cross-tenant read depend on a replica.
    const stub = stubRepository({ descendants: [] });
    const service = new AuditQueryService(stub.repository, silentLogger);

    await as({ roles: ['SYSTEM_ADMIN'] }, () => service.search(query({ organizationId: SIBLING })));

    expect(stub.subtreeCalls).toHaveLength(0);
  });
});

describe('UNION_ADMIN scope', () => {
  it('defaults to its own organization when it names none', async () => {
    // The narrow reading that satisfies both ADR-053 § 10 ("its own
    // organization and its subtree") and § 6.4 of the implementation plan (a
    // search *without* `organizationId` succeeds and contains no other
    // tenant's rows). Widening a silent default is how a convenience becomes a
    // disclosure.
    const stub = stubRepository({ descendants: [CHILD] });
    const service = new AuditQueryService(stub.repository, silentLogger);

    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () => service.search(query()));

    expect(stub.searchCalls[0]?.scope).toEqual({ kind: 'ORGANIZATION', organizationId: UNION });
    expect(stub.subtreeCalls).toHaveLength(0);
  });

  it('answers its own organization from the token, not from the projection', async () => {
    // The fail-closed hinge: a caller's authority over their own organization
    // must not evaporate because an event for it has not been consumed yet.
    const stub = stubRepository({ descendants: [] });
    const service = new AuditQueryService(stub.repository, silentLogger);

    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      service.search(query({ organizationId: UNION })),
    );

    expect(stub.searchCalls[0]?.scope).toEqual({ kind: 'ORGANIZATION', organizationId: UNION });
    expect(stub.subtreeCalls).toHaveLength(0);
  });

  it('reaches a child the projection proves is beneath it', async () => {
    const stub = stubRepository({ descendants: [CHILD] });
    const service = new AuditQueryService(stub.repository, silentLogger);

    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      service.search(query({ organizationId: CHILD })),
    );

    expect(stub.subtreeCalls).toEqual([{ root: UNION, target: CHILD }]);
    expect(stub.searchCalls[0]?.scope).toEqual({ kind: 'ORGANIZATION', organizationId: CHILD });
  });

  it('refuses a sibling, and issues no query for it', async () => {
    const stub = stubRepository({ descendants: [CHILD] });
    const service = new AuditQueryService(stub.repository, silentLogger);

    const code = await codeOf(() =>
      as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
        service.search(query({ organizationId: SIBLING })),
      ),
    );

    expect(code).toBe('FORBIDDEN');
    expect(stub.searchCalls).toHaveLength(0);
  });

  it('refuses an organization the projection has never heard of', async () => {
    // A missing projection is a refusal, never a wider answer. This is the
    // stale-replica property ADR-053 § 10 states, asserted from the direction
    // that would be a disclosure if it were wrong.
    const stub = stubRepository({ descendants: [] });
    const service = new AuditQueryService(stub.repository, silentLogger);

    expect(
      await codeOf(() =>
        as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
          service.search(query({ organizationId: 'ORG-NEVER-SEEN' })),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(stub.searchCalls).toHaveLength(0);
  });

  it('refuses every out-of-subtree target with the same error', async () => {
    // A sibling, a stranger and one that moved out must be indistinguishable.
    // Telling them apart lets a caller map the hierarchy by probing.
    const stub = stubRepository({ descendants: [CHILD] });
    const service = new AuditQueryService(stub.repository, silentLogger);

    const messages: string[] = [];
    for (const target of [SIBLING, 'ORG-STRANGER', 'ORG-MOVED-OUT']) {
      try {
        await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
          service.search(query({ organizationId: target })),
        );
      } catch (error) {
        messages.push((error as Error).message);
      }
    }

    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).not.toContain(SIBLING);
  });

  it('never produces a scope that could match a null-tenant row', async () => {
    // The specific mistake ADR-053 § 10 names: `organizationId = $1 OR
    // organizationId IS NULL`. A subtree caller always resolves to exactly one
    // organization, so there is no shape here that could admit one.
    const stub = stubRepository({ descendants: [CHILD] });
    const service = new AuditQueryService(stub.repository, silentLogger);

    for (const requested of [undefined, UNION, CHILD]) {
      await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
        service.search(query({ organizationId: requested })),
      );
    }

    for (const call of stub.searchCalls) {
      expect(call.scope.kind).toBe('ORGANIZATION');
      expect(typeof call.scope.organizationId).toBe('string');
    }
  });

  it('lets a projection failure refuse rather than widen', async () => {
    // If the projection cannot answer, nothing is proved, so nothing is
    // granted. The error surfaces; it does not become an allow.
    const stub = stubRepository({ subtreeThrows: true });
    const service = new AuditQueryService(stub.repository, silentLogger);

    await expect(
      as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
        service.search(query({ organizationId: CHILD })),
      ),
    ).rejects.toThrow('projection unavailable');
    expect(stub.searchCalls).toHaveLength(0);
  });
});

describe('roles that reach nothing', () => {
  const REFUSED: { label: string; claims: Partial<RequestContext> }[] = [
    { label: 'AUDITOR', claims: { roles: ['AUDITOR'], organizationId: UNION } },
    { label: 'AUDITOR beside an allowed role', claims: { roles: ['SYSTEM_ADMIN', 'AUDITOR'] } },
    {
      label: 'ORGANIZATION_ADMIN',
      claims: { roles: ['ORGANIZATION_ADMIN'], organizationId: UNION },
    },
    { label: 'a service token', claims: { authType: 'SERVICE', roles: ['SYSTEM_ADMIN'] } },
    { label: 'an unlisted role', claims: { roles: ['FLEET_MANAGER'], organizationId: UNION } },
    { label: 'no role at all', claims: { roles: [] } },
    {
      label: 'a UNION_ADMIN whose token names no organization',
      claims: { roles: ['UNION_ADMIN'] },
    },
  ];

  it.each(REFUSED)('refuses $label without touching the repository', async ({ claims }) => {
    const service = new AuditQueryService(forbiddenRepository, silentLogger);

    expect(await codeOf(() => as(claims, () => service.search(query())))).toBe('FORBIDDEN');
    expect(await codeOf(() => as(claims, () => service.findOne('01JAUDIT', detailQuery())))).toBe(
      'FORBIDDEN',
    );
  });
});

describe('paging', () => {
  it('mints a cursor only when another page exists', async () => {
    // A cursor handed out at the end of a result set invites a client to loop
    // forever on an empty page.
    const last = auditRow({ id: '01JLAST', occurredAt: new Date('2026-08-10T00:00:00.000Z') });
    const service = new AuditQueryService(
      stubRepository({ rows: [auditRow(), last], hasMore: true }).repository,
      silentLogger,
    );

    const page = await as({ roles: ['SYSTEM_ADMIN'] }, () => service.search(query()));

    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeAuditCursor(page.nextCursor as string)).toEqual({
      occurredAt: last.occurredAt,
      id: last.id,
    });
  });

  it('returns a null cursor on the last page', async () => {
    const service = new AuditQueryService(
      stubRepository({ rows: [auditRow()], hasMore: false }).repository,
      silentLogger,
    );

    const page = await as({ roles: ['SYSTEM_ADMIN'] }, () => service.search(query()));

    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('returns a null cursor for an empty result', async () => {
    const service = new AuditQueryService(stubRepository({}).repository, silentLogger);

    const page = await as({ roles: ['SYSTEM_ADMIN'] }, () => service.search(query()));

    expect(page.nextCursor).toBeNull();
  });

  it('passes a supplied cursor to the repository unchanged', async () => {
    const position = { occurredAt: new Date('2026-08-10T00:00:00.000Z'), id: '01JLAST' };
    const stub = stubRepository({});
    const service = new AuditQueryService(stub.repository, silentLogger);

    await as({ roles: ['SYSTEM_ADMIN'] }, () => service.search(query({ cursor: position })));

    expect(stub.searchCalls[0]?.filters.cursor).toEqual(position);
  });

  it('does not let a cursor change the scope it pages within', async () => {
    // A cursor is a value the client holds and can edit. Scope is recomputed
    // from the verified token on every request, so a cursor minted from another
    // tenant's page moves the caller inside their own result set and nowhere
    // else.
    const foreign = encodeAuditCursor({
      occurredAt: new Date('2026-08-10T00:00:00.000Z'),
      id: '01JFOREIGN',
    });
    const stub = stubRepository({ descendants: [] });
    const service = new AuditQueryService(stub.repository, silentLogger);

    await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      service.search(query({ cursor: decodeAuditCursor(foreign) })),
    );

    expect(stub.searchCalls[0]?.scope).toEqual({ kind: 'ORGANIZATION', organizationId: UNION });
  });
});

describe('reading one record', () => {
  it('returns the record inside the caller scope', async () => {
    const stub = stubRepository({ detail: auditRow({ organizationId: UNION }) });
    const service = new AuditQueryService(stub.repository, silentLogger);

    const view = await as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
      service.findOne('01JAUDIT0000000000000001', detailQuery()),
    );

    expect(view.id).toBe('01JAUDIT0000000000000001');
    // The 64-bit column leaves as a string, from the same mapper the list uses.
    expect(view.sequenceNo).toBe('42');
    expect(stub.detailCalls[0]?.scope).toEqual({ kind: 'ORGANIZATION', organizationId: UNION });
  });

  it('answers 404 for a record another tenant owns, exactly as for an unknown id', async () => {
    // The repository returns null for both, so a 403 here is not merely
    // discouraged — it is unreachable. A 403 would confirm the record exists.
    const stub = stubRepository({ detail: null });
    const service = new AuditQueryService(stub.repository, silentLogger);

    expect(
      await codeOf(() =>
        as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
          service.findOne('01JSOMEONEELSES', detailQuery()),
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await codeOf(() =>
        as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
          service.findOne('01JDOESNOTEXIST', detailQuery()),
        ),
      ),
    ).toBe('NOT_FOUND');
  });

  it('puts no identifier in the message a client sees', async () => {
    const stub = stubRepository({ detail: null });
    const service = new AuditQueryService(stub.repository, silentLogger);

    try {
      await as({ roles: ['SYSTEM_ADMIN'] }, () => service.findOne('01JSECRETID', detailQuery()));
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).not.toContain('01JSECRETID');
    }
  });

  it('refuses a detail lookup outside the subtree before any lookup runs', async () => {
    const stub = stubRepository({ descendants: [CHILD], detail: auditRow() });
    const service = new AuditQueryService(stub.repository, silentLogger);

    expect(
      await codeOf(() =>
        as({ roles: ['UNION_ADMIN'], organizationId: UNION }, () =>
          service.findOne('01JAUDIT', detailQuery({ organizationId: SIBLING })),
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(stub.detailCalls).toHaveLength(0);
  });
});

describe('what a query writes down', () => {
  it('logs shape and never a filter value', async () => {
    // AGENTS.md S-09 and ADR-053 § 13. A log aggregator has none of the audit
    // store's access controls, so "who searched for whom" written into it would
    // be a second, unprotected copy of the sensitive half of the question.
    const lines: string[] = [];
    const logger = {
      ...silentLogger,
      info: (line: string) => lines.push(line),
    } as unknown as Logger;
    const stub = stubRepository({ rows: [auditRow()] });
    const service = new AuditQueryService(stub.repository, logger);

    await as({ roles: ['SYSTEM_ADMIN'] }, () =>
      service.search(
        query({
          organizationId: 'ORG-SENSITIVE',
          actorId: 'USR-SENSITIVE',
          resourceType: 'Asset',
          resourceId: 'AST-SENSITIVE',
          correlationId: 'CORR-SENSITIVE',
        }),
      ),
    );

    const text = lines.join('\n');
    expect(text).not.toBe('');
    for (const value of ['ORG-SENSITIVE', 'USR-SENSITIVE', 'AST-SENSITIVE', 'CORR-SENSITIVE']) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('scope=platform');
    expect(text).toContain('rows=1');
  });
});

/**
 * Only `AUDIT_MAX_QUERY_WINDOW_DAYS` is read by these pipes, so the rest of the
 * environment is not invented here — a partial object cast once, in one place,
 * rather than a fake deployment config each test would have to keep in step.
 */
function envWithWindow(days: number): AuditEnv {
  return { AUDIT_MAX_QUERY_WINDOW_DAYS: days } as AuditEnv;
}

describe('validation finishes before the repository is reachable', () => {
  /**
   * The ordering is structural rather than conventional: Nest runs the pipe
   * before the handler is entered, so a handler either receives an already
   * valid value or is never called. Asserted here from the pipe's side, and
   * again in `test/authorization.int-spec.ts` through the real router.
   */
  // The pipe reads its ceiling off the injected environment rather than a bare
  // constructor number — a `number` parameter has no injection token, so Nest
  // could not construct the pipe it resolves from `@Query(AuditEventQueryPipe)`.
  const pipe = new AuditEventQueryPipe(envWithWindow(90));
  const metadata = { type: 'query' as const };

  it('refuses an over-wide window with a validation failure naming the ceiling', () => {
    try {
      pipe.transform(
        { from: '2026-01-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
        metadata,
      );
      throw new Error('expected a validation failure');
    } catch (error) {
      expect(isRastaError(error) && error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(isRastaError(error) ? error.details : [])).toContain(
        'AUDIT_MAX_QUERY_WINDOW_DAYS',
      );
    }
  });

  it('refuses a missing window', () => {
    expect(() => pipe.transform({}, metadata)).toThrow();
  });

  it('passes a valid window through as parsed values', () => {
    const parsed = pipe.transform(
      { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' },
      metadata,
    );

    expect(parsed.from).toEqual(FROM);
    expect(parsed.to).toEqual(TO);
    expect(parsed.limit).toBe(25);
  });

  it('names the deployment ceiling rather than the default', () => {
    try {
      new AuditEventQueryPipe(envWithWindow(7)).transform(
        { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' },
        metadata,
      );
      throw new Error('expected a validation failure');
    } catch (error) {
      const details = JSON.stringify(isRastaError(error) ? error.details : []);
      expect(details).toContain('7 days');
      expect(details).not.toContain('90 days');
    }
  });
});
