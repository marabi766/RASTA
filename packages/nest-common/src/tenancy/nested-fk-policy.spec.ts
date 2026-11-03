import { runWithContext, type RequestContext } from '../context/request-context';
import {
  createTenantGuardExtension,
  runWithNestedTenantWrite,
  type TenantDatamodel,
} from './tenant-guard.extension';
import type { ScalarFkFamily } from './scalar-relation-policy';

const context: RequestContext = {
  correlationId: 'nested-fk',
  requestId: 'nested-fk',
  organizationId: 'A',
  roles: [],
  organizationIds: [],
  authType: 'USER',
  startedAt: 0,
};
const inputs = {
  create: {},
  createMany: { data: [{}] },
  connect: { id: 'target' },
  connectOrCreate: { where: { id: 'target' }, create: {} },
  upsert: { where: { id: 'target' }, create: {}, update: {} },
  set: [],
  disconnect: { id: 'target' },
};
function metadata(parent: string, child: string, composite = false): TenantDatamodel {
  const inverse = {
    name: 'children',
    type: child,
    kind: 'object',
    isList: true,
    relationName: 'Link',
  };
  const owner = {
    ...inverse,
    name: 'owner',
    type: parent,
    isList: false,
    relationFromFields: composite ? ['organizationId', 'parentId'] : ['parentId'],
    relationToFields: composite ? ['organizationId', 'id'] : ['id'],
  };
  return {
    models: [
      { name: parent, fields: [inverse] },
      { name: child, fields: [owner] },
    ],
  };
}

const cases = [
  ['asset', 'Asset.documents', 'AssetDocumentRef.asset', true, false],
  ['marketplace', 'Order.lines', 'OrderLine.order', true, false],
  ['identity', 'Role.permissions', 'RolePermission.role', false, false],
  ['identity', 'Role.permissions', 'RolePermission.role', false, true],
  ['identity', 'Permission.roles', 'RolePermission.permission', false, true],
] as const;
type Scenario = (typeof cases)[number];

function attempt(
  scenario: Scenario,
  action: string,
  input: unknown,
  family: ScalarFkFamily | undefined,
  entry = 'update',
  broken = '',
) {
  const [knownFamily, inverseRelation, ownerRelation, tenant, owning] = scenario;
  const [parent, inverse] = inverseRelation.split('.') as [string, string];
  const [child, owner] = ownerRelation.split('.') as [string, string];
  const datamodel = metadata(parent, child, knownFamily === 'marketplace');
  const inverseField = datamodel.models[0]!.fields[0]!;
  const ownerField = datamodel.models[1]!.fields[0]!;
  // Match production names: policy is family-qualified, never fixture-specific.
  Object.assign(inverseField, { name: inverse });
  Object.assign(ownerField, { name: broken === 'unclassified' ? 'unknownOwner' : owner });
  if (broken === 'missing') Object.assign(ownerField, { relationName: undefined });
  if (broken === 'misaligned')
    Object.assign(ownerField, { relationToFields: ['id', 'organizationId'] });
  if (broken === 'ambiguous') {
    // Only this negative fixture is mutable; the guard's input remains readonly.
    (datamodel.models[1]!.fields as (typeof ownerField)[]).push({
      ...ownerField,
      name: 'otherOwner',
    });
  }
  if (broken === 'extra-fk')
    (datamodel.models[1]!.fields as (typeof ownerField)[]).push({
      ...ownerField,
      name: 'unknownLink',
      relationName: 'OtherLink',
      relationFromFields: ['unknownId'],
    });
  const model = owning ? child : parent;
  const field = owning ? ownerField.name : inverse;
  const data = { [field]: { [action]: input } };
  const args = entry.startsWith('upsert')
    ? {
        where: { id: 'parent' },
        create: entry === 'upsert-create' ? data : {},
        update: entry === 'upsert-update' ? data : {},
      }
    : { where: { id: 'parent' }, data: entry.startsWith('createMany') ? [data] : data };
  const guard = createTenantGuardExtension({
    datamodel,
    scopedModels: tenant ? [parent, child] : [],
    scalarFkFamily: family,
  }).query.$allModels.$allOperations;
  const query = jest.fn().mockResolvedValue('ok');
  const result = runWithContext(context, () =>
    runWithNestedTenantWrite(
      {
        relation: `${model}.${field}`,
        reason: 'Reviewed nested policy test for the acting organization',
      },
      () =>
        guard({
          model,
          operation: entry.split('-')[0]!,
          args,
          query,
        }),
    ),
  );
  return { result, query };
}

describe.each(cases.map((scenario) => ({ scenario, label: scenario.join(' ') })))(
  '$label implicit FK classification',
  ({ scenario }) => {
    describe.each([
      'create',
      'update',
      'upsert-create',
      'upsert-update',
      'createMany',
      'createManyAndReturn',
    ])('under %s', (entry) => {
      it.each(Object.entries(inputs))(
        '%s refuses omitted and UNCLASSIFIED families',
        async (action, input) => {
          for (const family of [undefined, 'analytics', scenario[0]] as const) {
            const { result, query } = attempt(
              scenario,
              action,
              input,
              family,
              entry,
              family === scenario[0] ? 'unclassified' : '',
            );
            await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
            expect(query).not.toHaveBeenCalled();
          }
        },
      );
    });
    it.each(Object.entries(inputs))('%s retains classified behavior', async (action, input) => {
      const { result, query } = attempt(scenario, action, input, scenario[0]);
      if (scenario[3] && action === 'set') {
        await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
        expect(query).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toBe('ok');
        expect(query).toHaveBeenCalledTimes(1);
      }
    });
    it.each(['update', 'updateMany'])('%s recursively checks a relation change', async (action) => {
      // Outer update changes no link; the nested disconnect does.
      const input = {
        where: { id: 'child' },
        data: {
          [scenario[4] ? scenario[1].split('.')[1]! : scenario[2].split('.')[1]!]: {
            disconnect: { id: 'parent' },
          },
        },
      };
      const { result, query } = attempt(scenario, action, input, undefined);
      await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
      expect(query).not.toHaveBeenCalled();
    });
  },
);
it.each(['missing', 'ambiguous', 'misaligned'])('refuses %s owning metadata', async (broken) => {
  const { result, query } = attempt(
    cases[1]!,
    'disconnect',
    inputs.disconnect,
    'marketplace',
    'update',
    broken,
  );
  await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  expect(query).not.toHaveBeenCalled();
});

it.each([
  ['createMany', { data: [{}, { unknownId: 'target' }] }],
  [
    'upsert',
    { where: { id: 'child' }, create: {}, update: { unknownLink: { connect: { id: 'target' } } } },
  ],
] as const)('%s inspects an additional unclassified child FK', async (action, input) => {
  const { result, query } = attempt(cases[2]!, action, input, 'identity', 'update', 'extra-fk');
  await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  expect(query).not.toHaveBeenCalled();
});
