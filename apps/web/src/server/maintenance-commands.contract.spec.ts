/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { DISPLAY_TEXT_PATTERN, UNSUPPORTED_CHARACTERS } from '@rasta/contracts';
import { guardAdmitsAlone } from '@/test/service-source';

import {
  APPROVE_REQUEST_FIELD_MAPPING,
  ASSIGN_WORKSHOP_FIELD_MAPPING,
  CANCEL_REQUEST_FIELD_MAPPING,
  canManageMaintenance,
  MAINTENANCE_DISPLAY_TEXT,
} from './maintenance-commands';

/**
 * What the three request commands depend on, pinned to maintenance-service's
 * source — the technique of `asset-commands.contract.spec.ts` and
 * `lib/labels.contract.spec.ts`: A-02 forbids importing `services/*\/src`, so
 * the portal keeps copies and this test fails the moment a copy and its
 * original disagree. The reader refuses anything it cannot read literally
 * rather than skipping it.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const SERVICE = join(ROOT, 'services', 'maintenance-service', 'src', 'maintenance');
const read = (file: string) => readFileSync(join(SERVICE, file), 'utf8');
const parse = (text: string) => ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);

function topLevelConst(source: ts.SourceFile, name: string): ts.Expression {
  const found: ts.Expression[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        if (!declaration.initializer) throw new Error(`\`${name}\` has no initializer`);
        found.push(declaration.initializer);
      }
    }
  }
  if (found.length !== 1) throw new Error(`expected one \`const ${name}\`, found ${found.length}`);
  return found[0];
}

function collect<T extends ts.Node>(root: ts.Node, test: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node): void => {
    if (test(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

const dto = parse(read('dto.ts'));

/** The `key: initializer` properties of the schema's own object literal. */
function schemaProperties(name: string): Map<string, string> {
  const schema = topLevelConst(dto, name);
  const literal = collect(schema, ts.isObjectLiteralExpression)[0];
  if (!literal) throw new Error(`\`${name}\` has no object literal`);
  const out = new Map<string, string>();
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property))
      out.set(property.name.getText(), property.initializer.getText());
  }
  return out;
}

describe('who may use the commands', () => {
  const controller = parse(read('request.controller.ts'));

  /** The roles named in the `@Roles(...)` above each handler, by handler name. */
  function rolesOf(method: string): string[] {
    const declaration = collect(controller, ts.isMethodDeclaration).find(
      (node) => node.name.getText() === method,
    );
    if (!declaration) throw new Error(`no handler \`${method}\``);
    const roles = (ts.getDecorators(declaration) ?? [])
      .map((decorator) => decorator.expression)
      .filter(ts.isCallExpression)
      .find((call) => call.expression.getText() === 'Roles');
    if (!roles) throw new Error(`\`${method}\` has no @Roles`);
    return roles.arguments.map((argument) => {
      if (!ts.isStringLiteral(argument)) throw new Error('a role that is not a literal');
      return argument.text;
    });
  }

  const EVERY_ROLE = [
    'SYSTEM_ADMIN',
    'UNION_ADMIN',
    'ORGANIZATION_ADMIN',
    'FLEET_MANAGER',
    'PROCUREMENT_USER',
    'OPERATOR',
    'DRIVER',
    'AUDITOR',
    'CONTRACTOR',
  ];

  it.each(['assign', 'approve', 'cancel'])(
    'is the same set of roles for %s as the portal offers the forms to',
    (handler) => {
      const admitted = rolesOf(handler);
      expect(admitted.length).toBeGreaterThan(0);
      const offered = EVERY_ROLE.filter((role) => canManageMaintenance([role]));
      expect(offered.sort()).toEqual(
        EVERY_ROLE.filter((role) => guardAdmitsAlone(role, admitted)).sort(),
      );
      // …and no role the portal offers is one the guard would not admit.
      for (const role of offered) expect(guardAdmitsAlone(role, admitted)).toBe(true);
    },
  );

  it.each([
    ['assign', "':id/assign'"],
    ['approve', "':id/approve'"],
    ['cancel', "':id/cancel'"],
  ])('still serves %s at the path the portal posts to', (handler, path) => {
    const declaration = collect(controller, ts.isMethodDeclaration).find(
      (node) => node.name.getText() === handler,
    );
    const post = (ts.getDecorators(declaration!) ?? [])
      .map((decorator) => decorator.expression)
      .filter(ts.isCallExpression)
      .find((call) => call.expression.getText() === 'Post');
    expect(post?.arguments.map((argument) => argument.getText())).toEqual([path]);
  });
});

