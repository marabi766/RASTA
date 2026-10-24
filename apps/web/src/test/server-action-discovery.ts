import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as ts from 'typescript';

export interface ServerActionScan {
  /** A `'use server'` directive in the file's own directive prologue. */
  readonly fileLevel: boolean;
  /** `line` of every `'use server'` directive inside a function body. */
  readonly inline: readonly number[];
}

function hasDirective(statements: readonly ts.Statement[]): ts.StringLiteral | undefined {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return undefined;
    }
    if (statement.expression.text === 'use server') return statement.expression;
  }
  return undefined;
}

/**
 * Finds `'use server'` directives by parsing, not by matching text: quote style,
 * comments, blank lines and a missing semicolon do not matter, and only a
 * directive in a prologue counts (a string in the middle of a file is not one).
 */
export function scanServerActions(source: string, fileName: string): ServerActionScan {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const inline: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body)) {
      const directive = hasDirective(node.body.statements);
      if (directive) {
        inline.push(file.getLineAndCharacterOfPosition(directive.getStart(file)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { fileLevel: hasDirective(file.statements) !== undefined, inline };
}

const SOURCE = /\.(ts|tsx|js|mjs)$/;
const NOT_PRODUCTION = /(\.(spec|test)\.[a-z]+$|\.d\.ts$)/;

/**
 * Every source file under `root` (tests, declarations and `src/test` excluded) that
 * holds a server action: file-level modules by path without extension, inline
 * directives as `file:line` problems.
 */
export function discoverServerActions(root: string): { modules: string[]; inline: string[] } {
  const modules: string[] = [];
  const inline: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== join(root, 'test')) walk(full);
      } else if (SOURCE.test(entry.name) && !NOT_PRODUCTION.test(entry.name)) {
        const scan = scanServerActions(readFileSync(full, 'utf8'), full);
        if (scan.fileLevel) modules.push(full.slice(root.length + 1).replace(SOURCE, ''));
        for (const line of scan.inline) inline.push(`${full.slice(root.length + 1)}:${line}`);
      }
    }
  };
  walk(root);
  return { modules: modules.sort(), inline: inline.sort() };
}
