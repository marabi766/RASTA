/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

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
      expect(offered.sort()).toEqual(EVERY_ROLE.filter((role) => admitted.includes(role)).sort());
      // …and no role the portal offers is one the service would not admit.
      for (const role of offered) expect(admitted).toContain(role);
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

  it('cancel still takes exactly a reason', () => {
    expect([...schemaProperties('cancelRequestSchema').keys()]).toEqual(['reason']);
  });

  // The bounds the forms copy. `displayText(min, max)` is the service's helper.
  it.each([
    ['assignWorkshopSchema', 'workshopName', 'displayText(2, 200).optional()'],
    ['assignWorkshopSchema', 'workSummary', 'displayText(2, 1000).optional()'],
    ['approveRequestSchema', 'notes', 'displayText(1, 1000).optional()'],
    ['cancelRequestSchema', 'reason', 'displayText(3, 500)'],
    ['approveRequestSchema', 'expectedTotalCostMinor', 'amountMinorSchema.optional()'],
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
  const displayText = topLevelConst(dto, 'displayText');
  const literals = collect(displayText, ts.isRegularExpressionLiteral);

  it('is one regular expression literal the reader can take at its word', () => {
    expect(literals).toHaveLength(1);
  });

  const text = literals[0]?.text ?? '';
  const closing = text.lastIndexOf('/');
  const service = new RegExp(text.slice(1, closing), text.slice(closing + 1));

  it('carries the flags the portal copy carries', () => {
    expect(service.flags).toBe(MAINTENANCE_DISPLAY_TEXT.flags);
  });

  const PROBES: readonly string[] = [
    'لودر کوماتسو',
    'Komatsu WA320',
    'گریدر ۱۴۰۲',
    'گریدر ١٤٠٢',
    'می‌خواهم',
    'کلید (اصلی) «برق»',
    "O'Brien’s 4x4, 10.5 t/h: +1 - 2",
    'á',
    'tab\tseparated',
    'مدل_۱',
    'مدل#۱',
    'a@b',
    'a<b>',
    'a=b',
    'a&b',
    'a"b',
    '50%',
    'a‮b',
    'a‏b',
    'a⁦b',
    'خودرو 🚜',
    '日本語',
    'Москва',
    '',
  ];

  it.each(PROBES)('agrees with the service on %j', (probe) => {
    expect(MAINTENANCE_DISPLAY_TEXT.test(probe)).toBe(service.test(probe));
  });

  it('is not vacuous: the probes include strings both accept and refuse', () => {
    const accepted = PROBES.filter((probe) => service.test(probe)).length;
    expect(accepted).toBeGreaterThan(5);
    expect(accepted).toBeLessThan(PROBES.length - 5);
  });

  it('is the message the portal translates', () => {
    const messages = collect(displayText, ts.isStringLiteral).map((node) => node.text);
    expect(messages).toContain('Contains unsupported characters');
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

  it.each([...all.keys()])('still says %j', (sentence) => {
    expect(haystack).toContain(normalise(sentence));
  });
});
