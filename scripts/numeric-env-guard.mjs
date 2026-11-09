// FU-287: only these pre-existing service coercions may remain; this ratchet only shrinks.
import ts from 'typescript';

export const FROZEN_RATCHET = Object.freeze(JSON.parse(`{
  "asset-service": 7,
  "audit-service": 5,
  "construction-service": 27,
  "contract-service": 15,
  "document-service": 15,
  "economic-service": 15,
  "fleet-service": 12,
  "identity-service": 10,
  "inventory-service": 5,
  "maintenance-service": 6,
  "marketplace-service": 10,
  "notification-service": 15,
  "organization-service": 1,
  "procurement-service": 15
}`));

// AST traversal ignores comments/strings and catches multiline, bracket and parenthesized forms.
function dotted(node) {
  if (!node) return '';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return dotted(node.expression);
  if (ts.isPropertyAccessExpression(node)) return `${dotted(node.expression)}.${node.name.text}`;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression))
    return `${dotted(node.expression)}.${node.argumentExpression.text}`;
  return '';
}

export function numericCoercions(source) {
  const tree = ts.createSourceFile('env.ts', source, ts.ScriptTarget.Latest, true);
  if (tree.parseDiagnostics.length) throw new Error('numeric env guard: unreadable source');
  const found = [];
  function visit(node) {
    const reference = dotted(node);
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        /^z\.coerce\.(number|bigint)$/.test(reference)) found.push(reference);
    if (ts.isCallExpression(node)) {
      const callee = dotted(node.expression);
      if (['Number', 'parseInt', 'Number.parseInt'].includes(callee)) {
        let readsEnv = false;
        function argument(child) {
          if (dotted(child) === 'process.env') readsEnv = true;
          ts.forEachChild(child, argument);
        }
        node.arguments.forEach(argument);
        if (readsEnv) found.push(`${callee}(process.env)`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

export function ratchetGrowth(current, previous) {
  return Object.entries(current).filter(([name, count]) =>
    !Number.isSafeInteger(count) || count < 1 || count > (Object.hasOwn(previous, name) ? previous[name] : 0));
}

export function checkNumericEnv(files, ratchet = FROZEN_RATCHET) {
  const remaining = { ...ratchet };
  const errors = [];
  for (const [file, source] of files) {
    const found = numericCoercions(source);
    const service = /^services\/([^/]+)\/src\/config\/env\.ts$/.exec(file)?.[1];
    const expected = service ? (ratchet[service] ?? 0) : 0;
    if (found.length !== expected || found.some((kind) => kind !== 'z.coerce.number'))
      errors.push(`${file}: numeric coercions ${found.length}, frozen count ${expected}`);
    delete remaining[service];
  }
  for (const service of Object.keys(remaining)) errors.push(`${service}: stale numeric ratchet`);
  return errors;
}

// Read only JSON from the base revision; never execute code from git.
export function readRatchet(source) {
  const json = /^export const FROZEN_RATCHET = Object\.freeze\(JSON\.parse\(`([^`]+)`\)\);$/m.exec(source)?.[1];
  if (!json) throw new Error('invalid numeric ratchet');
  return JSON.parse(json);
}
