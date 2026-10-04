/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainText } from '@rasta/contracts';
import ts from 'typescript';

import { INSPECTION_RESULTS } from '@/lib/asset-fields';
import { POLICY_COVERAGES } from '@/lib/asset-record-fields';
import {
  BIDI_CONTROL_CODE_POINTS,
  OTHER_INVISIBLE_CODE_POINTS,
  formField,
  probesFrom,
} from '@/test/text-rules';

import {
  POLICY_ALREADY_RECORDED_MESSAGE,
  POLICY_EXPIRED_MESSAGE,
  RECORD_BOUNDS,
  RECORD_INSPECTION_FIELD_MAPPING,
  RECORD_KEY_REUSED_MESSAGE,
  RECORD_POLICY_FIELD_MAPPING,
  canRecordAssetCompliance,
  parseRecordInspectionForm,
  parseRecordPolicyForm,
  recordInspectionFormSchema,
} from './asset-records';

/**
 * What the two record commands depend on, pinned to asset-service's source — the
 * technique of `asset-lifecycle-commands.contract.spec.ts`: A-02 forbids
 * importing `services/*\/src`, so the portal keeps copies and this test fails the
 * moment a copy and its original disagree. The reader refuses anything it cannot
 * read literally rather than skipping it. Every file read here is a test input
 * of this package in `turbo.json`, so a change to one of them reruns this spec.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');
const ASSET = ['services', 'asset-service', 'src', 'asset'] as const;
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
  return found[0]!;
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

const squash = (text: string | undefined) => text?.replace(/\s+/g, '');

const dto = parse(read(...ASSET, 'dto.ts'));
const controller = parse(read(...ASSET, 'asset.controller.ts'));
const insuranceSource = read(
  'services',
  'asset-service',
  'src',
  'insurance',
  'insurance.service.ts',
);
const rastaErrorSource = read('packages', 'nest-common', 'src', 'errors', 'rasta-error.ts');

/** The `key: initializer` properties of the schema's own object literal. */
function schemaProperties(name: string): Map<string, string> {
  const schema = topLevelConst(dto, name);
  const literal = collect(schema, ts.isObjectLiteralExpression)[0];
  if (!literal) throw new Error(`\`${name}\` has no object literal`);
  const out = new Map<string, string>();
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property))
      out.set(property.name.getText(), property.initializer.getText());
    else if (ts.isShorthandPropertyAssignment(property)) out.set(property.name.getText(), '');
  }
  return out;
}

const literalsOf = (text: string | undefined): string[] =>
  collect(parse(`const x = ${text}`), ts.isStringLiteral).map((node) => node.text);

const handler = (method: string): ts.MethodDeclaration => {
  const declaration = collect(controller, ts.isMethodDeclaration).find(
    (node) => node.name.getText() === method,
  );
  if (!declaration) throw new Error(`no handler \`${method}\``);
  return declaration;
};

const decorator = (method: string, name: string): ts.CallExpression | undefined =>
  (ts.getDecorators(handler(method)) ?? [])
    .map((candidate) => candidate.expression)
    .filter(ts.isCallExpression)
    .find((call) => call.expression.getText() === name);

const HANDLERS = [
  ['recordPolicy', "':id/insurance-policies'", 'createPolicySchema'],
  ['recordInspection', "':id/inspections'", 'createInspectionSchema'],
] as const;

describe('who may record', () => {
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

  it.each(HANDLERS)(
    'is the same set of roles for %s as the portal offers the forms to',
    (method) => {
      const roles = decorator(method, 'Roles');
      if (!roles) throw new Error(`\`${method}\` has no @Roles`);
      const admitted = roles.arguments.map((argument) => {
        if (!ts.isStringLiteral(argument)) throw new Error('a role that is not a literal');
        return argument.text;
      });
      expect(admitted.length).toBeGreaterThan(0);
      const offered = EVERY_ROLE.filter((role) => canRecordAssetCompliance([role]));
      expect(offered.sort()).toEqual(EVERY_ROLE.filter((role) => admitted.includes(role)).sort());
    },
  );

  it.each(HANDLERS)('still serves %s at the path the portal posts to', (method, path) => {
    expect(decorator(method, 'Post')?.arguments.map((argument) => argument.getText())).toEqual([
      path,
    ]);
  });
});

describe('the replay key', () => {
  it.each(HANDLERS)(
    '%s reads the Idempotency-Key header, requires it, and runs under the idempotency store',
    (method) => {
      const text = squash(handler(method).getText()) ?? '';
      expect(text).toContain("@Headers('idempotency-key')");
      expect(text).toContain('requiredIdempotencyKey(idempotencyKey)');
      expect(text).toContain('this.idempotency.execute');
      // The asset is part of what the key is bound to.
      expect(text).toContain('{assetId:id,...dto}');
      expect(text).toContain(',201,');
    },
  );

  it.each(HANDLERS)('%s documents the header as required', (method) => {
    expect(decorator(method, 'ApiHeader')?.arguments[0]?.getText()).toBe('IDEMPOTENCY_KEY_HEADER');
    expect(squash(topLevelConst(controller, 'IDEMPOTENCY_KEY_HEADER').getText())).toMatch(
      /required:true/,
    );
  });
});

