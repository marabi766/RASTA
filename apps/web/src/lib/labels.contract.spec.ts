import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import {
  ASSET_STATUSES,
  ASSET_TYPES,
  INSPECTION_RESULTS,
  TIMELINE_CATEGORIES,
} from './asset-fields';
import {
  assetStatusLabel,
  assetStatusOptions,
  assetTypeLabel,
  assetTypeOptions,
  blockerLabel,
  inspectionResultLabel,
  timelineCategoryLabel,
  timelineCategoryOptions,
} from './labels';

/**
 * The portal's asset vocabulary, pinned to asset-service's source (L5-02).
 *
 * Read as source rather than imported: A-02 forbids importing
 * `services/*\/src`, and the service's DTO module pulls in packages the
 * portal does not depend on. The files are parsed with the TypeScript
 * compiler, and **the reader refuses anything it cannot read literally** — a
 * spread into a list, a pushed variable, a schema field bound some new way.
 * A reader that skipped what it did not understand would pass exactly the
 * change it exists to catch (Codex #113 R1-3); this one fails instead, and
 * `turbo.json` makes both files inputs of this package's tests so it runs
 * when they change.
 *
 * The real fix is one vocabulary both sides import — `packages/contracts` —
 * recorded as a follow-up; this test is the guard until then.
 *
 * Both directions matter. A value the service has and the portal lacks renders
 * untranslated; a value the portal offers and the service lacks is worse — the
 * filter sends it, the service refuses it, and the page becomes an error.
 */

const ASSET_SERVICE = join(__dirname, '..', '..', '..', '..', 'services', 'asset-service', 'src');
const read = (file: string) => readFileSync(join(ASSET_SERVICE, 'asset', file), 'utf8');

// ---------------------------------------------------------------------------
// A strict reader
// ---------------------------------------------------------------------------

function parse(text: string, name = 'source.ts'): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

function where(node: ts.Node): string {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  return `${sf.fileName}:${line + 1} \`${node.getText().slice(0, 80)}\``;
}

/** The initializer of the one top-level `export const NAME = …`. */
function exportedConst(sf: ts.SourceFile, name: string): ts.Expression {
  const found: ts.Expression[] = [];
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        if (!exported || !declaration.initializer) {
          throw new Error(`${sf.fileName}: ${name} is not an exported, initialised const`);
        }
        found.push(declaration.initializer);
      }
    }
  }
  if (found.length !== 1)
    throw new Error(`${sf.fileName}: expected one ${name}, found ${found.length}`);
  return found[0]!;
}

/** The strings of `[ 'A', 'B' ]`; anything that is not a plain string literal is refused. */
function stringElements(array: ts.ArrayLiteralExpression): string[] {
  return array.elements.map((element) => {
    if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
      return element.text;
    }
    throw new Error(`cannot read list element ${where(element)}: only string literals are read`);
  });
}

/** `export const NAME = [ … ] as const`, every element a string literal. */
function literalList(sf: ts.SourceFile, name: string): string[] {
  const init = exportedConst(sf, name);
  if (
    !ts.isAsExpression(init) ||
    !ts.isTypeReferenceNode(init.type) ||
    init.type.typeName.getText() !== 'const' ||
    !ts.isArrayLiteralExpression(init.expression)
  ) {
    throw new Error(`cannot read ${name} ${where(init)}: expected a literal \`[ … ] as const\``);
  }
  return stringElements(init.expression);
}

/** Whether `callee` is `object.member`, however the source spaces or wraps it. */
function isMember(callee: ts.Expression, object: string, member: string): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === member &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === object
  );
}

/** Strips the modifiers that do not change which values a field accepts. */
function unwrapModifiers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    ['optional', 'nullable', 'default'].includes(current.expression.name.text)
  ) {
    current = current.expression.expression;
  }
  return current;
}

/** What a field's `z.enum(…)` is bound to: a named list, or inline literals. */
type Binding = { readonly list: string } | { readonly literals: readonly string[] };

