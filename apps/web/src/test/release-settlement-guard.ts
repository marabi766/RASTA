import ts from 'typescript';

/**
 * FU-253/FU-254 class guard — the BACKSTOP behind a boundary that is built into the code (review 2, F1).
 *
 * The boundary: a held request is let go of in ONE place, `settleRelease` (`server/release-feedback.ts`),
 * which takes a `ReleaseScope` (`server/release-scope.ts`, built in `server/` only) and calls the store's
 * `releaseUnresolved` itself — CSRF → consent → store → signed outcome. A page reads the outcome in ONE
 * place, `readReleaseFeedback(session, subject, params, idle)`: `pageParams` withholds the `release` key,
 * so no spelling reads it raw. This scan fails closed on whatever would reach around that boundary: it
 * refuses the ways to reach the primitive (names, strings, namespaces, re-exports, dynamic loads), not
 * only one spelling of a call.
 *
 *  R1 `releaseUnresolved` is named only by `server/unresolved-request` and `server/release-feedback`; a
 *     module outside them may import `@/server/unresolved-request` only by names on ALLOWED_STORE_NAMES
 *     (or types), never as a namespace/default/`require`/`import()`, and may not `export *` or
 *     re-export from it. `app/` may not use `import()` or `export *` at all. `ReleaseScope`,
 *     `release-scope` and the page-context hand-over functions stay inside `server/`; `settleRelease`
 *     is only the one imported from `release-feedback`.
 *  R2 The unsigned `release` value is not read: no `.release` / `['release']` / `.get('release')` /
 *     destructuring in `app/`; `RELEASE_QUERY` only where the signed outcome is made and handed over;
 *     `RELEASE_FIELD` in `app/` only as the `name` of the form's hidden input.
 *  R3 `RELEASE_PARAM` (the old bare-word parameter) is gone.
 *  R4 No string or template builds a `release=` query by hand.
 *  R5 A `'use server'` export named `release*` / `reconcile*` must call `settleRelease`.
 */
export interface Violation {
  readonly rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  readonly line: number;
  readonly message: string;
}

/** What `app/`, `lib/` and the rest of `server/` may take from the unresolved-request store. */
export const ALLOWED_STORE_NAMES: ReadonlySet<string> = new Set([
  'LEGACY_UNRESOLVED_COOKIE_PREFIX',
  'mayResend',
  'purgeUnresolved',
  'readUnresolved',
  'releaseToken',
  'requestDigest',
  'reserveUnresolved',
  'settleUnresolved',
  'useUnresolvedStore',
]);

const STORE_MODULE = /(^|\/)unresolved-request$/;
const SCOPE_MODULE = /(^|\/)release-scope$/;
const PAGE_CONTEXT_MODULE = /(^|\/)page-context$/;
const FEEDBACK_MODULE = /(^|\/)release-feedback$/;
/** Names of `server/page-context` that hand over, or reach, the withheld outcome token. */
const HAND_OVER_NAMES: ReadonlySet<string> = new Set(['handOver', 'releaseTokenOf']);

/** The modules that may name the primitive / the token on purpose (paths relative to `src/`). */
const STORE_FILE = /^server\/unresolved-request\.tsx?$/;
const FEEDBACK_FILE = /^server\/release-feedback\.tsx?$/;
const PAGE_CONTEXT_FILE = /^server\/page-context\.tsx?$/;
const MESSAGES_FILE = /^lib\/release-messages\.tsx?$/;

function kindOf(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

const isNamed = (node: ts.Node | undefined, name: string): boolean =>
  node !== undefined && ts.isIdentifier(node) && node.text === name;

function hasUseServer(file: ts.SourceFile): boolean {
  for (const statement of file.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === 'use server') return true;
  }
  return false;
}

function containsCall(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(child) && isNamed(child.expression, name)) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** `name={RELEASE_FIELD}` on a JSX element: the one place `app/` spells the form field. */
function isFormFieldName(node: ts.Identifier): boolean {
  const expression = node.parent;
  const attribute = expression?.parent;
  return (
    ts.isJsxExpression(expression) &&
    ts.isJsxAttribute(attribute) &&
    ts.isIdentifier(attribute.name) &&
    attribute.name.text === 'name'
  );
}

