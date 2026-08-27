import {
  createTenantGuardExtension,
  injectTenantFilter,
  injectTenantOnCreate,
  runUnscoped,
  isUnscoped,
  assertTenantOwned,
} from './tenant-guard.extension';
import { runWithContext, type RequestContext } from '../context/request-context';

const ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
const ORG_B = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YB';

function contextFor(organizationId?: string): RequestContext {
  return {
    correlationId: '01JBQ8Z4K7M2N5P8R1T3V6X9Y2',
    requestId: '01JBQ8Z4K7M2N5P8R1T3V6X9Y3',
    organizationId,
    roles: ['FLEET_MANAGER'],
    authType: 'USER',
    startedAt: 0,
  };
}

describe('injectTenantFilter', () => {
  it('adds the tenant to an empty where clause', () => {
    expect(injectTenantFilter({}, 'organizationId', ORG_A)).toEqual({
      where: { organizationId: ORG_A },
    });
  });

  it('preserves other filters', () => {
    const result = injectTenantFilter(
      { where: { status: 'ACTIVE' }, take: 25 },
      'organizationId',
      ORG_A,
    );
    expect(result).toEqual({ where: { status: 'ACTIVE', organizationId: ORG_A }, take: 25 });
  });

  it('allows a matching explicit tenant', () => {
    const result = injectTenantFilter(
      { where: { organizationId: ORG_A } },
      'organizationId',
      ORG_A,
    );
    expect(result).toEqual({ where: { organizationId: ORG_A } });
  });

  it('throws on a mismatched explicit tenant rather than overwriting it', () => {
    // Silently overwriting would hide the bug; letting it through would be the
    // leak. Failing is the only honest option.
    expect(() =>
      injectTenantFilter({ where: { organizationId: ORG_B } }, 'organizationId', ORG_A),
    ).toThrow(/runUnscoped/);
  });
});

describe('injectTenantOnCreate', () => {
  it('stamps the tenant onto a single row', () => {
    const result = injectTenantOnCreate({ data: { name: 'Grader' } }, 'organizationId', ORG_A);
    expect(result).toEqual({ data: { name: 'Grader', organizationId: ORG_A } });
  });

  it('stamps the tenant onto every row of a createMany', () => {
    const result = injectTenantOnCreate(
      { data: [{ name: 'A' }, { name: 'B' }] },
      'organizationId',
      ORG_A,
    );
    expect(result.data).toEqual([
      { name: 'A', organizationId: ORG_A },
      { name: 'B', organizationId: ORG_A },
    ]);
  });

  it('refuses to create a row for another tenant', () => {
    expect(() =>
      injectTenantOnCreate({ data: { organizationId: ORG_B } }, 'organizationId', ORG_A),
    ).toThrow(/never implicit/);
  });
});