function enumBinding(sf: ts.SourceFile, expression: ts.Expression, seen = 0): Binding {
  const node = unwrapModifiers(expression);
  if (ts.isIdentifier(node)) {
    // A schema defined elsewhere in the module, e.g. `assetTypeSchema`.
    if (seen > 3) throw new Error(`cannot resolve ${where(node)}: too many indirections`);
    return enumBinding(sf, exportedConst(sf, node.text), seen + 1);
  }
  if (
    ts.isCallExpression(node) &&
    isMember(node.expression, 'z', 'enum') &&
    node.arguments.length === 1
  ) {
    const [argument] = node.arguments;
    if (ts.isIdentifier(argument!)) return { list: argument.text };
    if (ts.isArrayLiteralExpression(argument!)) return { literals: stringElements(argument) };
  }
  throw new Error(`cannot read the enum binding ${where(node)}`);
}

/** The binding of `field` in the one object literal a schema is built from. */
function fieldBinding(sf: ts.SourceFile, schema: string, field: string): Binding {
  const objects: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (isMember(node.expression, 'z', 'object') ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'extend'))
    ) {
      for (const argument of node.arguments) {
        if (ts.isObjectLiteralExpression(argument)) objects.push(argument);
        else throw new Error(`cannot read ${schema}: ${where(argument)} is not an object literal`);
      }
    }
    // Refinement callbacks are not the shape; do not descend into functions.
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) {
      ts.forEachChild(node, visit);
    }
  };
  visit(exportedConst(sf, schema));
  if (objects.length !== 1) {
    throw new Error(`cannot read ${schema}: expected one object shape, found ${objects.length}`);
  }

  const matches: ts.Expression[] = [];
  for (const property of objects[0]!.properties) {
    if (ts.isSpreadAssignment(property)) {
      throw new Error(`cannot read ${schema}: ${where(property)} spreads fields in`);
    }
    if (ts.isPropertyAssignment(property) && property.name.getText() === field) {
      matches.push(property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === field) {
      throw new Error(`cannot read ${schema}.${field}: ${where(property)} is shorthand`);
    }
  }
  if (matches.length !== 1) throw new Error(`cannot find ${schema}.${field}`);
  return enumBinding(sf, matches[0]!);
}

/** The fixed and template sentences `complianceBlockers` can put in the list. */
interface Blockers {
  readonly fixed: readonly string[];
  readonly templates: readonly string[];
}

/**
 * Every sentence the service can send as a compliance blocker.
 *
 * Refuses the file unless every use of a `blockers` identifier is one this
 * reader understands: the empty list declared in `complianceBlockers`, a
 * `push` of one string or `${status}` template inside it, the returns of it,
 * and reads of the result elsewhere. A pushed variable, another mutator, a
 * second producer — anything else — fails with its location.
 */
