// The boundary the drill's test fixtures keep, as two checks over their SOURCE:
//   1. a stub waits only through holdUntil (backup-restore-drill-test-support.mjs): no shell loop
//      in any fixture source may run a command that forks, wherever the text is spelled;
//   2. no fixture source starts an asynchronous child except through the fixture owner.
// The checks read decoded string values (escapes and line continuations resolved), not source
// spelling, so `do :; sleep`, `do\<newline>sleep` and `\n` inside a JS string all read the same.
// Nothing here is the code under test.
import ts from 'typescript';

const SEPARATOR = /^[;&|(){}\n]$/;
const LOOP_KEYWORDS = new Set(['while', 'until', 'for', 'select']);
// Builtins: a command here does not fork.
const BUILTINS = new Set(['[', '[[', ':', 'read', 'test', 'true', 'break', 'continue']);
const SHELL_KEYWORDS = new Set([
  '!',
  'while',
  'until',
  'do',
  'done',
  'then',
  'else',
  'elif',
  'fi',
  'if',
]);

/** Every string value in `source`; a template's substitutions become the marker ` ${} `. */
export function stringValues(source) {
  const ast = ts.createSourceFile(
    'fixture.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const values = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      values.push(node.text);
    else if (ts.isTemplateExpression(node))
      values.push(
        node.head.text + node.templateSpans.map((span) => ` \${} ${span.literal.text}`).join(''),
      );
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return values;
}

/** The shell's own reading of a decoded string: continuations joined, quoted text blanked. */
function shellView(text) {
  return text
    .replace(/\\\r?\n/g, '')
    .replace(/'[^']*'/g, ' Q ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' Q ');
}

const wordsOf = (segment) => segment.trim().split(/\s+/).filter(Boolean);

/**
 * Each shell loop (`while`/`until`/`for`/`select` ... `do` ... `done`) found in one decoded
 * string, with the commands it runs. A command substitution counts as the command `$(`. Quoted
 * text is read again as shell of its own (`sh -c '...'`, `eval "..."`).
 */
export function shellLoops(text) {
  const loops = loopsOf(shellView(text));
  for (const quoted of text.replace(/\\\r?\n/g, '').matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g))
    loops.push(...shellLoops(quoted[1] ?? quoted[2]));
  return loops;
}

function loopsOf(view) {
  const tokens = [...view.matchAll(/\n|[^\s;&|(){}]+|[;&|(){}]/g)].map((match) => ({
    word: match[0],
    index: match.index,
  }));
  const loops = [];
  tokens.forEach((token, at) => {
    const previous = tokens[at - 1]?.word;
    const startsCommand = at === 0 || SEPARATOR.test(previous) || SHELL_KEYWORDS.has(previous);
    if (!startsCommand || !LOOP_KEYWORDS.has(token.word)) return;
    // A loop has a `do` after its head; a lone word (a list of keywords, prose) is not one.
    if (!tokens.slice(at + 1).some((later) => later.word === 'do')) return;
    // Up to the matching `done`, counting nested loops.
    let depth = 0;
    let end = tokens.length;
    for (let next = at; next < tokens.length; next++) {
      const word = tokens[next].word;
      const opens =
        LOOP_KEYWORDS.has(word) &&
        (next === at ||
          SEPARATOR.test(tokens[next - 1].word) ||
          SHELL_KEYWORDS.has(tokens[next - 1].word));
      if (opens) depth++;
      if (word === 'done' && --depth === 0) {
        end = next + 1;
        break;
      }
    }
    const region = view.slice(token.index, tokens[end - 1].index + tokens[end - 1].word.length);
    const commands = [];
    if (/\$\(|`|<\(|>\(/.test(region)) commands.push('$(');
    for (const segment of region.split(/;|&&|\|\||\||&|\n|\(|\)|\{|\}/)) {
      let words = wordsOf(segment);
      while (words.length > 0 && SHELL_KEYWORDS.has(words[0])) words = words.slice(1);
      if (words.length === 0 || LOOP_KEYWORDS.has(words[0]) || words[0] === 'in') continue;
      commands.push(words[0]);
    }
    loops.push({ keyword: token.word, region: region.replace(/\s+/g, ' ').trim(), commands });
  });
  return loops;
}

/**
 * Violations of rule 1 in one fixture source. `holder` is true for the one file that defines
 * holdUntil: there a loop may exist, but only over builtins. Everywhere else a stub has no
 * business writing a loop at all.
 */
export function waitViolations(source, { holder = false } = {}) {
  const violations = [];
  for (const value of stringValues(source))
    for (const loop of shellLoops(value)) {
      const forking = loop.commands.filter((command) => !BUILTINS.has(command));
      if (!holder) violations.push(`a shell loop outside holdUntil: ${loop.region}`);
      else if (forking.length > 0)
        violations.push(`holdUntil's loop runs ${forking.join(', ')}, which forks: ${loop.region}`);
    }
  return violations;
}

const SYNC_ONLY = new Set(['execFileSync', 'spawnSync', 'execSync']);
const isChildProcess = (name) => name === 'child_process' || name === 'node:child_process';

/**
 * Violations of rule 2 in one fixture source: any way to get an asynchronous child (spawn, exec,
 * execFile, fork, a namespace import, require, a dynamic import) other than the fixture owner.
 * The synchronous calls finish before they return and carry their own timeouts. `owner` is true
 * for the one file that IS the fixture owner.
 */
export function spawnViolations(source, { owner = false } = {}) {
  if (owner) return [];
  const ast = ts.createSourceFile(
    'fixture.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const violations = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && isChildProcess(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      if (node.importClause?.name || !bindings || ts.isNamespaceImport(bindings))
        violations.push(`child_process imported as a whole: ${node.getText(ast)}`);
      else
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (!SYNC_ONLY.has(imported))
            violations.push(`${imported} imported from child_process: use the fixture owner`);
        }
    } else if (
      ts.isStringLiteralLike(node) &&
      isChildProcess(node.text) &&
      ts.isCallExpression(node.parent)
    )
      violations.push(`child_process reached by a call: ${node.parent.getText(ast)}`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
}
