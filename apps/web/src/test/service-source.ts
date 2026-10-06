import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';

/**
 * Reading another package's source as text, for the contract specs that pin a
 * portal copy of a rule to its original (A-02 forbids importing `services/*\/src`).
 *
 * The reader refuses anything it cannot read literally rather than skipping it,
 * so a service that restructures a rule makes the spec fail instead of pass for
 * having found nothing. Every file read through here is a test input of this
 * package in `turbo.json` — `turbo-inputs-guard.ts` fails a spec that reads one
 * that is not named there.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');

export const readSource = (...parts: string[]): string =>
  readFileSync(join(ROOT, ...parts), 'utf8');

export const parseSource = (text: string): ts.SourceFile =>
  ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true);

export function topLevelConst(source: ts.SourceFile, name: string): ts.Expression {
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

export function collect<T extends ts.Node>(root: ts.Node, test: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node): void => {
    if (test(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** Whitespace removed, so a reformat of the service's source does not fail a pin. */
export const squash = (text: string | undefined): string | undefined => text?.replace(/\s+/g, '');

/** The `key: initializer` properties of the first object literal in a top-level const. */
export function schemaProperties(source: ts.SourceFile, name: string): Map<string, string> {
  const literal = collect(topLevelConst(source, name), ts.isObjectLiteralExpression)[0];
  if (!literal) throw new Error(`\`${name}\` has no object literal`);
  const out = new Map<string, string>();
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property)) {
      out.set(property.name.getText(), property.initializer.getText());
    } else if (ts.isShorthandPropertyAssignment(property)) {
      out.set(property.name.getText(), '');
    }
  }
  return out;
}

export const literalsOf = (text: string | undefined): string[] =>
  collect(parseSource(`const x = ${text}`), ts.isStringLiteral).map((node) => node.text);

/** The method of a controller class, by name. */
export function handlerOf(controller: ts.SourceFile, method: string): ts.MethodDeclaration {
  const declaration = collect(controller, ts.isMethodDeclaration).find(
    (node) => node.name.getText() === method,
  );
  if (!declaration) throw new Error(`no handler \`${method}\``);
  return declaration;
}

/** A decorator call on a controller method, by name. */
export function decoratorOf(
  controller: ts.SourceFile,
  method: string,
  name: string,
): ts.CallExpression | undefined {
  return (ts.getDecorators(handlerOf(controller, method)) ?? [])
    .map((candidate) => candidate.expression)
    .filter(ts.isCallExpression)
    .find((call) => call.expression.getText() === name);
}

/** The string literals a `@Roles(...)` decorator names; anything else is refused. */
export function rolesOf(controller: ts.SourceFile, method: string): string[] {
  const roles = decoratorOf(controller, method, 'Roles');
  if (!roles) throw new Error(`\`${method}\` has no @Roles`);
  return roles.arguments.map((argument) => {
    if (!ts.isStringLiteral(argument)) throw new Error('a role that is not a literal');
    return argument.text;
  });
}
