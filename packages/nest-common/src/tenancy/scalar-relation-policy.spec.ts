import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runWithContext, type RequestContext } from '../context/request-context';
import { createTenantGuardExtension, type TenantDatamodel } from './tenant-guard.extension';
import { LEGACY_SCALAR_RELATIONS, scalarRelationPolicy } from './scalar-relation-policy';

const context: RequestContext = {
  correlationId: 'scalar',
  requestId: 'scalar',
  organizationId: 'A',
  roles: [],
  organizationIds: [],
  authType: 'USER',
  startedAt: 0,
};
const shapes = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert-create',
  'upsert-update',
];
const metadata = (from = ['orderId'], to = ['id']): TenantDatamodel => ({
  models: [
    {
      name: 'OrderLine',
      fields: [
        {
          name: 'order',
          type: 'Order',
          kind: 'object',
          isList: false,
          relationFromFields: from,
          relationToFields: to,
        },
      ],
    },
    { name: 'Order', fields: [] },
  ],
});
function attempt(
  shape: string,
  datamodel = metadata(),
  family: 'marketplace' | undefined = 'marketplace',
) {
  const guard = createTenantGuardExtension({
    datamodel,
    scopedModels: ['OrderLine', 'Order'],
    scalarFkFamily: family,
  }).query.$allModels.$allOperations;
  const row = { orderId: 'target' };
  const args = shape.startsWith('upsert')
    ? {
        where: { id: 'line' },
        create: shape === 'upsert-create' ? row : {},
        update: shape === 'upsert-update' ? row : {},
      }
    : { where: { id: 'line' }, data: shape.startsWith('createMany') ? [row] : row };
  const query = jest.fn().mockResolvedValue('ok');
  return {
    query,
    result: runWithContext(context, () =>
      guard({ model: 'OrderLine', operation: shape.split('-')[0]!, args, query }),
    ),
  };
}

describe('scalar FK policy', () => {
  it.each(shapes)('%s refuses SAME_TENANT without an aligned atomic FK', async (shape) => {
    const { query, result } = attempt(shape);
    await expect(result).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect(query).not.toHaveBeenCalled();
  });
  it('refuses a missing family for platform scalar writes', async () => {
    // Explicitly pass undefined through options, rather than the helper default.
    const guard = createTenantGuardExtension({ datamodel: metadata(), scopedModels: [] }).query
      .$allModels.$allOperations;
    const query = jest.fn();
    await expect(
      guard({ model: 'OrderLine', operation: 'create', args: { data: { orderId: null } }, query }),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
    expect(query).not.toHaveBeenCalled();
  });
  it('does not confuse an unrelated tenant position with aligned protection', async () => {
    await expect(
      attempt('update', metadata(['organizationId', 'orderId'], ['id', 'organizationId'])).result,
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });
  });
  it('classifies both reviewed cross-party links by name', () => {
    for (const relation of ['Offer.product', 'OrderLine.offer'])
      expect(scalarRelationPolicy('marketplace', relation)).toBe('CROSS_PARTY_REVIEWED');
    expect(scalarRelationPolicy('marketplace', 'OrderLine.newRelation')).toBe('UNCLASSIFIED');
    expect(scalarRelationPolicy('asset', 'Asset.newRelation')).toBe('UNCLASSIFIED');
  });
});

describe('staged scalar-FK inventory', () => {
  const root = resolve(__dirname, '../../../..');
  it.each(Object.entries(LEGACY_SCALAR_RELATIONS))(
    '%s pins every legacy owning relation and installer',
    (family, expected) => {
      const schema = readFileSync(
        resolve(root, `services/${family}-service/prisma/schema.prisma`),
        'utf8',
      );
      const relations: string[] = [];
      for (const match of schema.matchAll(/model (\w+)\s*\{([\s\S]*?)\n\}/g)) {
        for (const field of match[2]!.matchAll(/^\s*(\w+)\s+[^\n]*@relation\([^\n]*fields:\s*\[/gm))
          relations.push(`${match[1]}.${field[1]}`);
      }
      expect(relations.sort()).toEqual([...expected].sort());
      const installer = readFileSync(
        resolve(root, `services/${family}-service/src/prisma/prisma.service.ts`),
        'utf8',
      );
      expect(installer).toContain(`scalarFkFamily: '${family}'`);
      for (const relation of relations)
        expect(scalarRelationPolicy(family as keyof typeof LEGACY_SCALAR_RELATIONS, relation)).toBe(
          'LEGACY_PASS_THROUGH',
        );
    },
  );
  it('classifies all marketplace owning relations; returns retain their existing composite protection', () => {
    const schema = readFileSync(
      resolve(root, 'services/marketplace-service/prisma/schema.prisma'),
      'utf8',
    );
    const relations: string[] = [];
    for (const match of schema.matchAll(/model (\w+)\s*\{([\s\S]*?)\n\}/g)) {
      for (const field of match[2]!.matchAll(/^\s*(\w+)\s+[^\n]*@relation\([^\n]*fields:\s*\[/gm))
        relations.push(`${match[1]}.${field[1]}`);
    }
    expect(relations).toHaveLength(13);
    for (const relation of relations)
      expect(scalarRelationPolicy('marketplace', relation)).not.toBe('UNCLASSIFIED');
  });
});