function blockerSentences(sf: ts.SourceFile): Blockers {
  let method: ts.MethodDeclaration | undefined;
  const findMethod = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name.getText() === 'complianceBlockers') {
      if (method) throw new Error(`${where(node)}: a second complianceBlockers`);
      method = node;
    }
    ts.forEachChild(node, findMethod);
  };
  findMethod(sf);
  if (!method?.body) throw new Error(`${sf.fileName}: no complianceBlockers method to read`);
  const inMethod = (node: ts.Node) =>
    node.pos >= method!.body!.pos && node.end <= method!.body!.end;

  const fixed: string[] = [];
  const templates: string[] = [];

  const check = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'blockers') {
      throw new Error(`cannot read ${where(node)}: blockers assigned from an expression`);
    }
    if (ts.isIdentifier(node) && node.text === 'blockers') {
      const parent = node.parent;

      const declaration = ts.isVariableDeclaration(parent) && parent.name === node;
      const emptyList =
        declaration &&
        inMethod(node) &&
        parent.initializer !== undefined &&
        ts.isArrayLiteralExpression(parent.initializer) &&
        parent.initializer.elements.length === 0;
      const fromTheMethod =
        declaration &&
        !inMethod(node) &&
        parent.initializer !== undefined &&
        ts.isCallExpression(parent.initializer) &&
        ts.isPropertyAccessExpression(parent.initializer.expression) &&
        parent.initializer.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        parent.initializer.expression.name.text === 'complianceBlockers';

      const member =
        ts.isPropertyAccessExpression(parent) && parent.expression === node
          ? parent.name.text
          : undefined;
      const push =
        member === 'push' &&
        ts.isCallExpression(parent.parent) &&
        parent.parent.expression === parent &&
        inMethod(node);
      const read =
        member === 'length' ||
        ts.isShorthandPropertyAssignment(parent) ||
        (ts.isReturnStatement(parent) && inMethod(node));

      if (push) {
        const args = (parent.parent as ts.CallExpression).arguments;
        const argument = args[0];
        if (args.length !== 1 || !argument) {
          throw new Error(`cannot read ${where(parent.parent)}: expected one argument`);
        }
        if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
          fixed.push(argument.text);
        } else if (
          ts.isTemplateExpression(argument) &&
          argument.templateSpans.every((span) => ts.isIdentifier(span.expression))
        ) {
          templates.push(argument.getText().slice(1, -1));
        } else {
          throw new Error(`cannot read ${where(argument)}: only literal sentences are read`);
        }
      } else if (!(emptyList || fromTheMethod || read)) {
        throw new Error(`cannot read ${where(parent)}: an unrecognised use of blockers`);
      }
    }
    ts.forEachChild(node, check);
  };
  check(sf);

  // The method returns the list it built, and only that.
  const returns: ts.ReturnStatement[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) returns.push(node);
    if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) ts.forEachChild(node, collect);
  };
  collect(method.body);
  for (const statement of returns) {
    if (statement.expression?.getText() !== 'blockers') {
      throw new Error(`cannot read ${where(statement)}: complianceBlockers returns something else`);
    }
  }

  return { fixed, templates };
}

const DTO = parse(read('dto.ts'), 'asset-service/src/asset/dto.ts');
const SERVICE = parse(read('asset.service.ts'), 'asset-service/src/asset/asset.service.ts');

const namedList = (name: string) => literalList(DTO, name);

// ---------------------------------------------------------------------------

describe('the reader refuses what it cannot read (Codex #113 R1-3)', () => {
  it('refuses a spread into a list', () => {
    const sf = parse(`export const ASSET_TYPES = ['GRADER', ...EXTRA] as const;`);
    expect(() => literalList(sf, 'ASSET_TYPES')).toThrow(/cannot read list element/);
  });

  it('refuses a list that is not a literal', () => {
    const sf = parse(`export const ASSET_TYPES = [...BASE, 'X'].sort() as const;`);
    expect(() => literalList(sf, 'ASSET_TYPES')).toThrow(/expected a literal/);
  });

  it('refuses a pushed variable', () => {
    const sf = parse(`class S { private complianceBlockers(): string[] {
      const blockers: string[] = [];
      blockers.push(reason);
      return blockers;
    } }`);
    expect(() => blockerSentences(sf)).toThrow(/only literal sentences are read/);
  });

  it('refuses another mutator, and another producer', () => {
    const unshift = parse(`class S { private complianceBlockers(): string[] {
      const blockers: string[] = [];
      blockers.unshift('x');
      return blockers;
    } }`);
    expect(() => blockerSentences(unshift)).toThrow(/unrecognised use of blockers/);

    const elsewhere = parse(`class S {
      private complianceBlockers(): string[] { const blockers: string[] = []; return blockers; }
      dossier() { const blockers = this.complianceBlockers(); blockers.push('x'); return { blockers }; }
    }`);
    expect(() => blockerSentences(elsewhere)).toThrow(/unrecognised use of blockers/);

    const renamed = parse(`class S {
      private complianceBlockers(): string[] { const blockers: string[] = []; return blockers; }
      dossier() { return { blockers: extra }; }
    }`);
    expect(() => blockerSentences(renamed)).toThrow(/blockers assigned from an expression/);
  });

  it('refuses a schema field bound some new way', () => {
    const spread = parse(`export const q = base.extend({ ...shape }).strict();`);
    expect(() => fieldBinding(spread, 'q', 'status')).toThrow(/spreads fields in/);

    const computed = parse(`export const q = base.extend({ status: pick(STATUSES) }).strict();`);
    expect(() => fieldBinding(computed, 'q', 'status')).toThrow(/cannot read the enum binding/);

    const missing = parse(`export const q = base.extend({ type: z.enum(ASSET_TYPES) }).strict();`);
    expect(() => fieldBinding(missing, 'q', 'status')).toThrow(/cannot find q.status/);
  });
});

