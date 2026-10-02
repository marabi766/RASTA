/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import {
  CANCEL_REPAIR_FIELD_MAPPING,
  COMPLETE_REPAIR_FIELD_MAPPING,
  RECORD_COST_FIELD_MAPPING,
  RECORD_LABOUR_FIELD_MAPPING,
  RECORD_PART_FIELD_MAPPING,
  REPAIR_TOTAL_CHANGED_MESSAGE,
  START_REPAIR_FIELD_MAPPING,
} from './repair-order-commands';
import { canManageMaintenance, REQUEST_STATE_MESSAGES } from './maintenance-commands';
import { DIRECT_COST_CATEGORIES, PART_SOURCES } from '@/lib/repair-order-fields';

/**
 * What the six repair-order commands depend on, pinned to maintenance-service's
 * source — the technique of `maintenance-commands.contract.spec.ts`: A-02
 * forbids importing `services/*\/src`, so the portal keeps copies and this test
 * fails the moment a copy and its original disagree. The reader refuses
 * anything it cannot read literally rather than skipping it.
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

/** The string literals of `export const NAME = [...] as const`, in order. */
function literalList(name: string): string[] {
  const initializer = topLevelConst(dto, name);
  const array = collect(initializer, ts.isArrayLiteralExpression)[0];
  if (!array) throw new Error(`\`${name}\` is not an array literal`);
  return array.elements.map((element) => {
    if (!ts.isStringLiteral(element))
      throw new Error(`\`${name}\` has an element that is not a literal`);
    return element.text;
  });
}

const squash = (text: string | undefined) => text?.replace(/\s+/g, ' ');