/** Every violation of R1–R5 in one module's source; `fileName` is relative to `src/` (`app/x/page.tsx`). */
export function releaseSettlementViolations(source: string, fileName: string): Violation[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    kindOf(fileName),
  );
  const out: Violation[] = [];
  const at = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const add = (rule: Violation['rule'], node: ts.Node, message: string) =>
    out.push({ rule, line: at(node), message });

  const zone = fileName.split('/')[0];
  const inApp = zone === 'app';
  const inServer = zone === 'server';
  const isStore = STORE_FILE.test(fileName);
  const isFeedback = FEEDBACK_FILE.test(fileName);
  const mayNameToken = PAGE_CONTEXT_FILE.test(fileName) || isFeedback;
  const mayNameQuery = mayNameToken || MESSAGES_FILE.test(fileName);

  /** A module reached by `import()`, `require()`, `import … = require()` or `export … from`. */
  const checkReach = (node: ts.Node, specifier: ts.Expression | undefined, how: string): void => {
    const literal = specifier && ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
    if (how === 'import()' || how === 'require()') {
      if (inApp) add('R1', node, `${how} in app/ (a module cannot be proven allowed)`);
      else if (literal === undefined)
        add('R1', node, `${how} of a module that is not a string literal`);
    }
    if (literal === undefined) return;
    if (STORE_MODULE.test(literal) && !isStore && !isFeedback) {
      add('R1', node, `${how} of the unresolved-request module`);
    }
    if (SCOPE_MODULE.test(literal) && !inServer) {
      add('R1', node, `${how} of release-scope outside server/`);
    }
  };

  const visit = (node: ts.Node): void => {
    // Reaching the store module: only named imports of allow-listed names (or types).
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (STORE_MODULE.test(from) && !isStore && !isFeedback) {
        const bindings = clause?.namedBindings;
        if (clause === undefined)
          add('R1', node, 'side-effect import of the unresolved-request module');
        else if (clause.name !== undefined)
          add('R1', node, 'default import of the unresolved-request module');
        else if (bindings && ts.isNamespaceImport(bindings)) {
          add('R1', node, 'namespace import of the unresolved-request module');
        } else if (bindings && ts.isNamedImports(bindings) && !clause.isTypeOnly) {
          for (const element of bindings.elements) {
            const name = (element.propertyName ?? element.name).text;
            if (!element.isTypeOnly && !ALLOWED_STORE_NAMES.has(name)) {
              add('R1', element, `${name} is not on the list of store names a module may import`);
            }
          }
        }
      }
      if (SCOPE_MODULE.test(from) && !inServer) {
        add('R1', node, 'release-scope imported outside server/');
      }
      if (PAGE_CONTEXT_MODULE.test(from) && !mayNameToken) {
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          add('R1', node, 'namespace import of page-context (the withheld token is reachable)');
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (HAND_OVER_NAMES.has((element.propertyName ?? element.name).text)) {
              add('R1', element, 'the release-token hand-over of page-context imported');
            }
          }
        }
      }
      const named = clause?.namedBindings;
      if (named && ts.isNamedImports(named) && !FEEDBACK_MODULE.test(from)) {
        for (const element of named.elements) {
          if ((element.propertyName ?? element.name).text === 'settleRelease') {
            add('R1', element, 'settleRelease imported from a module other than release-feedback');
          }
        }
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkReach(node, node.moduleReference.expression, 'require()');
    }
    // `export * from` / `export { x } from` re-exports.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const from = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
      if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
        if (
          inApp ||
          STORE_MODULE.test(from) ||
          SCOPE_MODULE.test(from) ||
          FEEDBACK_MODULE.test(from)
        ) {
          add('R1', node, '`export *` re-exports names no one has listed');
        }
      } else if (STORE_MODULE.test(from) && !isStore) {
        add('R1', node, 're-export from the unresolved-request module');
      } else if (SCOPE_MODULE.test(from) && !inServer) {
        add('R1', node, 're-export of release-scope outside server/');
      }
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        checkReach(node, node.arguments[0], 'import()');
      } else if (isNamed(node.expression, 'require')) {
        checkReach(node, node.arguments[0], 'require()');
      }
    }
    // The primitive's name, in any spelling that is a string or an identifier, is the store's alone.
    if (
      ts.isStringLiteralLike(node) &&
      node.text === 'releaseUnresolved' &&
      !isStore &&
      !isFeedback
    ) {
      add('R1', node, 'releaseUnresolved spelled as a string');
    }
    if (ts.isIdentifier(node) && !isStore && !isFeedback) {
      if (node.text === 'releaseUnresolved')
        add('R1', node, 'releaseUnresolved named outside the store and settleRelease');
      if (node.text === 'ReleaseScope' && !inServer) {
        add('R1', node, 'ReleaseScope named outside server/ (a scope is built there, held here)');
      }
    }
    // `settleRelease` is the one imported from release-feedback — never a local look-alike.
    if (!isFeedback && ts.isIdentifier(node) && node.text === 'settleRelease') {
      const parent = node.parent;
      const declares =
        (ts.isFunctionDeclaration(parent) && parent.name === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isClassDeclaration(parent) && parent.name === node) ||
        (ts.isImportSpecifier(parent) && parent.name === node && parent.propertyName !== undefined);
      if (declares) add('R1', node, 'a local binding named settleRelease');
    }
    // R2: an unsigned read of the release outcome.
    if (
      inApp &&
      ((ts.isPropertyAccessExpression(node) && node.name.text === 'release') ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === 'release'))
    ) {
      add('R2', node, 'a `release` value read from an object in app/');
    }
    if (
      inApp &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === 'release'
    ) {
      add('R2', node, "`.get('release')` read in app/");
    }
    if (inApp && ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if (
        (ts.isIdentifier(key) && key.text === 'release') ||
        (ts.isStringLiteral(key) && key.text === 'release')
      ) {
        add('R2', node, 'a `release` destructured from an object');
      }
    }
    if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
      if (node.text === 'RELEASE_QUERY' && !mayNameQuery) {
        add('R2', node, 'RELEASE_QUERY names the unsigned parameter outside its owners');
      }
      if (node.text === 'RELEASE_FIELD' && inApp && !isFormFieldName(node)) {
        add('R2', node, 'RELEASE_FIELD used in app/ other than as the hidden input name');
      }
      if (HAND_OVER_NAMES.has(node.text) && !mayNameToken) {
        add('R2', node, `${node.text} reaches the withheld release token`);
      }
    }
    // R3: the retired bare-word parameter.
    if (ts.isIdentifier(node) && node.text === 'RELEASE_PARAM') {
      add('R3', node, 'RELEASE_PARAM names an unsigned outcome parameter');
    }
    // R4: a hand-built `release=` query.
    if (
      (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) &&
      /[?&]release=/.test(node.text)
    ) {
      add('R4', node, 'a release= query built by hand');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  // R5: release*/reconcile* server actions end in settleRelease.
  if (hasUseServer(file)) {
    for (const statement of file.statements) {
      const exported =
        ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        if (
          /^(release|reconcile)/i.test(statement.name.text) &&
          !containsCall(statement, 'settleRelease')
        ) {
          add('R5', statement, `${statement.name.text} does not call settleRelease`);
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            /^(release|reconcile)/i.test(declaration.name.text) &&
            !containsCall(declaration, 'settleRelease')
          ) {
            add('R5', declaration, `${declaration.name.text} does not call settleRelease`);
          }
        }
      }
    }
  }
  return out;
}

/** How many `settleRelease(` calls a module makes (for the inventory check). */
export function settleReleaseCalls(source: string, fileName: string): number {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    kindOf(fileName),
  );
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isNamed(node.expression, 'settleRelease')) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}