describe('the request bodies', () => {
  it('assign still takes exactly the workshop, a name, a summary and a time', () => {
    expect([...schemaProperties('assignWorkshopSchema').keys()].sort()).toEqual([
      'assignedAt',
      'workSummary',
      'workshopName',
      'workshopOrganizationId',
    ]);
  });

  it('approve still takes exactly a note and the expected total', () => {
    expect([...schemaProperties('approveRequestSchema').keys()].sort()).toEqual([
      'expectedTotalCostMinor',
      'notes',
    ]);
  });

  it('approve still REQUIRES the expected total: the form no longer sends it from a field, so the service must hold the line for every other client', () => {
    // Not `.optional()`: an approval that never states the amount is not the
    // control docs/17 makes mandatory (the pin above is the exact initializer).
    expect(schemaProperties('approveRequestSchema').get('expectedTotalCostMinor')).not.toContain(
      'optional',
    );
  });

  it('cancel still takes exactly a reason', () => {
    expect([...schemaProperties('cancelRequestSchema').keys()]).toEqual(['reason']);
  });

  // The bounds the forms copy. `displayText(min, max)` is the service's helper.
  it.each([
    ['assignWorkshopSchema', 'workshopName', 'displayText(2, 200).optional()'],
    ['assignWorkshopSchema', 'workSummary', 'displayText(2, 1000).optional()'],
    ['approveRequestSchema', 'notes', 'displayText(1, 1000).optional()'],
    ['cancelRequestSchema', 'reason', 'displayText(3, 500)'],
    ['approveRequestSchema', 'expectedTotalCostMinor', 'amountMinorSchema'],
  ])('still bounds %s.%s as the forms do', (schema, key, expected) => {
    expect(schemaProperties(schema).get(key)?.replace(/\s+/g, ' ')).toBe(expected);
  });

  it('still reads the expected total as a Latin-digit string of 1 to 30 digits', () => {
    const money = readFileSync(
      join(ROOT, 'packages', 'contracts', 'src', 'common', 'money.ts'),
      'utf8',
    );
    expect(money).toContain('/^\\d{1,30}$/');
  });
});

describe("the service's displayText rule", () => {
  it('is the shared helper from @rasta/contracts, imported and not redefined', () => {
    // The portal copies are gone: both sides use `displayText` /
    // `DISPLAY_TEXT_PATTERN` from `@rasta/contracts`, so they cannot disagree.
    expect(read('dto.ts')).not.toMatch(/(?:const|function)\s+displayText\b/);
    expect(read('dto.ts')).toMatch(
      /import\s*\{[^}]*\bdisplayText\b[^}]*\}\s*from\s*'@rasta\/contracts'/,
    );
    expect(MAINTENANCE_DISPLAY_TEXT).toBe(DISPLAY_TEXT_PATTERN);
  });

  it.each(['الف،', 'الف؛', 'چرا؟', 'a, b', 'توجه!', '50%', 'خط\nدوم'])(
    'accepts %j, which the old copy refused',
    (text) => {
      expect(MAINTENANCE_DISPLAY_TEXT.test(text)).toBe(true);
    },
  );

  it.each(['a<b>', 'a=b', 'a&b', 'خودرو 🚜', '日本語', '', 'a‮b', 'سـلام'])(
    'refuses %j',
    (text) => {
      expect(MAINTENANCE_DISPLAY_TEXT.test(text)).toBe(false);
    },
  );

  it('is the message the portal translates', () => {
    expect(UNSUPPORTED_CHARACTERS).toBe('Contains unsupported characters');
    for (const mapping of [
      ASSIGN_WORKSHOP_FIELD_MAPPING,
      APPROVE_REQUEST_FIELD_MAPPING,
      CANCEL_REQUEST_FIELD_MAPPING,
    ]) {
      expect(mapping.messages?.['Contains unsupported characters']).toBeTruthy();
    }
  });
});