describe('who may use the commands', () => {
  const controller = parse(read('repair-order.controller.ts'));

  function decorators(method: string, name: string): ts.CallExpression | undefined {
    const declaration = collect(controller, ts.isMethodDeclaration).find(
      (node) => node.name.getText() === method,
    );
    if (!declaration) throw new Error(`no handler \`${method}\``);
    return (ts.getDecorators(declaration) ?? [])
      .map((decorator) => decorator.expression)
      .filter(ts.isCallExpression)
      .find((call) => call.expression.getText() === name);
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

  const HANDLERS = [
    ['start', "':id/start'"],
    ['complete', "':id/complete'"],
    ['cancel', "':id/cancel'"],
    ['recordPart', "':id/parts'"],
    ['recordLabour', "':id/labour'"],
    ['recordCost', "':id/costs'"],
  ] as const;

  it.each(HANDLERS)(
    'is the same set of roles for %s as the portal offers the forms to',
    (handler) => {
      const roles = decorators(handler, 'Roles');
      if (!roles) throw new Error(`\`${handler}\` has no @Roles`);
      const admitted = roles.arguments.map((argument) => {
        if (!ts.isStringLiteral(argument)) throw new Error('a role that is not a literal');
        return argument.text;
      });
      expect(admitted.length).toBeGreaterThan(0);
      const offered = EVERY_ROLE.filter((role) => canManageMaintenance([role]));
      expect(offered.sort()).toEqual(EVERY_ROLE.filter((role) => admitted.includes(role)).sort());
    },
  );

  it.each(HANDLERS)('still serves %s at the path the portal posts to', (handler, path) => {
    const post = decorators(handler, 'Post');
    expect(post?.arguments.map((argument) => argument.getText())).toEqual([path]);
  });

  it('still mounts the controller at /v1/repair-orders', () => {
    expect(read('repair-order.controller.ts')).toContain(
      "@Controller({ path: 'repair-orders', version: '1' })",
    );
  });
});

describe('the request bodies', () => {
  it.each([
    ['startRepairSchema', ['startedAt', 'workSummary']],
    [
      'completeRepairSchema',
      ['completedAt', 'expectedTotalCostMinor', 'returnedToServiceAt', 'workPerformed'],
    ],
    ['cancelRepairSchema', ['reason']],
    [
      'recordPartSchema',
      [
        'partName',
        'partReference',
        'quantity',
        'recordedAt',
        'source',
        'sourceReference',
        'unit',
        'unitCostMinor',
      ],
    ],
    [
      'recordLabourSchema',
      ['description', 'hourlyRateMinor', 'hours', 'performedAt', 'recordedAt', 'technician'],
    ],
    ['recordCostSchema', ['amountMinor', 'category', 'currency', 'description', 'recordedAt']],
  ])('still takes exactly the fields of %s', (schema, keys) => {
    expect([...schemaProperties(schema).keys()].sort()).toEqual(keys);
  });

  // The bounds the forms copy. `displayText(min, max)` is the service's helper.
  it.each([
    ['startRepairSchema', 'workSummary', 'displayText(2, 1000).optional()'],
    ['completeRepairSchema', 'workPerformed', 'displayText(2, 2000)'],
    ['cancelRepairSchema', 'reason', 'displayText(3, 500)'],
    ['recordPartSchema', 'partName', 'displayText(2, 200)'],
    ['recordPartSchema', 'partReference', 'z.string().trim().min(1).max(128).optional()'],
    ['recordPartSchema', 'quantity', 'partQuantity'],
    ['recordPartSchema', 'unit', 'displayText(1, 32)'],
    ['recordPartSchema', 'unitCostMinor', 'amountMinorSchema'],
    ['recordPartSchema', 'source', "partSourceSchema.default('WORKSHOP_SUPPLIED')"],
    ['recordPartSchema', 'sourceReference', 'z.string().trim().min(1).max(128).optional()'],
    ['recordLabourSchema', 'description', 'displayText(2, 500)'],
    ['recordLabourSchema', 'technician', 'displayText(2, 120).optional()'],
    ['recordLabourSchema', 'hours', 'quantity(6)'],
    ['recordLabourSchema', 'hourlyRateMinor', 'amountMinorSchema'],
    ['recordCostSchema', 'category', 'directCostCategorySchema'],
    ['recordCostSchema', 'amountMinor', 'amountMinorSchema'],
    ['recordCostSchema', 'currency', "currencySchema.default('IRR')"],
    ['recordCostSchema', 'description', 'displayText(2, 500)'],
  ])('still bounds %s.%s as the forms do', (schema, key, expected) => {
    expect(squash(schemaProperties(schema).get(key))).toBe(expected);
  });

  it('still takes the completion’s total as an optional amount, and publishes it as optional for API clients and always sent by the portal', () => {
    const initializer = squash(
      schemaProperties('completeRepairSchema').get('expectedTotalCostMinor'),
    );
    expect(initializer).toContain('amountMinorSchema .optional() .describe(');
    // The published sentence is written across concatenated literals.
    expect(initializer?.replace(/'\s*\+\s*'/g, '')).toContain(
      'Optional for API clients and always sent by the portal',
    );
  });

  it('still reads a part quantity as a positive number of at most three decimals and nine integer digits', () => {
    const initializer = squash(topLevelConst(dto, 'partQuantity').getText()) ?? '';
    expect(initializer).toContain('\\d{1,3}');
    expect(initializer).toContain('<= 9');
    expect(initializer).toContain('Quantity must be greater than zero');
  });

  it('still reads labour hours as a number of at most two decimals, positive, and `quantity(6)`', () => {
    const quantity = squash(topLevelConst(dto, 'quantity').getText()) ?? '';
    expect(quantity).toContain('\\d{1,2}');
    expect(squash(dto.text)).toContain('Labour hours must be greater than zero');
  });

  it('still refuses a direct cost of zero, which records nothing', () => {
    expect(squash(dto.text)).toContain("dto.amountMinor !== '0'");
  });

  it('still reads a typed amount as a Latin-digit string of 1 to 30 digits', () => {
    const money = readFileSync(
      join(ROOT, 'packages', 'contracts', 'src', 'common', 'money.ts'),
      'utf8',
    );
    expect(money).toContain('/^\\d{1,30}$/');
  });
});

describe('the choices the forms offer', () => {
  it('are the part sources the service knows, in its order', () => {
    expect([...PART_SOURCES]).toEqual(literalList('PART_SOURCES'));
  });

  it('are the cost categories a person may post directly, and neither PART nor LABOUR', () => {
    expect([...DIRECT_COST_CATEGORIES]).toEqual(literalList('DIRECT_COST_CATEGORIES'));
    expect(literalList('DIRECT_COST_CATEGORIES')).not.toContain('PART');
    expect(literalList('DIRECT_COST_CATEGORIES')).not.toContain('LABOUR');
  });
});

describe('the completion’s total', () => {
  const service = read('repair-order.service.ts');

  it('is still compared by the service, under the lock, and refuses the whole completion on a mismatch', () => {
    const text = squash(service) ?? '';
    expect(text).toContain('dto.expectedTotalCostMinor !== undefined');
    expect(text).toContain('dto.expectedTotalCostMinor !== totals.orderTotal.toString()');
    expect(text).toContain("rule: 'COMPLETION_TOTAL_MISMATCH'");
  });

  it('is said in the sentence the complete action recognises', () => {
    expect(
      COMPLETE_REPAIR_FIELD_MAPPING.messages?.[
        'The cost has changed since it was shown to you; review it again before completing.'
      ],
    ).toBe(REPAIR_TOTAL_CHANGED_MESSAGE);
  });
});

describe('the sentences the portal translates', () => {
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

  const MAPPINGS = [
    START_REPAIR_FIELD_MAPPING,
    COMPLETE_REPAIR_FIELD_MAPPING,
    CANCEL_REPAIR_FIELD_MAPPING,
    RECORD_PART_FIELD_MAPPING,
    RECORD_LABOUR_FIELD_MAPPING,
    RECORD_COST_FIELD_MAPPING,
  ];

  // The request-level sentences the repair mappings share are pinned by
  // `maintenance-commands.contract.spec.ts`; what is checked here is the rest.
  const own = new Set<string>();
  for (const mapping of MAPPINGS) {
    for (const key of Object.keys(mapping.messages ?? {})) {
      if (!(key in REQUEST_STATE_MESSAGES)) own.add(key);
    }
  }

  it('has sentences to check, or this proves nothing', () => {
    expect(own.size).toBeGreaterThanOrEqual(15);
  });

  it('gives every command the same dictionary', () => {
    for (const mapping of MAPPINGS) {
      expect(mapping.messages).toEqual(START_REPAIR_FIELD_MAPPING.messages);
    }
  });

  /**
   * Sentences the service builds from a status: the template must still be
   * there, and each status the portal names must still be one the service has.
   */
  const TEMPLATED: ReadonlyMap<string, { template: string; statuses: readonly string[] }> = new Map(
    [
      [
        'This repair order is already IN_PROGRESS',
        { template: 'This repair order is already ${from}', statuses: ['IN_PROGRESS'] },
      ],
      [
        'This repair order is already COMPLETED',
        { template: 'This repair order is already ${from}', statuses: ['COMPLETED'] },
      ],
      [
        'This repair order is already CANCELLED',
        { template: 'This repair order is already ${from}', statuses: ['CANCELLED'] },
      ],
      [
        'A repair order cannot move from OPEN to COMPLETED',
        {
          template: 'A repair order cannot move from ${from} to ${to}',
          statuses: ['OPEN', 'COMPLETED'],
        },
      ],
      [
        'Cost cannot be added to a completed repair order.',
        {
          template: 'Cost cannot be added to a ${status.toLowerCase()} repair order.',
          statuses: ['COMPLETED'],
        },
      ],
      [
        'Cost cannot be added to a cancelled repair order.',
        {
          template: 'Cost cannot be added to a ${status.toLowerCase()} repair order.',
          statuses: ['CANCELLED'],
        },
      ],
    ],
  );
  const lifecycle = read('lifecycle.ts');

  it.each([...own].filter((sentence) => !TEMPLATED.has(sentence)))('still says %j', (sentence) => {
    expect(haystack).toContain(normalise(sentence));
  });

  it.each([...TEMPLATED.entries()])(
    'still builds %j from a status',
    (sentence, { template, statuses }) => {
      expect(own.has(sentence)).toBe(true);
      expect(haystack).toContain(normalise(template));
      for (const status of statuses) expect(lifecycle).toContain(`'${status}'`);
    },
  );
});

describe('the fallback for a sentence the portal does not know', () => {
  const platformErrors = readFileSync(
    join(ROOT, 'packages', 'contracts', 'src', 'common', 'errors.ts'),
    'utf8',
  );

  it.each([
    ['start', START_REPAIR_FIELD_MAPPING],
    ['complete', COMPLETE_REPAIR_FIELD_MAPPING],
    ['withdraw', CANCEL_REPAIR_FIELD_MAPPING],
    ['part', RECORD_PART_FIELD_MAPPING],
    ['labour', RECORD_LABOUR_FIELD_MAPPING],
    ['cost', RECORD_COST_FIELD_MAPPING],
  ] as const)('is keyed by codes the platform defines, for %s', (_name, mapping) => {
    const codes = Object.keys(mapping.byCode ?? {});
    expect(codes.sort()).toEqual(['BUSINESS_RULE_VIOLATION', 'INVALID_STATE_TRANSITION']);
    for (const code of codes) expect(platformErrors).toContain(`${code}: '${code}'`);
  });
});
