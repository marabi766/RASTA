/**
 * @jest-environment node
 */
import { join, relative } from 'node:path';

import ts from 'typescript';

import { discoverModules } from '@/test/module-discovery';
import { KNOWN_MAPPINGS, resolveMappings } from '@/test/entry-points';

import { forbiddenText as bidForbidden } from '../app/tenders/[id]/BidCommandForm';
import { forbiddenText as ownerForbidden } from '../app/tenders/[id]/OwnerCommandForm';
import { forbiddenText as contractForbidden } from '../app/contracts/[id]/ContractCommandForm';
import { forbiddenText as statementForbidden } from '../app/contracts/[id]/StatementCommandForm';
import { blockerWording } from './availability-wording';
import { isProjectWorkflow } from './project-commands';
import { returnDispositionLabel, returnShipmentStatusLabel } from './return-fields';
import { OWNER_FORBIDDEN_TEXT } from './tender-owner-fields';
import { disputeTextLabel, presentTransactionStatus } from './labels';
import { ownText, ownValue } from './own-key';
import { GENERIC_REFUSAL_MESSAGE, mapProblemToFields, type FieldMapping } from '../server/write';

/**
 * Names every object inherits. As a key into a plain-object table they answer
 * with `Object.prototype` or a function, and React cannot render either.
 */
const INHERITED = [
  '__proto__',
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__lookupGetter__',
] as const;

describe('ownValue / ownText', () => {
  const table = { KNOWN: 'معلوم' };

  it('answers only for a key the table holds itself', () => {
    expect(ownText(table, 'KNOWN')).toBe('معلوم');
    expect(ownText(table, 'OTHER')).toBeUndefined();
    expect(ownText(undefined, 'KNOWN')).toBeUndefined();
    expect(ownText(table, null)).toBeUndefined();
    for (const key of INHERITED) {
      expect(ownValue(table, key)).toBeUndefined();
      expect(ownText(table, key)).toBeUndefined();
    }
  });

  it('answers for a table that really holds such a key', () => {
    const own = JSON.parse('{"__proto__":"x","constructor":"y"}') as Record<string, string>;
    expect(ownText(own, '__proto__')).toBe('x');
    expect(ownText(own, 'constructor')).toBe('y');
  });

  it('never returns a non-string from ownText', () => {
    const odd = { A: 1 } as unknown as Record<string, string>;
    expect(ownText(odd, 'A')).toBeUndefined();
  });
});

describe('the status of a transaction, which takes the row and not the name', () => {
  it('answers a string for an inherited name', () => {
    for (const key of INHERITED) {
      expect(typeof presentTransactionStatus({ status: key })).toBe('string');
    }
  });
});

