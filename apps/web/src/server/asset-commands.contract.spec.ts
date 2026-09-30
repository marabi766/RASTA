/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { ASSET_DISPLAY_TEXT, REGISTER_ASSET_FIELD_MAPPING } from './asset-commands';

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
