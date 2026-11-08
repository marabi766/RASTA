import ts from 'typescript';

/**
 * FU-253/FU-254 class guard: a held request is let go of in ONE place (`settleRelease`,
 * `server/release-feedback.ts`), which says what happened in a signed parameter, and a page reads that
 * parameter in ONE place (`readReleaseFeedback`). The scan is over what a module is, not over a list
 * of actions: whatever it cannot prove allowed is a violation (fail closed).
 *
 *  R1 `releaseUnresolved` may be CALLED only inside the `release:` callback of a `settleRelease({…})`
 *     call. Importing it under another name, namespace-importing its module, passing it by value or
 *     re-exporting it are violations — each would let an action release without the shared tail
 *     (CSRF → consent → store → signed outcome).
 *  R2 `.release` / `['release']` / `.get('release')` / a `release` destructuring is a read of an
 *     unsigned query value unless it sits inside a `readReleaseFeedback(…)` argument (the page's one
 *     reader) or is the `release:` value of a `settleRelease({…})` call (a store's release function).
 *  R3 `RELEASE_PARAM` (the old bare-word parameter) is gone; no module may name it again.
 *  R4 No string or template builds a `release=` query by hand (an outcome that is not signed).
 *  R5 A `'use server'` export named `release*` / `reconcile*` must call `settleRelease`.
 */
export interface Violation {
  readonly rule: 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
  readonly line: number;
  readonly message: string;
}

const UNRESOLVED_MODULE = /(^|\/)unresolved-request$/;

function kindOf(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

const isNamed = (node: ts.Node | undefined, name: string): boolean =>
  node !== undefined && ts.isIdentifier(node) && node.text === name;

/** Is `node` inside `settleRelease({ …, release: <here> })`? */
function insideSettleReleaseCallback(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      ts.isPropertyAssignment(current) &&
      (isNamed(current.name, 'release') ||
        (ts.isStringLiteral(current.name) && current.name.text === 'release'))
    ) {
      const object = current.parent;
      const call = object?.parent;
      return (
        ts.isObjectLiteralExpression(object) &&
        ts.isCallExpression(call) &&
        call.arguments[0] === object &&
        isNamed(call.expression, 'settleRelease')
      );
    }
  }
  return false;
}

/** Is `node` inside an argument of a `readReleaseFeedback(…)` call? */
function insideFeedbackReader(node: ts.Node): boolean {
  for (let current: ts.Node = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (
      ts.isCallExpression(parent) &&
      isNamed(parent.expression, 'readReleaseFeedback') &&
      parent.arguments.includes(current as ts.Expression)
    ) {
      return true;
    }
  }
  return false;
}

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

/** Every violation of R1–R5 in one module's source. */
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

  const visit = (node: ts.Node): void => {
    // R1: how `releaseUnresolved` may arrive.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (UNRESOLVED_MODULE.test(node.moduleSpecifier.text)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          add('R1', node, 'namespace import of the unresolved-request module');
        }
      }
    }
    // A computed spelling (`pending['releaseUnresolved']`) is not an identifier: refuse the string itself.
    if (ts.isStringLiteralLike(node) && node.text === 'releaseUnresolved') {
      add('R1', node, 'releaseUnresolved spelled as a string');
    }
    // An alias (`import { releaseUnresolved as x }`) names it as the import's propertyName: the same rule.
    if (ts.isIdentifier(node) && node.text === 'releaseUnresolved') {
      const parent = node.parent;
      const isImportName = ts.isImportSpecifier(parent) && parent.name === node;
      if (!isImportName) {
        const isCallee = ts.isCallExpression(parent) && parent.expression === node;
        if (!isCallee || !insideSettleReleaseCallback(node)) {
          add(
            'R1',
            node,
            isCallee
              ? 'releaseUnresolved called outside the release callback of settleRelease'
              : 'releaseUnresolved used other than as the callee in settleRelease',
          );
        }
      }
    }
    // R2: an unsigned read of the release outcome.
    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'release') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'release')
    ) {
      if (!insideFeedbackReader(node) && !insideSettleReleaseCallback(node)) {
        add('R2', node, 'a `release` value read outside readReleaseFeedback');
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text === 'release' &&
      !insideFeedbackReader(node)
    ) {
      add('R2', node, "`.get('release')` read outside readReleaseFeedback");
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if (
        (ts.isIdentifier(key) && key.text === 'release') ||
        (ts.isStringLiteral(key) && key.text === 'release')
      ) {
        add('R2', node, 'a `release` destructured from an object');
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
