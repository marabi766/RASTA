import { runWithContext, type RequestContext } from '../context/request-context';
import {
  createTenantGuardExtension,
  runUnscoped,
  runWithNestedTenantWrite,
} from './tenant-guard.extension';

const A = 'organization-a';
const B = 'foreign-tenant-do-not-echo';
const context: RequestContext = {
  correlationId: 'correlation',
  requestId: 'request',
  organizationId: A,
  roles: ['SYSTEM_ADMIN'],
  organizationIds: [],
  authType: 'USER',
  startedAt: 0,
};
const relation = (
  name: string,
  type: string,
  isList = true,
  relationFromFields: string[] = [],
) => ({
  name,
  type,
  kind: 'object',
  isList,
  relationFromFields,
});
const datamodel = {
  models: [
    {
      name: 'User',
      fields: [
        relation('memberships', 'Membership'),
        relation('profiles', 'Profile'),
        relation('globalProfile', 'Profile', false),
        relation('inverseMembership', 'Membership', false),
        relation('directMembership', 'Membership', false, ['primaryMembershipId']),
      ],
    },
    { name: 'Profile', fields: [relation('memberships', 'Membership')] },
    {
      name: 'Membership',
      fields: [
        relation('user', 'User', false),
        { name: 'payload', type: 'Json', kind: 'scalar', isList: false },
      ],
    },
  ],
};
const guard = createTenantGuardExtension({ scopedModels: ['Membership'], datamodel }).query
  .$allModels.$allOperations;
const review = {
  relation: 'User.memberships',
  reason: 'Reviewed membership mutation for the acting tenant only',
};
function call(
  operation: string,
  args: Record<string, unknown>,
  model = 'Membership',
  query = jest.fn().mockResolvedValue('ok'),
) {
  return { query, result: runWithContext(context, () => guard({ model, operation, args, query })) };
}
const values = [
  { label: 'scalar acting', value: A, create: true, update: true },
  { label: 'scalar foreign', value: B, create: false, update: false },
  { label: 'set acting', value: { set: A }, create: false, update: true },
  { label: 'set foreign', value: { set: B }, create: false, update: false },
  { label: 'null', value: null, create: false, update: false },
  { label: 'undefined', value: undefined, create: true, update: true },
  { label: 'set undefined', value: { set: undefined }, create: false, update: false },
  { label: 'set null', value: { set: null }, create: false, update: false },
  { label: 'malformed set', value: { set: A, extra: B }, create: false, update: false },
];
const operations = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert-create',
  'upsert-update',
];
describe.each(operations)('%s tenant data matrix', (operation) => {
  it.each(values)('$label', async ({ value, create, update }) => {
    const creating = operation.startsWith('create') || operation === 'upsert-create';
    const row = { organizationId: value };
    const args =
      operation === 'upsert-create'
        ? { where: { id: 'new' }, create: row, update: {} }
        : operation === 'upsert-update'
          ? { where: { id: 'old' }, create: {}, update: row }
          : { where: { id: 'id' }, data: operation.startsWith('createMany') ? [{}, row] : row };
    const { query, result } = call(operation.startsWith('upsert') ? 'upsert' : operation, args);
    if (creating ? create : update) {
      await result;
      expect(query).toHaveBeenCalledTimes(1);
      const actual = query.mock.calls[0]?.[0] as Record<string, unknown>;
      if (operation === 'upsert-create') expect(actual.create).toEqual({ organizationId: A });
      else if (operation.startsWith('createMany'))
        expect(actual.data).toEqual([{ organizationId: A }, { organizationId: A }]);
      else if (operation === 'create') expect(actual.data).toEqual({ organizationId: A });
      else
        expect(actual.where).toEqual({
          id: operation.startsWith('upsert') ? 'old' : 'id',
          organizationId: A,
        });
    } else {
      await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
      expect(query).not.toHaveBeenCalled();
      await result.catch((error: Error) => expect(error.message).not.toContain(B));
    }
  });
});

