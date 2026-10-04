/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainText } from '@rasta/contracts';
import ts from 'typescript';

import type { UpdateAssetFormValues } from '@/lib/asset-form-fields';
import {
  BIDI_CONTROL_CODE_POINTS,
  OTHER_INVISIBLE_CODE_POINTS,
  formField,
  probesFrom,
} from '@/test/text-rules';

import {
  ASSET_DISPLAY_TEXT,
  ASSET_EDIT_CONFLICT_MESSAGE,
  REGISTER_ASSET_FIELD_MAPPING,
  UPDATE_ASSET_FIELD_MAPPING,
  parseUpdateAssetForm,
  registerAssetFormSchema,
} from './asset-commands';

/**
 * The character rule and the sentences the asset form depends on, pinned to
 * asset-service's source.
 *
 * The same technique as `lib/labels.contract.spec.ts`, and for the same
 * reason: A-02 forbids importing `services/*\/src`, so the portal keeps a copy
 * and this test fails the moment the copy and the original disagree. The
 * reader **refuses anything it cannot read literally** rather than skipping
 * it — a reader that skipped what it did not understand would pass exactly the
 * change it exists to catch. `apps/web/turbo.json` already lists both files as
 * inputs of this package's tests, so a cached run is invalidated when they
 * change.
 */

const ASSET_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'services',
  'asset-service',
  'src',
  'asset',
);
const read = (file: string) => readFileSync(join(ASSET_DIR, file), 'utf8');

function parse(text: string): ts.SourceFile {
  return ts.createSourceFile('dto.ts', text, ts.ScriptTarget.Latest, true);
}

/** The initializer of the one top-level `const NAME = …`. */
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
  if (found.length !== 1)
    throw new Error(`expected exactly one \`const ${name}\`, found ${found.length}`);
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

describe("the service's displayText rule", () => {
  const displayText = topLevelConst(parse(read('dto.ts')), 'displayText');
  const literals = collect(displayText, ts.isRegularExpressionLiteral);

  it('is one regular expression literal the reader can take at its word', () => {
    // More than one, or none, means the rule was rebuilt in a way this test
    // cannot read — and must fail rather than pass on a guess.
    expect(literals).toHaveLength(1);
  });

  const text = literals[0]?.text ?? '';
  const closing = text.lastIndexOf('/');
  const service = new RegExp(text.slice(1, closing), text.slice(closing + 1));

  it('carries the flags the portal copy carries', () => {
    expect(service.flags).toBe(ASSET_DISPLAY_TEXT.flags);
  });

  /** Strings chosen to sit on each side of every boundary the class draws. */
  const PROBES: readonly string[] = [
    'لودر کوماتسو',
    'Komatsu WA320',
    'گریدر ۱۴۰۲',
    'گریدر ١٤٠٢',
    'می‌خواهم',
    'کلید (اصلی) «برق»',
    "O'Brien’s 4x4, 10.5 t/h: +1 - 2",
    'شماره‌ی ۱۲',
    'á',
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
    'a b',
    'خودرو 🚜',
    '日本語',
    'Москва',
    '',
    ' ',
  ];

  it.each(PROBES)('agrees with the service on %j', (probe) => {
    expect(ASSET_DISPLAY_TEXT.test(probe)).toBe(service.test(probe));
  });

  it('is not vacuous: the probes include strings both accept and refuse', () => {
    const accepted = PROBES.filter((probe) => service.test(probe)).length;
    expect(accepted).toBeGreaterThan(5);
    expect(accepted).toBeLessThan(PROBES.length - 5);
  });

  it('is the message the portal translates', () => {
    const messages = collect(displayText, ts.isStringLiteral).map((node) => node.text);
    expect(messages).toContain('Contains unsupported characters');
    expect(REGISTER_ASSET_FIELD_MAPPING.messages?.['Contains unsupported characters']).toBeTruthy();
  });
});

describe('the duplicate refusal', () => {
  it("is still raised as `RastaError.alreadyExists('Asset')`, whose message the portal translates", () => {
    const service = read('asset.service.ts');
    expect(service).toContain("RastaError.alreadyExists('Asset')");
    expect(REGISTER_ASSET_FIELD_MAPPING.messages?.['Asset already exists']).toBeTruthy();
  });
});

describe('the request bodies', () => {
  const source = parse(read('dto.ts'));

  it('still has no `type` or `serialNumber` on the update schema', () => {
    const update = topLevelConst(source, 'updateAssetSchema');
    const keys = collect(update, ts.isPropertyAssignment).map((node) => node.name.getText());
    expect(keys).toEqual(expect.arrayContaining(['name', 'assetTag', 'manufacturer', 'model']));
    expect(keys).not.toContain('type');
    expect(keys).not.toContain('serialNumber');
  });

  it('still carries the optional fields the register form sends', () => {
    const create = topLevelConst(source, 'createAssetSchema');
    const keys = collect(create, ts.isPropertyAssignment).map((node) => node.name.getText());
    expect(keys).toEqual(
      expect.arrayContaining([
        'name',
        'type',
        'assetTag',
        'manufacturer',
        'model',
        'serialNumber',
        'manufactureYear',
        'location',
        'siteName',
        'addressLine',
      ]),
    );
  });
});