describe('the sentences the portal translates', () => {
  // Every English key in the three mappings must still be written, verbatim,
  // somewhere in the service: a sentence the service reworded is a sentence the
  // portal would show in English — and, for the moved-total one, one the
  // approve action would stop recognising.
  const sources = [
    'request.service.ts',
    'repair-order.service.ts',
    'lifecycle.ts',
    'transfer-record.ts',
    'transfer-clearance.ts',
    'dto.ts',
  ]
    .map((file) => read(file))
    // The shared text rule's closed message lives in @rasta/contracts now.
    .concat(readFileSync(join(ROOT, 'packages', 'contracts', 'src', 'common', 'text.ts'), 'utf8'))
    .join('\n');

  const normalise = (text: string) => text.replace(/'\s*\+\s*\n?\s*'/g, '').replace(/\s+/g, ' ');
  const haystack = normalise(sources);

  const all = new Map<string, string>();
  for (const mapping of [
    ASSIGN_WORKSHOP_FIELD_MAPPING,
    APPROVE_REQUEST_FIELD_MAPPING,
    CANCEL_REQUEST_FIELD_MAPPING,
  ]) {
    for (const key of Object.keys(mapping.messages ?? {})) all.set(key, key);
  }

  it('has sentences to check, or this proves nothing', () => {
    expect(all.size).toBeGreaterThanOrEqual(8);
  });

  /**
   * Sentences the service builds from a status (`already ${from}`): the
   * template must still be there, and each status the portal names must still
   * be one the service has.
   */
  const TEMPLATED: ReadonlyMap<string, { template: string; status: string }> = new Map([
    [
      'This maintenance request is already APPROVED',
      { template: 'This maintenance request is already ${from}', status: 'APPROVED' },
    ],
    [
      'This maintenance request is already CANCELLED',
      { template: 'This maintenance request is already ${from}', status: 'CANCELLED' },
    ],
  ]);
  const lifecycle = read('lifecycle.ts');

  it.each([...all.keys()].filter((sentence) => !TEMPLATED.has(sentence)))(
    'still says %j',
    (sentence) => {
      expect(haystack).toContain(normalise(sentence));
    },
  );

  it.each([...TEMPLATED.entries()])(
    'still builds %j from a status',
    (sentence, { template, status }) => {
      expect(all.has(sentence)).toBe(true);
      expect(haystack).toContain(normalise(template));
      expect(lifecycle).toContain(`'${status}'`);
    },
  );
});

describe('the fallback for a sentence the portal does not know', () => {
  const platformErrors = readFileSync(
    join(ROOT, 'packages', 'contracts', 'src', 'common', 'errors.ts'),
    'utf8',
  );
  const nestErrors = readFileSync(
    join(ROOT, 'packages', 'nest-common', 'src', 'errors', 'rasta-error.ts'),
    'utf8',
  );

  const MAPPINGS = [
    ['assign', ASSIGN_WORKSHOP_FIELD_MAPPING],
    ['approve', APPROVE_REQUEST_FIELD_MAPPING],
    ['cancel', CANCEL_REQUEST_FIELD_MAPPING],
  ] as const;

  it.each(MAPPINGS)('is keyed by codes the platform defines, for %s', (_name, mapping) => {
    const codes = Object.keys(mapping.byCode ?? {});
    expect(codes.sort()).toEqual(['BUSINESS_RULE_VIOLATION', 'INVALID_STATE_TRANSITION']);
    for (const code of codes) expect(platformErrors).toContain(`${code}: '${code}'`);
  });

  it('covers the two ways the service refuses a state: a transition and a business rule', () => {
    expect(nestErrors).toContain('ERROR_CODES.INVALID_STATE_TRANSITION');
    expect(nestErrors).toContain('ERROR_CODES.BUSINESS_RULE_VIOLATION');
  });
});