describe('createTenantGuardExtension', () => {
  const extension = createTenantGuardExtension({ scopedModels: ['Asset', 'UsageRecord'] });
  const allOperations = extension.query.$allModels.$allOperations;

  it('scopes a read against a tenant-scoped model', async () => {
    const query = jest.fn().mockResolvedValue([]);

    await runWithContext(contextFor(ORG_A), () =>
      allOperations({ model: 'Asset', operation: 'findMany', args: { where: {} }, query }),
    );

    expect(query).toHaveBeenCalledWith({ where: { organizationId: ORG_A } });
  });

  it('scopes findUnique too', async () => {
    // Prisma 5+ accepts non-unique filters alongside the unique field, so the
    // unique lookup does not escape the boundary.
    const query = jest.fn().mockResolvedValue(null);

    await runWithContext(contextFor(ORG_A), () =>
      allOperations({
        model: 'Asset',
        operation: 'findUnique',
        args: { where: { id: 'AST_1' } },
        query,
      }),
    );

    expect(query).toHaveBeenCalledWith({ where: { id: 'AST_1', organizationId: ORG_A } });
  });

  it('leaves models outside the scoped list untouched', async () => {
    const query = jest.fn().mockResolvedValue([]);

    await runWithContext(contextFor(ORG_A), () =>
      allOperations({ model: 'Role', operation: 'findMany', args: { where: {} }, query }),
    );

    expect(query).toHaveBeenCalledWith({ where: {} });
  });

  it('throws rather than running unscoped when there is no request context', async () => {
    // This is the property that matters most. A missing tenant must be a loud
    // failure, never a query that quietly returns every organization's rows.
    const query = jest.fn();

    await expect(
      allOperations({ model: 'Asset', operation: 'findMany', args: {}, query }),
    ).rejects.toThrow(/No RequestContext/);

    expect(query).not.toHaveBeenCalled();
  });

  it('throws when the context has no organization', async () => {
    const query = jest.fn();

    await expect(
      runWithContext(contextFor(undefined), () =>
        allOperations({ model: 'Asset', operation: 'findMany', args: {}, query }),
      ),
    ).rejects.toThrow(/tenant-scoped data was accessed/);

    expect(query).not.toHaveBeenCalled();
  });

  it('honours an explicit unscoped block and reports it', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const onUnscopedQuery = jest.fn();
    const auditing = createTenantGuardExtension({ scopedModels: ['Asset'], onUnscopedQuery });

    await runWithContext(contextFor(ORG_A), () =>
      runUnscoped('platform-wide asset census for the governance dashboard', () =>
        auditing.query.$allModels.$allOperations({
          model: 'Asset',
          operation: 'findMany',
          args: { where: {} },
          query,
        }),
      ),
    );

    expect(query).toHaveBeenCalledWith({ where: {} });
    expect(onUnscopedQuery).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'Asset', operation: 'findMany' }),
    );
  });
});

describe('runUnscoped', () => {
  it('requires a meaningful written reason', () => {
    expect(() => runUnscoped('', () => null)).toThrow(/written reason/);
    expect(() => runUnscoped('because', () => null)).toThrow(/written reason/);
  });

  it('does not leak the escape outside its callback', () => {
    runUnscoped('platform-wide reconciliation job', () => {
      expect(isUnscoped()).toBe(true);
    });
    expect(isUnscoped()).toBe(false);
  });

  it('holds the scope open for a lazily-executed query', async () => {
    // A Prisma query runs nothing until something calls `.then` on it. If the
    // scope closed before that happened, the query would execute *scoped* and
    // silently return no rows — code that reads as correct and is not.
    let executedUnscoped: boolean | undefined;

    // Shaped like a PrismaPromise: inert until something calls `then`.
    const lazy = {
      then(resolve: (value: string) => void) {
        executedUnscoped = isUnscoped();
        resolve('ran');
      },
    };

    const result = await runUnscoped('platform-wide reconciliation job', () => lazy);

    expect(result).toBe('ran');
    expect(executedUnscoped).toBe(true);
    expect(isUnscoped()).toBe(false);
  });

  it('keeps the scope for an async callback that awaits inside', async () => {
    let insideAfterAwait: boolean | undefined;

    await runUnscoped('platform-wide reconciliation job', async () => {
      await Promise.resolve();
      insideAfterAwait = isUnscoped();
    });

    expect(insideAfterAwait).toBe(true);
  });

  it('propagates a rejection rather than swallowing it', async () => {
    await expect(
      runUnscoped('platform-wide reconciliation job', () =>
        Promise.reject(new Error('query failed')),
      ),
    ).rejects.toThrow('query failed');
  });
});

describe('assertTenantOwned', () => {
  it('passes for a row owned by the requesting tenant', () => {
    runWithContext(contextFor(ORG_A), () => {
      expect(() => assertTenantOwned({ organizationId: ORG_A }, 'Asset')).not.toThrow();
    });
  });

  it('throws for a row owned by another tenant', () => {
    runWithContext(contextFor(ORG_A), () => {
      expect(() => assertTenantOwned({ organizationId: ORG_B }, 'Asset')).toThrow(
        /Tenant boundary violation/,
      );
    });
  });
});