describe("the service's rule for `model`", () => {
  const source = parse(read('dto.ts'));
  const text = (name: string, key: string): string => {
    const schema = topLevelConst(source, name);
    const property = collect(schema, ts.isPropertyAssignment).find(
      (node) => node.name.getText() === key,
    );
    if (!property) throw new Error(`\`${name}\` has no \`${key}\``);
    return property.initializer.getText();
  };

  // The portal sends a model under exactly this rule and no character class
  // (`modelText`). If the service changes it — a display-text class, a
  // shorter bound, a looser text rule — these fail, and the form's copy has to
  // follow.
  it.each(['createAssetSchema', 'updateAssetSchema'])(
    "is still the platform's `plainText()` of 1 to 120 characters in %s, with no character class",
    (name) => {
      expect(text(name, 'model')).toMatch(
        /^plainText\(\)\s*\.min\(1\)\s*\.max\(120\)(\s*\.nullable\(\))?\s*\.optional\(\)$/,
      );
    },
  );

  // `plainText()` comes from `@rasta/contracts`, which the portal may import:
  // so the form's field is checked against the rule itself, not a copy of it.
  // Every bidi control is refused by both, and ZWNJ and the other invisible
  // characters `plainText()` admits are admitted by both.
  const service = plainText().min(1).max(120);
  const probes = probesFrom('لودر چرخ‌دار WA320', [
    ...BIDI_CONTROL_CODE_POINTS,
    ...OTHER_INVISIBLE_CODE_POINTS,
  ]);
  const register = formField(registerAssetFormSchema, 'model');
  it.each([
    ['register', (probe: string) => register.safeParse(probe).success],
    [
      'edit',
      (probe: string) =>
        parseUpdateAssetForm({ model: probe } as UpdateAssetFormValues, ['model']).ok,
    ],
  ] as const)('the %s form refuses exactly what the service refuses', (_form, accepts) => {
    for (const probe of probes) {
      expect([probe, accepts(probe)]).toEqual([probe, service.safeParse(probe).success]);
    }
    expect(probes.filter((probe) => !service.safeParse(probe).success)).toHaveLength(
      BIDI_CONTROL_CODE_POINTS.length,
    );
  });

  it('is still the rule `name` and `manufacturer` do not share', () => {
    // If `model` ever moved to `displayText`, the portal's looser rule would be
    // wrong in the other direction, and this is where somebody would notice.
    expect(text('createAssetSchema', 'manufacturer')).toContain('displayText');
    expect(text('createAssetSchema', 'model')).not.toContain('displayText');
  });
});

describe('the edit version', () => {
  const dto = parse(read('dto.ts'));

  it('is still a **required** `expectedVersion` on the update schema; the portal always sends it', () => {
    // Since slice 5 the field is one shared constant that the update schema and
    // the three lifecycle schemas all use by name.
    const update = topLevelConst(dto, 'updateAssetSchema');
    const version = collect(update, ts.isShorthandPropertyAssignment).find(
      (node) => node.name.getText() === 'expectedVersion',
    );
    expect(version).toBeDefined();
    // Required: no `.optional()` and no default, or a direct client that omits
    // it overwrites whatever is current — the lost update this field exists
    // to prevent.
    const initializer = topLevelConst(dto, 'expectedVersion').getText().replace(/\s+/g, '');
    expect(initializer).toMatch(/^z\.(coerce\.)?number\(\)\.int\(\)\.min\(1\)$/);
  });

  it('is still carried by the asset view, which is what the form reads it from', () => {
    const view = dto.statements.find(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'AssetView',
    );
    expect(view?.members.map((member) => member.name?.getText())).toContain('version');
  });

  it('is applied in the UPDATE itself, not only checked after a read', () => {
    const service = read('asset.service.ts');
    // Unconditionally, in the `where` of the one `updateMany`: a predicate that
    // is only there when the caller sent a version is a lost update for a
    // caller that did not.
    expect(service).toMatch(
      /where:\s*\{\s*id,\s*deletedAt: null,\s*status: \{ not: 'DECOMMISSIONED' \},\s*version: expectedVersion,\s*\}/,
    );
  });

  it("answers a stale version with the platform's optimistic-lock error, whose sentence the portal translates", () => {
    const platform = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'packages',
        'nest-common',
        'src',
        'errors',
        'rasta-error.ts',
      ),
      'utf8',
    );
    expect(platform).toContain('was modified by another request; reload and retry');
    expect(read('asset.service.ts')).toContain("RastaError.optimisticLockFailed('Asset', id)");
    expect(
      UPDATE_ASSET_FIELD_MAPPING.messages?.[
        'Asset was modified by another request; reload and retry'
      ],
    ).toBe(ASSET_EDIT_CONFLICT_MESSAGE);
  });
});
