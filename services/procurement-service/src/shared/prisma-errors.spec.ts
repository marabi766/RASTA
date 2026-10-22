import {
  isCheckViolation,
  isGuardRefusal,
  isUniqueViolation,
  violatedConstraint,
} from './prisma-errors';

/**
 * Driver error shapes, as predicates.
 *
 * These decide which platform error a caller gets: a duplicate organization is
 * a `409 ALREADY_EXISTS`, a duplicate open qualification is a
 * `422 BUSINESS_RULE_VIOLATION`, and anything unrecognised must fall through
 * rather than be swallowed as one of those. A predicate that answered `true` too
 * eagerly would turn a genuine bug into a tidy-looking business refusal.
 */

describe('unique violations', () => {
  it('recognises P2002', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
  });

  it.each([{ code: 'P2003' }, { code: '' }, {}, null, undefined, 'P2002', new Error('P2002')])(
    'does not recognise %p',
    (value) => {
      // A message that merely mentions P2002 is not a unique violation. Treating
      // one as such would report an unrelated failure as "already exists".
      expect(isUniqueViolation(value)).toBe(false);
    },
  );
});

describe('check violations', () => {
  it('recognises a driver message naming a check constraint', () => {
    expect(
      isCheckViolation(new Error('new row violates check constraint "ck_qualification_..."')),
    ).toBe(true);
  });

  it('does not recognise an unrelated error', () => {
    expect(isCheckViolation(new Error('connection terminated'))).toBe(false);
    expect(isCheckViolation(null)).toBe(false);
  });
});

describe('a guard’s own refusal', () => {
  // What Prisma 6 throws when `aggregation_setting_guard` refuses a `create` (an unknown request
  // error: no code, no meta — the driver error only in the text).
  const refusal = (code: string, message: string) =>
    new Error(
      'Invalid `prisma.aggregationSetting.create()` invocation:\n\n\nError occurred during query ' +
        'execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: ' +
        `QueryError(PostgresError { code: "${code}", message: "${message}", severity: "ERROR", ` +
        'detail: None, column: None, hint: None }), transient: false })',
    );

  it('recognises the named guard’s check_violation', () => {
    expect(
      isGuardRefusal(
        refusal(
          '23514',
          'ck_aggregation_setting_next_version: version 2 of an organization at version 2',
        ),
        'ck_aggregation_setting_next_version',
      ),
    ).toBe(true);
  });

  it.each([
    [
      'another guard of the same table',
      refusal('23514', 'ck_aggregation_setting_append_only: a setting version is never changed'),
    ],
    [
      'a CHECK constraint',
      refusal(
        '23514',
        'new row for relation \\"aggregation_setting\\" violates check constraint \\"ck_aggregation_setting_values\\"',
      ),
    ],
    [
      'the same name under another SQLSTATE',
      refusal(
        'P0001',
        'ck_aggregation_setting_next_version: version 2 of an organization at version 2',
      ),
    ],
    [
      'a longer name that starts with it',
      refusal('23514', 'ck_aggregation_setting_next_version_2: something else'),
    ],
    ['the name alone', new Error('ck_aggregation_setting_next_version: version 2')],
    ['a unique violation', { code: 'P2002' }],
    ['null', null],
    ['a string', 'code: "23514", message: "ck_aggregation_setting_next_version: "'],
  ])('does not recognise %s', (_, error) => {
    expect(isGuardRefusal(error, 'ck_aggregation_setting_next_version')).toBe(false);
  });
});

describe('naming the constraint', () => {
  it('reads a single target', () => {
    expect(violatedConstraint({ meta: { target: 'ux_project_need_title' } })).toBe(
      'ux_project_need_title',
    );
  });

  it('joins a composite target', () => {
    expect(violatedConstraint({ meta: { target: ['organization_id', 'project_id'] } })).toBe(
      'organization_id,project_id',
    );
  });

  it('returns undefined when the driver reports none', () => {
    // Undefined rather than a guess: an error handler that invented a
    // constraint name would send somebody to look at the wrong index.
    expect(violatedConstraint({ code: 'P2002' })).toBeUndefined();
    expect(violatedConstraint(null)).toBeUndefined();
  });
});