describe('the request bodies', () => {
  it.each(['createPolicySchema', 'createInspectionSchema'])('%s is strict', (name) => {
    expect(squash(topLevelConst(dto, name).getText())).toMatch(/\.strict\(\)\.refine\(/);
  });

  it('takes the fields the policy form sends, and requires the ones the form always sends', () => {
    const properties = schemaProperties('createPolicySchema');
    expect([...properties.keys()].sort()).toEqual(
      [
        'policyNumber',
        'insurerName',
        'coverage',
        'premiumMinor',
        'insuredValueMinor',
        'validFrom',
        'validTo',
        'documentId',
      ].sort(),
    );
    const optional = [...properties].filter(([, text]) => /\.optional\(\)$/.test(text));
    // What the portal may leave out is exactly what the service lets it leave out
    // (documents are not uploaded from this form).
    expect(optional.map(([key]) => key).sort()).toEqual(
      ['premiumMinor', 'insuredValueMinor', 'documentId'].sort(),
    );
  });

  it('takes the fields the inspection form sends, and requires the ones the form always sends', () => {
    const properties = schemaProperties('createInspectionSchema');
    expect([...properties.keys()].sort()).toEqual(
      [
        'certificateNo',
        'centerName',
        'inspectedAt',
        'validTo',
        'result',
        'notes',
        'documentId',
      ].sort(),
    );
    const optional = [...properties].filter(([, text]) => /\.optional\(\)$/.test(text));
    expect(optional.map(([key]) => key).sort()).toEqual(
      ['centerName', 'notes', 'documentId'].sort(),
    );
  });

  it('takes the coverages the policy form offers, and no others', () => {
    expect(literalsOf(schemaProperties('createPolicySchema').get('coverage'))).toEqual([
      ...POLICY_COVERAGES,
    ]);
  });

  it('takes the results the inspection form offers, and no others', () => {
    expect(literalsOf(schemaProperties('createInspectionSchema').get('result'))).toEqual([
      ...INSPECTION_RESULTS,
    ]);
  });

  it('bounds the policy number and the certificate number as the forms do', () => {
    const policy = schemaProperties('createPolicySchema');
    const inspection = schemaProperties('createInspectionSchema');
    expect(squash(policy.get('policyNumber'))).toBe(
      `identifierText(${RECORD_BOUNDS.policyNumber.min},${RECORD_BOUNDS.policyNumber.max})`,
    );
    expect(squash(inspection.get('certificateNo'))).toBe(
      `plainText().min(${RECORD_BOUNDS.certificateNo.min}).max(${RECORD_BOUNDS.certificateNo.max})`,
    );
  });

  it('bounds the insurer and the centre as the display text the forms hold them to', () => {
    expect(squash(schemaProperties('createPolicySchema').get('insurerName'))).toBe(
      `displayText(${RECORD_BOUNDS.insurerName.min},${RECORD_BOUNDS.insurerName.max}).transform(canonicalIdentifier)`,
    );
    expect(squash(schemaProperties('createInspectionSchema').get('centerName'))).toBe(
      `displayText(${RECORD_BOUNDS.centerName.min},${RECORD_BOUNDS.centerName.max}).optional()`,
    );
  });

  it('bounds the notes as the form does', () => {
    expect(squash(schemaProperties('createInspectionSchema').get('notes'))).toBe(
      `plainText().max(${RECORD_BOUNDS.notes.max}).optional()`,
    );
  });

  // `plainText()` is the platform's, from `@rasta/contracts`, so the inspection
  // form's two free-text fields are checked against the rule itself: every bidi
  // control refused by both, ZWNJ and the other invisible characters it admits
  // admitted by both.
  it.each([
    [
      'certificateNo',
      'گواهی‌۱۴۰۳-۱۲',
      plainText().min(RECORD_BOUNDS.certificateNo.min).max(RECORD_BOUNDS.certificateNo.max),
    ],
    ['notes', 'لاستیک‌ها باید تا ماه بعد عوض شوند', plainText().max(RECORD_BOUNDS.notes.max)],
  ] as const)(
    'the inspection form refuses in %s exactly what the service refuses',
    (key, sample, service) => {
      const portal = formField(recordInspectionFormSchema, key);
      const probes = probesFrom(sample, [
        ...BIDI_CONTROL_CODE_POINTS,
        ...OTHER_INVISIBLE_CODE_POINTS,
      ]);
      for (const probe of probes) {
        expect([probe, portal.safeParse(probe).success]).toEqual([
          probe,
          service.safeParse(probe).success,
        ]);
      }
      expect(probes.filter((probe) => !service.safeParse(probe).success)).toHaveLength(
        BIDI_CONTROL_CODE_POINTS.length,
      );
    },
  );

  it('takes the dates as ISO datetimes, and refuses an end that is not after the start', () => {
    for (const [name, start] of [
      ['createPolicySchema', 'validFrom'],
      ['createInspectionSchema', 'inspectedAt'],
    ] as const) {
      const properties = schemaProperties(name);
      expect(squash(properties.get(start))).toBe('z.string().datetime()');
      expect(squash(properties.get('validTo'))).toBe('z.string().datetime()');
      expect(squash(topLevelConst(dto, name).getText())).toContain(
        `newDate(v.validTo)>newDate(v.${start})`,
      );
    }
  });

  it('takes the amounts as the shared minor-unit string, optional', () => {
    const properties = schemaProperties('createPolicySchema');
    expect(squash(properties.get('premiumMinor'))).toBe('amountMinorSchema.optional()');
    expect(squash(properties.get('insuredValueMinor'))).toBe('amountMinorSchema.optional()');
  });

  it('sends a body that satisfies what it pins, for every field the forms hold', () => {
    const policy = parseRecordPolicyForm({
      policyNumber: 'POL-1',
      insurerName: 'بیمه ایران',
      coverage: 'LIABILITY',
      premium: '1',
      insuredValue: '2',
      validFrom: '2026-10-01',
      validTo: '2027-10-01',
    });
    expect(policy.ok && Object.keys(policy.body).sort()).toEqual(
      [...schemaProperties('createPolicySchema').keys()]
        .filter((key) => key !== 'documentId')
        .sort(),
    );
    const inspection = parseRecordInspectionForm({
      certificateNo: 'INSP-1',
      centerName: 'مرکز معاینه',
      inspectedAt: '2026-09-20',
      validTo: '2027-09-20',
      result: 'FAILED',
      notes: 'ن',
    });
    expect(inspection.ok && Object.keys(inspection.body).sort()).toEqual(
      [...schemaProperties('createInspectionSchema').keys()]
        .filter((key) => key !== 'documentId')
        .sort(),
    );
  });
});

describe('the field mappings', () => {
  it('place every service field on the form field that carries it', () => {
    expect(RECORD_POLICY_FIELD_MAPPING.paths).toMatchObject({
      premiumMinor: 'premium',
      insuredValueMinor: 'insuredValue',
    });
    for (const [name, mapping] of [
      ['createPolicySchema', RECORD_POLICY_FIELD_MAPPING],
      ['createInspectionSchema', RECORD_INSPECTION_FIELD_MAPPING],
    ] as const) {
      const serviceFields = [...schemaProperties(name).keys()].filter(
        (key) => key !== 'documentId',
      );
      expect(Object.keys(mapping.paths).sort()).toEqual(serviceFields.sort());
    }
  });
});

describe('what the service says, pinned to where it says it', () => {
  it('still refuses an expired policy with the sentence the portal translates', () => {
    expect(insuranceSource).toContain(
      "'This policy has already expired. Record the current policy instead.'",
    );
    expect(insuranceSource).toContain("rule: 'POLICY_ALREADY_EXPIRED'");
    expect(insuranceSource).toMatch(/if \(validTo <= new Date\(\)\)/);
    expect(POLICY_EXPIRED_MESSAGE).toMatch(/گذشته/);
  });

  it('still answers a duplicate policy with ALREADY_EXISTS for InsurancePolicy', () => {
    expect(insuranceSource).toContain("throw RastaError.alreadyExists('InsurancePolicy')");
    expect(rastaErrorSource).toContain('`${resourceType} already exists`');
    expect(POLICY_ALREADY_RECORDED_MESSAGE).toMatch(/ثبت شده/);
  });

  it('still answers a reused key with the sentence the portal translates', () => {
    expect(rastaErrorSource).toContain(
      "'This Idempotency-Key was already used with a different request body'",
    );
    expect(RECORD_KEY_REUSED_MESSAGE).toMatch(/فرم/);
  });

  it('holds the claim first and completes it last in both records', () => {
    for (const method of ['recordPolicy', 'recordInspection']) {
      const start = insuranceSource.indexOf(`async ${method}(`);
      expect(start).toBeGreaterThan(-1);
      const body = insuranceSource.slice(start, insuranceSource.indexOf('\n  }\n', start));
      expect(body).toContain('if (fence) await fence.hold(tx)');
      expect(body).toContain('return fence ? fence.complete(tx, view) : view');
      expect(body.indexOf('fence.hold')).toBeLessThan(body.indexOf('enqueueEvent'));
    }
  });
});
