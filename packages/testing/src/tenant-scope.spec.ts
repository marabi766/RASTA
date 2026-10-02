import { MIN_REASON_LENGTH, tenantScopeProblems, type DmmfModelLike } from './tenant-scope';

/**
 * The comparison's own failure modes. Each case below is the shape of a real
 * mistake; every one fails against a check that only looked at one direction.
 */

const model = (name: string, ...columns: Array<[string, string?]>): DmmfModelLike => ({
  name,
  fields: columns.map(([field, dbName]) => ({ name: field, dbName: dbName ?? null })),
});

const ORG: [string, string] = ['organizationId', 'organization_id'];
const REASON = 'Written by the relay with no request context and filtered by its own column.';

const MODELS: DmmfModelLike[] = [
  model('Order', ['id'], ORG),
  model('IdempotencyKey', ['key'], ORG),
  model('OutboxMessage', ['id'], ORG),
  model('Template', ['id']),
];

const agree = {
  scoped: ['Order', 'IdempotencyKey'],
  exemptions: { OutboxMessage: REASON },
  models: MODELS,
};

describe('tenantScopeProblems', () => {
  it('is empty when the list, the exemptions and the schema agree', () => {
    expect(tenantScopeProblems(agree)).toEqual([]);
  });

  it('names a typo: a listed model the schema does not have (the marketplace defect)', () => {
    const problems = tenantScopeProblems({ ...agree, scoped: ['Order', 'IdempotencyRecord'] });
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining('IdempotencyRecord is listed')]),
    );
    // …and, because the real model is now unlisted, says that too.
    expect(problems).toEqual(
      expect.arrayContaining([expect.stringContaining('IdempotencyKey has an `organization_id`')]),
    );
  });

  it('names a new model with an organization column that nobody listed or exempted', () => {
    const problems = tenantScopeProblems({
      ...agree,
      models: [...MODELS, model('Invoice', ['id'], ORG)],
    });
    expect(problems).toEqual([expect.stringContaining('Invoice has an `organization_id` column')]);
  });

  it('sees the column through @map, not only through the field name', () => {
    const problems = tenantScopeProblems({
      ...agree,
      models: [...MODELS, model('Hidden', ['id'], ['owner', 'organization_id'])],
    });
    expect(problems).toEqual([expect.stringContaining('Hidden has an `organization_id` column')]);
  });

  it('does not ask for a model with no organization column to be listed or exempted', () => {
    expect(tenantScopeProblems(agree)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('Template')]),
    );
  });

  it('refuses a listed model that lacks the field the guard filters on', () => {
    const problems = tenantScopeProblems({
      ...agree,
      scoped: ['Order', 'IdempotencyKey', 'Template'],
    });
    expect(problems).toEqual([
      expect.stringContaining('Template is listed as tenant-scoped but has no'),
    ]);
  });

  it('refuses an exemption with no reason, and one too short to be a sentence', () => {
    for (const reason of ['', '   ', 'n/a', 'x'.repeat(MIN_REASON_LENGTH - 1)]) {
      expect(tenantScopeProblems({ ...agree, exemptions: { OutboxMessage: reason } })).toEqual([
        expect.stringContaining('OutboxMessage is exempted without a reason'),
      ]);
    }
  });

  it('refuses an exemption for a model that does not exist', () => {
    expect(
      tenantScopeProblems({ ...agree, exemptions: { OutboxMessage: REASON, Ghost: REASON } }),
    ).toEqual([
      expect.stringContaining('Ghost is exempted from tenant scoping but is not a model'),
    ]);
  });

  it('refuses a model that is both scoped and exempted', () => {
    expect(
      tenantScopeProblems({ ...agree, exemptions: { OutboxMessage: REASON, Order: REASON } }),
    ).toEqual([expect.stringContaining('Order is both tenant-scoped and exempted')]);
  });

  it('refuses a model listed twice', () => {
    expect(tenantScopeProblems({ ...agree, scoped: ['Order', 'IdempotencyKey', 'Order'] })).toEqual(
      [expect.stringContaining('Order is listed as tenant-scoped more than once')],
    );
  });

  it('refuses to pass on an empty DMMF, which would make every check vacuous', () => {
    expect(tenantScopeProblems({ ...agree, models: [] })).toEqual([
      expect.stringContaining('the DMMF has no models'),
    ]);
  });

  it('honours a service that filters on a different field or column', () => {
    const models = [model('Thing', ['id'], ['tenantId', 'tenant_id'])];
    expect(
      tenantScopeProblems({
        scoped: ['Thing'],
        exemptions: {},
        models,
        tenantField: 'tenantId',
        tenantColumn: 'tenant_id',
      }),
    ).toEqual([]);
  });
});