it.each([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'delete',
  'deleteMany',
])('allows and scopes %s', async (operation) => {
  const { query, result } = call(operation, { where: { id: 'id' } });
  await result;
  expect(query).toHaveBeenCalledWith({ where: { id: 'id', organizationId: A } });
});
it.each(['unknown', 'findRaw', 'aggregateRaw'])(
  'refuses unknown operation %s',
  async (operation) => {
    const { query, result } = call(operation, {});
    await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect(query).not.toHaveBeenCalled();
  },
);
it('fills omitted tenant without mutating caller data', async () => {
  const args = { where: { id: 'id' }, create: {}, update: {} };
  const { query, result } = call('upsert', args);
  await result;
  expect(args.create).toEqual({});
  expect(query.mock.calls[0]?.[0]).toMatchObject({ create: { organizationId: A } });
});
it('checks the inactive upsert branch too', async () => {
  await expect(
    call('upsert', {
      where: { id: 'id' },
      create: { organizationId: B },
      update: { organizationId: B },
    }).result,
  ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
});
it.each([undefined, { ...context, organizationId: undefined }])(
  'platform authority without tenant never bypasses',
  async (ctx) => {
    const query = jest.fn();
    const run = () =>
      guard({ model: 'Membership', operation: 'create', args: { data: {} }, query });
    await expect(ctx ? runWithContext(ctx, run) : run()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(query).not.toHaveBeenCalled();
  },
);

it.each(['create', 'update', 'createMany', 'findMany'])(
  '%s preserves the missing service tenant claim refusal',
  async (operation) => {
    const query = jest.fn();
    await expect(
      runWithContext({ ...context, authType: 'SERVICE', organizationId: undefined }, () =>
        guard({
          model: 'Membership',
          operation,
          args: { data: operation === 'createMany' ? [] : {} },
          query,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_TENANT_CONTEXT_INVALID' });
    expect(query).not.toHaveBeenCalled();
  },
);

const nestedInputs = [
  ['create', { organizationId: A }],
  ['createMany', { data: [{ organizationId: A }] }],
  ['connect', { id: 'child' }],
  ['connectOrCreate', { where: { id: 'child' }, create: { organizationId: A } }],
  ['set', [{ id: 'child' }]],
  ['disconnect', { id: 'child' }],
  ['update', { where: { id: 'child' }, data: {} }],
  ['updateMany', { where: {}, data: {} }],
  ['upsert', { where: { id: 'child' }, create: {}, update: {} }],
  ['delete', { id: 'child' }],
  ['deleteMany', {}],
] as const;
describe.each(nestedInputs)('nested %s', (action, input) => {
  it.each(['User', 'Membership'])(
    'refuses under %s without the relation review',
    async (parent) => {
      const args =
        parent === 'User'
          ? { data: { memberships: { [action]: input } } }
          : { data: { user: { update: { memberships: { [action]: input } } } } };
      const { query, result } = call('update', args, parent);
      await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('with review scopes data and selectors', async () => {
    const query = jest.fn().mockResolvedValue('ok');
    const result = runWithNestedTenantWrite(
      review,
      () => call('update', { data: { memberships: { [action]: input } } }, 'User', query).result,
    );
    if (action === 'set') {
      await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
      expect(query).not.toHaveBeenCalled();
      return;
    }
    await result;
    expect(query).toHaveBeenCalledTimes(1);
    const written = query.mock.calls[0]?.[0].data.memberships[action];
    const row = Array.isArray(written) ? written[0] : written;
    if (action === 'create') expect(row.organizationId).toBe(A);
    else if (action === 'createMany') expect(row.data[0].organizationId).toBe(A);
    else if (['connect', 'set', 'disconnect', 'delete', 'deleteMany'].includes(action))
      expect(row.organizationId).toBe(A);
    else expect(row.where.organizationId).toBe(A);
  });
});
it.each(['create', 'update', 'upsert', 'connectOrCreate'])(
  'review cannot admit foreign %s data',
  async (action) => {
    const foreign = { organizationId: B };
    const input =
      action === 'create'
        ? foreign
        : { where: { id: 'child' }, data: foreign, create: foreign, update: foreign };
    await expect(
      runWithNestedTenantWrite(
        review,
        () => call('update', { data: { memberships: { [action]: input } } }, 'User').result,
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  },
);
it.each(['connect', 'set', 'disconnect', 'delete', 'deleteMany'])(
  'review cannot admit foreign %s selector',
  async (action) => {
    await expect(
      runWithNestedTenantWrite(
        review,
        () =>
          call(
            'update',
            { data: { memberships: { [action]: { id: 'child', organizationId: B } } } },
            'User',
          ).result,
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  },
);
it('descends through multiple unscoped parents and does not inherit another relation review', async () => {
  await expect(
    runWithNestedTenantWrite(
      review,
      () =>
        call('create', { data: { profiles: { create: { memberships: { create: {} } } } } }, 'User')
          .result,
    ),
  ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
});
it('scalar JSON is not a relation', async () => {
  await call('update', { data: { payload: { create: { organizationId: B } } } }).result;
});
it.each([true, null, 'bad'])(
  'even reviewed selector cannot omit its predicate: %s',
  async (value) => {
    await expect(
      runWithNestedTenantWrite(
        review,
        () => call('update', { data: { memberships: { disconnect: value } } }, 'User').result,
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  },
);
it('unknown nested actions refuse', async () => {
  await expect(
    runWithNestedTenantWrite(
      review,
      () => call('update', { data: { memberships: { mystery: {} } } }, 'User').result,
    ),
  ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
});
it('explicit runUnscoped retains cross-tenant writes and logging, including an unscoped parent', async () => {
  const onUnscopedQuery = jest.fn();
  const unscopedGuard = createTenantGuardExtension({
    scopedModels: ['Membership'],
    datamodel,
    onUnscopedQuery,
  }).query.$allModels.$allOperations;
  const args = { data: { memberships: { create: { organizationId: B } } } };
  const query = jest.fn().mockResolvedValue('ok');
  await runUnscoped('Reviewed platform-wide reconciliation without an acting tenant', () =>
    unscopedGuard({ model: 'User', operation: 'update', args, query }),
  );
  expect(query).toHaveBeenCalledWith(args);
  expect(onUnscopedQuery).toHaveBeenCalledTimes(1);
});
it('requires reviewed metadata for all scoped models', () => {
  expect(() => createTenantGuardExtension({ scopedModels: ['Missing'], datamodel })).toThrow();
});
it('requires a meaningful relation review', () => {
  expect(() => runWithNestedTenantWrite({ relation: '', reason: '' }, () => null)).toThrow();
});
it('review does not escape its callback', async () => {
  runWithNestedTenantWrite(review, () => null);
  await expect(
    call('update', { data: { memberships: { create: {} } } }, 'User').result,
  ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
});

it('reviewed nested upsert checks update data independently of its valid create branch', async () => {
  await expect(
    runWithNestedTenantWrite(
      review,
      () =>
        call(
          'update',
          {
            data: {
              memberships: {
                upsert: { where: { id: 'child' }, create: {}, update: { organizationId: B } },
              },
            },
          },
          'User',
        ).result,
    ),
  ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
});
it('reviewed nested createMany validates every row before the query is called', async () => {
  const query = jest.fn();
  await expect(
    runWithNestedTenantWrite(
      review,
      () =>
        call(
          'create',
          {
            data: {
              memberships: { createMany: { data: [{ organizationId: A }, { organizationId: B }] } },
            },
          },
          'User',
          query,
        ).result,
    ),
  ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  expect(query).not.toHaveBeenCalled();
});
it('reviewed nested upsert filters its selector and fills the create tenant', async () => {
  const query = jest.fn().mockResolvedValue('ok');
  await runWithNestedTenantWrite(
    review,
    () =>
      call(
        'update',
        {
          data: {
            memberships: {
              upsert: {
                where: { id: 'child' },
                create: {},
                update: { organizationId: { set: A } },
              },
            },
          },
        },
        'User',
        query,
      ).result,
  );
  expect(query.mock.calls[0]?.[0].data.memberships.upsert).toEqual({
    where: { id: 'child', organizationId: A },
    create: { organizationId: A },
    update: { organizationId: { set: A } },
  });
});
it('reviewed empty set also refuses its implicit disconnect of foreign rows', async () => {
  await expect(
    runWithNestedTenantWrite(
      review,
      () => call('update', { data: { memberships: { set: [] } } }, 'User').result,
    ),
  ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
});
it.each(['create', 'connect', 'connectOrCreate', 'upsert'])(
  'inverse to-one %s refuses even with review',
  async (action) => {
    const query = jest.fn();
    await expect(
      runWithNestedTenantWrite(
        { ...review, relation: 'User.inverseMembership' },
        () =>
          call('update', { data: { inverseMembership: { [action]: {} } } }, 'User', query).result,
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect(query).not.toHaveBeenCalled();
  },
);
it.each(['create', 'connect', 'connectOrCreate', 'upsert'])(
  'owning to-one %s also refuses implicit replacement',
  async (action) => {
    const query = jest.fn();
    await expect(
      runWithNestedTenantWrite(
        { ...review, relation: 'User.directMembership' },
        () =>
          call('update', { data: { directMembership: { [action]: {} } } }, 'User', query).result,
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect(query).not.toHaveBeenCalled();
  },
);
it('reviewed to-one update can constrain the existing child without replacing the relation', async () => {
  const query = jest.fn().mockResolvedValue('ok');
  await runWithNestedTenantWrite(
    { ...review, relation: 'User.directMembership' },
    () =>
      call(
        'update',
        { data: { directMembership: { update: { organizationId: A } } } },
        'User',
        query,
      ).result,
  );
  expect(query.mock.calls[0]?.[0].data.directMembership.update).toEqual({
    where: { organizationId: A },
    data: { organizationId: A },
  });
});
it('to-one connect from a tenant model to a global target cannot evict another tenant parent', async () => {
  const { query, result } = call('update', { data: { user: { connect: { id: 'global-user' } } } });
  await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  expect(query).not.toHaveBeenCalled();
});
it('global-to-global relations retain their tenantless platform semantics', async () => {
  const query = jest.fn().mockResolvedValue('ok');
  const args = { data: { globalProfile: { connect: { id: 'global-profile' } } } };
  await guard({ model: 'User', operation: 'update', args, query });
  expect(query).toHaveBeenCalledWith(args);
});
describe.each(['createMany', 'createManyAndReturn'])('%s empty batches', (operation) => {
  it.each([
    { label: 'no request context', ctx: undefined },
    {
      label: 'platform authority without a tenant',
      ctx: { ...context, organizationId: undefined },
    },
  ])('still refuses $label', async ({ ctx }) => {
    const query = jest.fn().mockResolvedValue([]);
    const run = () => guard({ model: 'Membership', operation, args: { data: [] }, query });
    await expect(ctx ? runWithContext(ctx, run) : run()).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(query).not.toHaveBeenCalled();
  });
});