describe('every label function of the portal', () => {
  const FUNCTIONS = discoverModules({
    dirs: ['lib'],
    marker: /export (const|function) \w+(Label|Title)\b/,
  }).flatMap(({ name, exports }) =>
    Object.entries(exports)
      .filter(([key, value]) => /(Label|Title)$/.test(key) && typeof value === 'function')
      .map(([key, value]) => [`${name}.${key}`, value as (input: string) => unknown] as const),
  );

  it('is found: the sweep below is not vacuous', () => {
    expect(FUNCTIONS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(FUNCTIONS)('%s answers a string (or null) for an inherited name', (_name, label) => {
    for (const key of INHERITED) {
      const shown = label(key);
      expect(shown === null || typeof shown === 'string').toBe(true);
    }
  });
});

describe('the other presentation tables', () => {
  it('blockerWording names the owner as a string', () => {
    for (const owner of INHERITED) {
      const wording = blockerWording({ code: 'DISPATCH_BLOCKED', owner });
      expect(typeof wording.owner).toBe('string');
      expect(wording.owner).toBe(owner);
    }
  });

  it('disputeTextLabel translates the saga’s two sentences and nothing else', () => {
    expect(disputeTextLabel('Dispute resolved: SETTLE')).toBe(
      'اعتراض با ادامهٔ تسویه به پایان رسید',
    );
    expect(disputeTextLabel('Dispute resolved: REFUND')).toBe('اعتراض با بازگشت وجه به پایان رسید');
    expect(disputeTextLabel('Dispute resolved: SETTLE ')).toBe('Dispute resolved: SETTLE ');
    expect(disputeTextLabel('کالا برگشت')).toBe('کالا برگشت');
    for (const key of INHERITED) expect(disputeTextLabel(key)).toBe(key);
  });
});

describe('every gateway-message mapping dimension', () => {
  // Every FieldMapping declaration — exported constants, factories and
  // private constants alike (test/entry-points.ts, PR-439 r1 F4).
  const RESOLVED = resolveMappings();
  const MAPPINGS = RESOLVED.mappings;

  it('is found: every declaration swept, adapted or excluded with a reason', () => {
    expect(RESOLVED.unaccounted).toEqual([]);
    expect(RESOLVED.stale).toEqual([]);
    expect(RESOLVED.discovered).toEqual(expect.arrayContaining([...KNOWN_MAPPINGS]));
    expect(MAPPINGS.length).toBeGreaterThanOrEqual(40);
  });

  const shownOf = (
    mapping: FieldMapping<string>,
    problem: Parameters<typeof mapProblemToFields>[0],
  ) => {
    const mapped = mapProblemToFields(problem, mapping);
    return [mapped.message, ...Object.values(mapped.fieldErrors)].filter(
      (text) => text !== null && text !== undefined,
    );
  };

  describe.each(MAPPINGS)('%s', (_name, mapping) => {
    it.each(INHERITED)('shows only strings for the inherited name %s', (key) => {
      const problems = [
        { code: 'VALIDATION_FAILED', message: key }, // messages, COMMON_MESSAGES, patterns
        { code: key, message: 'unmapped' }, // byCode
        { code: 'VALIDATION_FAILED', message: 'bad', details: [{ path: key, message: key }] }, // paths
        {
          code: 'VALIDATION_FAILED',
          message: 'bad',
          details: [{ path: Object.keys(mapping.paths)[0] ?? 'x', message: key, code: key }],
        }, // byDetailCode
      ];
      for (const problem of problems) {
        const shown = shownOf(mapping, problem);
        expect(shown.length).toBeGreaterThan(0);
        for (const text of shown) {
          expect(typeof text).toBe('string');
          expect(text).not.toBe(key);
          expect(String(text)).toMatch(/\p{Script=Arabic}/u);
        }
      }
    });
  });

  it('says the generic sentence for the exact case in review (message «__proto__»)', () => {
    const mapped = mapProblemToFields(
      { code: 'VALIDATION_FAILED', message: '__proto__' },
      { paths: {} },
    );
    expect(mapped.message).toBe(GENERIC_REFUSAL_MESSAGE);
  });
});

describe('the r1 reproductions (Codex PR-439 r1 F2)', () => {
  it('a gateway 403 detail code named like a prototype member is no known refusal', () => {
    for (const reasons of [[...INHERITED], ['__proto__', 'constructor']]) {
      expect(bidForbidden(reasons)).toBeNull();
      expect(contractForbidden(reasons)).toBeNull();
      expect(statementForbidden(reasons)).toBeNull();
      expect(ownerForbidden('PUBLISH', reasons)).toBe(OWNER_FORBIDDEN_TEXT.PUBLISH);
    }
  });

  it('no inherited name is a project workflow (inbox filter and mayDecide)', () => {
    for (const key of INHERITED) expect(isProjectWorkflow(key)).toBe(false);
  });

  it('labels an inherited-name status or disposition as the raw string, never an object', () => {
    for (const key of INHERITED) {
      expect(returnShipmentStatusLabel(key)).toBe(key);
      expect(returnDispositionLabel(key)).toBe(key);
    }
  });
});

describe('no key that may name an inherited property reaches a plain object (type-checked)', () => {
  // Codex PR-439 r1 F2: the regex guard trusted any lookup without a fallback
  // on the same line, so `LOGIN_REASONS[reason]` and `BID_REFUSAL_TEXT[reason]`
  // passed it. This one asks the type checker instead: an element access or an
  // `in` test, read or write, on an object (not an array, tuple or Map) whose
  // key's TYPE admits an Object.prototype name — `string`, `any`, a template
  // such as `${string}` — is an offender, wherever the key came from and
  // whatever follows it. A closed union, a number or a literal is not. Allowed:
  // own-key.ts itself; `Object.hasOwn(R, K) ? R[K] : …`; and an accumulator
  // created by `Object.create(null)`.
  const WEB = join(__dirname, '..', '..');
  const SRC = join(WEB, 'src');
  const NOT_TABLES = new Set([
    'Map',
    'ReadonlyMap',
    'Set',
    'ReadonlySet',
    'Array',
    'ReadonlyArray',
  ]);

  function offendersIn(program: ts.Program, include: (file: string) => boolean): string[] {
    const checker = program.getTypeChecker();
    const inherited = Object.getOwnPropertyNames(Object.prototype).map((name) =>
      checker.getStringLiteralType(name),
    );
    const mayBeInherited = (type: ts.Type): boolean =>
      (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 ||
      inherited.some((name) => checker.isTypeAssignableTo(name, type));
    const isPlainObject = (type: ts.Type): boolean => {
      if (type.isUnion()) return type.types.some(isPlainObject);
      if (checker.isArrayType(type) || checker.isTupleType(type)) return false;
      const name = type.getSymbol()?.getName();
      return (type.flags & ts.TypeFlags.Object) !== 0 && !(name && NOT_TABLES.has(name));
    };
    const unwrap = (node: ts.Expression): ts.Expression =>
      ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)
        ? unwrap(node.expression)
        : node;
    const nullPrototype = (receiver: ts.Expression): boolean => {
      const symbol = ts.isIdentifier(receiver) ? checker.getSymbolAtLocation(receiver) : undefined;
      return (symbol?.declarations ?? []).some((declaration) => {
        if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
        const init = unwrap(declaration.initializer);
        return /^Object\.create\(null\)$/.test(init.getText());
      });
    };
    // A server's `string` cast to a closed union (`status as ReturnStatus`) is
    // typed closed and is not: the cast, inline or in the key's declaration.
    const narrowedFromOpen = (key: ts.Expression): boolean => {
      const castOpen = (node: ts.Expression | undefined): boolean => {
        const inner = node && ts.isParenthesizedExpression(node) ? node.expression : node;
        return (
          inner !== undefined &&
          (ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner)) &&
          mayBeInherited(checker.getTypeAtLocation(inner.expression))
        );
      };
      if (castOpen(key)) return true;
      const symbol = ts.isIdentifier(key) ? checker.getSymbolAtLocation(key) : undefined;
      return (symbol?.declarations ?? []).some(
        (declaration) => ts.isVariableDeclaration(declaration) && castOpen(declaration.initializer),
      );
    };
    const hasOwnGuarded = (node: ts.ElementAccessExpression): boolean => {
      const parent = node.parent;
      if (!ts.isConditionalExpression(parent) || parent.whenTrue !== node) return false;
      const test = unwrap(parent.condition);
      return (
        ts.isCallExpression(test) &&
        test.expression.getText() === 'Object.hasOwn' &&
        test.arguments[0]?.getText() === node.expression.getText() &&
        test.arguments[1]?.getText() === node.argumentExpression.getText()
      );
    };
    const found: string[] = [];
    for (const source of program.getSourceFiles()) {
      if (!include(source.fileName)) continue;
      const visit = (node: ts.Node): void => {
        let receiver: ts.Expression | undefined;
        let key: ts.Expression | undefined;
        if (ts.isElementAccessExpression(node) && !hasOwnGuarded(node)) {
          receiver = node.expression;
          key = node.argumentExpression;
        } else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.InKeyword
        ) {
          receiver = node.right;
          key = node.left;
        }
        if (
          receiver &&
          key &&
          !ts.isStringLiteralLike(key) &&
          !ts.isNumericLiteral(key) &&
          (mayBeInherited(checker.getTypeAtLocation(key)) || narrowedFromOpen(key)) &&
          isPlainObject(checker.getTypeAtLocation(receiver)) &&
          !nullPrototype(unwrap(receiver))
        ) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          found.push(`${relative(SRC, source.fileName)}:${line + 1} ${node.getText()}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return found;
  }

  it('finds none in the portal’s sources', () => {
    const config = ts.getParsedCommandLineOfConfigFile(
      join(WEB, 'tsconfig.json'),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      },
    )!;
    const program = ts.createProgram(config.fileNames, config.options);
    const offenders = offendersIn(
      program,
      (file) =>
        file.startsWith(`${SRC}/`) &&
        !/\.(spec|test)\.|\/test\/|\.d\.ts$/.test(file) &&
        file !== join(SRC, 'lib', 'own-key.ts'),
    );
    expect(offenders).toEqual([]);
  }, 240_000);

  it('sees the shapes it exists to catch, and passes closed keys', () => {
    const snippets: Record<string, string> = {
      '/v/bad.ts': [
        "const LOGIN_REASONS: Record<string, string> = { a: 'x' };",
        'export const login = (reason: string) => LOGIN_REASONS[reason];',
        'const TABLE: { [k: string]: string } = {};',
        'export const both = (r: string) => TABLE[r] ?? r;',
        "const LABELS = { A: 'a', B: 'b' } as const;",
        'export const isOne = (k: string) => k in LABELS;',
        'export const widened = (k: string) => (LABELS as Record<string, string>)[k];',
        'export const write = (o: Record<string, string>, k: string) => { o[k] = "v"; };',
        'export const tpl = (o: Record<string, string>, k: `${string}`) => o[k];',
        "type S = 'A' | 'B';",
        "const BY_STATUS: Record<S, string> = { A: 'a', B: 'b' };",
        'export const cast = (status: string) => BY_STATUS[status as S];',
        'export const castVar = (status: string) => { const s = status as S; return BY_STATUS[s]; };',
      ].join('\n'),
      '/v/good.ts': [
        "type K = 'A' | 'B';",
        "const LABELS: Record<K, string> = { A: 'a', B: 'b' };",
        'export const closed = (k: K) => LABELS[k];',
        'export const row = (rows: string[], i: number) => rows[i];',
        "export const literal = () => LABELS['A'];",
        'export const prefixed = (o: Record<string, string>, i: number) => o[`line.${i}.x`];',
        'export const guarded = (o: Record<string, string>, k: string) =>',
        '  Object.hasOwn(o, k) ? o[k] : undefined;',
        'export const acc = (k: string) => {',
        '  const errors = Object.create(null) as Record<string, string>;',
        '  errors[k] = "x";',
        '  return errors;',
        '};',
        'export const map = (m: Map<string, string>, k: string) => m.get(k);',
        'export const suffix = (o: Record<string, string>, k: `${string}.x`) => o[k];',
      ].join('\n'),
    };
    const options: ts.CompilerOptions = {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      noEmit: true,
    };
    const host = ts.createCompilerHost(options);
    const read = host.getSourceFile.bind(host);
    host.getSourceFile = (name, version) =>
      name in snippets ? ts.createSourceFile(name, snippets[name]!, version) : read(name, version);
    host.fileExists = (name) => name in snippets || ts.sys.fileExists(name);
    const program = ts.createProgram(Object.keys(snippets), options, host);
    const found = offendersIn(program, (file) => file in snippets).map((line) =>
      line.replace(/^.*?(bad|good)\.ts/, '$1'),
    );
    expect(found.filter((line) => line.startsWith('good'))).toEqual([]);
    expect(found.filter((line) => line.startsWith('bad'))).toHaveLength(8);
  });
});