describe('the asset vocabulary matches asset-service', () => {
  it.each([
    ['ASSET_TYPES', ASSET_TYPES],
    ['OPERATIONAL_STATUSES', ASSET_STATUSES],
    ['TIMELINE_CATEGORIES', TIMELINE_CATEGORIES],
  ] as const)('%s, value for value and in order', (name, portal) => {
    expect([...portal]).toEqual(namedList(name));
  });

  it('the inspection result', () => {
    expect(fieldBinding(DTO, 'createInspectionSchema', 'result')).toEqual({
      literals: [...INSPECTION_RESULTS],
    });
  });

  it('is what the filters the portal sends are validated against', () => {
    // The lists above only matter if the query schemas use them.
    expect(fieldBinding(DTO, 'listAssetsQuerySchema', 'type')).toEqual({ list: 'ASSET_TYPES' });
    expect(fieldBinding(DTO, 'listAssetsQuerySchema', 'status')).toEqual({
      list: 'OPERATIONAL_STATUSES',
    });
    expect(fieldBinding(DTO, 'timelineQuerySchema', 'category')).toEqual({
      list: 'TIMELINE_CATEGORIES',
    });
  });

  it('offers exactly the service’s values as filters — nothing it would refuse', () => {
    expect(assetTypeOptions.map((o) => o.value)).toEqual(namedList('ASSET_TYPES'));
    expect(assetStatusOptions.map((o) => o.value)).toEqual(namedList('OPERATIONAL_STATUSES'));
    expect(timelineCategoryOptions.map((o) => o.value)).toEqual(namedList('TIMELINE_CATEGORIES'));
  });

  // The fallback returns the raw value, so "translated" means "came back
  // different" — and Persian, not the same Latin code under another spelling.
  it.each([
    ['type', ASSET_TYPES, assetTypeLabel],
    ['status', ASSET_STATUSES, assetStatusLabel],
    ['timeline category', TIMELINE_CATEGORIES, timelineCategoryLabel],
    ['inspection result', INSPECTION_RESULTS, inspectionResultLabel],
  ] as const)('gives every asset %s a Persian label', (_, values, label) => {
    for (const value of values) {
      expect(label(value)).not.toBe(value);
      expect(label(value)).toMatch(/^[؀-ۿ‌ ]+$/);
    }
  });
});

describe('compliance blockers match what asset-service sends', () => {
  const { fixed, templates } = blockerSentences(SERVICE);

  it('finds the blockers in the service at all', () => {
    // A refactor that moved the sentences elsewhere would otherwise leave
    // every assertion below vacuously true.
    expect(fixed.length).toBeGreaterThanOrEqual(4);
  });

  it('translates every fixed sentence the service can send', () => {
    for (const text of fixed) {
      expect(blockerLabel(text)).not.toBe(text);
      expect(blockerLabel(text)).toMatch(/[؀-ۿ]/);
    }
  });

  it('translates the status blocker, with the status in Persian too', () => {
    expect(templates).toEqual(['Asset status is ${status}']);
    for (const status of ASSET_STATUSES) {
      const label = blockerLabel(`Asset status is ${status}`);
      expect(label).toContain(assetStatusLabel(status));
      expect(label).not.toMatch(/[A-Za-z]/);
    }
  });

  it('still shows a sentence it does not know, untranslated rather than dropped', () => {
    expect(blockerLabel('Something new')).toBe('Something new');
  });
});
