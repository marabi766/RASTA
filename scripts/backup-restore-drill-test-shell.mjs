// The boundary the drill's test fixtures keep, as two checks over their SOURCE:
//   1. a stub waits only through holdUntil (backup-restore-drill-test-support.mjs): no shell loop
//      in any fixture source may run a command that forks, wherever the text is spelled;
//   2. no fixture source starts an asynchronous child except through the fixture owner.
// The checks read decoded string values (escapes and line continuations resolved), not source
// spelling, so `do :; sleep`, `do\<newline>sleep` and `\n` inside a JS string all read the same.
// Constant string composition is evaluated first (`'while ...; ' + 'do ...'`, a template, a
// `.concat`, a `[...].join()` over an array literal, a constant a name was bound to), so for those
// forms the text that is checked is the text that would run.
//
// WHAT THIS IS, AND IS NOT (decision D-092, as D-088 for the token boundary): a static scan that
// keeps the drill's own tests from ACCIDENTALLY polling with a forking loop or starting a child
// behind the owner's back. It is not a sandbox and does not stand against code written to get past
// it. It refuses: a loop whose head, `do` or `done` sits in a string the scan cannot join to the
// rest; a loop of the holder with a part it cannot read; a module named by an expression it cannot
// evaluate to constant strings; a name with a write it cannot evaluate (an `=`, `+=` or other
// update whose value is not constant makes every later reading of the name uncertain); and any
// expression or name with more than CAP alternatives. Known gaps, NOT refused (listed in STATUS of
// PR #532): bindings are file-wide, not lexically scoped (a parameter or inner declaration of the
// same name is not seen as a write); a `[...]` array bound to a name and joined later; computed
// `module['require']`, a parenthesised, aliased or `.call`/`.apply`'d `require`, a renamed or
// chained `createRequire`, `process.getBuiltinModule`, `Module._load`; `eval`/`Function` reached
// through an alias, a property (`globalThis.eval`) or a computed key; a computed `binding`;
// character-code calls through an alias or a computed key; and text read at run time (a file, the
// environment). Nothing here is the code under test.
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

const MARK = ' ${} ';
const MARKS = / \$\{\} (?: \$\{\} )+/g;
// Alternatives one expression or name may have. More is a spelling nobody writes by hand; it is
// refused (see `overflow`), never cut to the first CAP and read as if that were all of it.
const CAP = 4096;

const parse = (source) =>
  ts.createSourceFile('fixture.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

// Assignment operators other than `=` and `+=`: an update the evaluator does not model.
const UPDATES = new Set([
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

/**
 * What the constant strings of one source evaluate to. `evaluate(node, opaque)` returns every
 * value the expression can have (`+`, templates, `.concat`, `[...].join(...)` over an array
 * literal, `String.raw`, parentheses, conditionals, and a name: every value written to it anywhere
 * in the source, file-wide, with the marker for each write it cannot evaluate), or null when it is
 * not a string expression. A part it cannot evaluate becomes the marker ` ${} ` and is pushed to
 * `opaque`, so the caller can still read what is inside it. `overflow` collects what had more than
 * CAP alternatives.
 */
function stringEvaluator(ast) {
  const bound = new Map(); // name -> Set of values
  const overflow = new Set(); // what had more than CAP alternatives: refused by both checks
  const combine = (parts, where) => {
    let out = [''];
    for (const alternatives of parts) {
      // Unknown next to unknown is one unknown part: `s += chunk` in a loop is not a new value.
      out = [
        ...new Set(
          out.flatMap((head) => alternatives.map((tail) => (head + tail).replace(MARKS, MARK))),
        ),
      ];
      if (out.length > CAP) {
        overflow.add(where);
        out = out.slice(0, CAP);
      }
    }
    return out;
  };
  const requires = new Set(); // names bound to createRequire(...)
  const isCreateRequire = (node) =>
    ts.isCallExpression(node) &&
    ((ts.isIdentifier(node.expression) && node.expression.text === 'createRequire') ||
      (ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'createRequire'));
  const evaluate = (node, opaque = []) => {
    const part = (child) => {
      const value = evaluate(child, opaque);
      if (value) return value;
      opaque.push(child);
      return [MARK];
    };
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, opaque);
    const where = () => node.getText(ast).slice(0, 80);
    if (ts.isTemplateExpression(node))
      return combine(
        [
          [node.head.text],
          ...node.templateSpans.flatMap((span) => [part(span.expression), [span.literal.text]]),
        ],
        where(),
      );
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText() === 'String.raw')
      return evaluate(node.template, opaque);
    if (ts.isIdentifier(node)) return bound.has(node.text) ? [...bound.get(node.text)] : null;
    if (ts.isConditionalExpression(node)) {
      const whenTrue = evaluate(node.whenTrue, opaque);
      const whenFalse = evaluate(node.whenFalse, opaque);
      if (!whenTrue && !whenFalse) return null;
      const both = [...(whenTrue ?? part(node.whenTrue)), ...(whenFalse ?? part(node.whenFalse))];
      if (both.length > CAP) overflow.add(where());
      return both.slice(0, CAP);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left, opaque);
      const right = evaluate(node.right, opaque);
      if (!left && !right) return null;
      return combine([left ?? part(node.left), right ?? part(node.right)], where());
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const { expression: receiver, name } = node.expression;
      if (name.text === 'concat') {
        const head = evaluate(receiver, opaque);
        if (head) return combine([head, ...node.arguments.map(part)], where());
      }
      if (name.text === 'join' && ts.isArrayLiteralExpression(receiver)) {
        const separator = node.arguments.length > 0 ? part(node.arguments[0]) : [','];
        const items = receiver.elements.map((element) =>
          ts.isSpreadElement(element) ? (opaque.push(element), [MARK]) : part(element),
        );
        return combine(
          items.flatMap((item, at) => (at === 0 ? [item] : [separator, item])),
          where(),
        );
      }
    }
    return null;
  };
  const bind = (name, values) => {
    const known = bound.get(name) ?? new Set();
    for (const value of values)
      if (known.size < CAP || known.has(value)) known.add(value);
      else overflow.add(name);
    bound.set(name, known);
  };
  // A write whose value cannot be evaluated: the name may hold anything from then on, so every
  // reading of it has an unknown alternative (`=`), or an unknown tail on each value (`+=`).
  const unknownWrite = (name, appended) => {
    const before = bound.get(name);
    bind(name, appended && before ? combine([[...before], [MARK]], name) : [MARK]);
  };
  // Two passes: a name may be used before the line that binds it is reached.
  for (let pass = 0; pass < 2; pass++) {
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const values = evaluate(node.initializer);
        if (values) bind(node.name.text, values);
        else unknownWrite(node.name.text, false);
        if (isCreateRequire(node.initializer)) requires.add(node.name.text);
      } else if (
        ts.isBinaryExpression(node) &&
        ts.isIdentifier(node.left) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
      ) {
        const appended = node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken;
        const values = evaluate(node.right);
        if (values) {
          const before = bound.get(node.left.text);
          bind(
            node.left.text,
            appended && before ? combine([[...before], values], node.left.text) : values,
          );
        } else unknownWrite(node.left.text, appended);
        if (isCreateRequire(node.right)) requires.add(node.left.text);
      } else if (
        ts.isBinaryExpression(node) &&
        ts.isIdentifier(node.left) &&
        UPDATES.has(node.operatorToken.kind)
      )
        unknownWrite(node.left.text, false);
      else if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
        ts.isIdentifier(node.operand)
      )
        unknownWrite(node.operand.text, false);
      else if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
        ts.isIdentifier(node.initializer)
      )
        unknownWrite(node.initializer.text, false);
      else if (
        // Any other declaration of a name: a parameter, a destructured name, an import, a catch
        // variable, a function or class. Its value is not a constant string the scan can read.
        (ts.isParameter(node) ||
          ts.isBindingElement(node) ||
          ts.isImportSpecifier(node) ||
          ts.isImportClause(node) ||
          ts.isNamespaceImport(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          (ts.isVariableDeclaration(node) && ts.isCatchClause(node.parent))) &&
        node.name &&
        ts.isIdentifier(node.name)
      )
        unknownWrite(node.name.text, false);
      else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left))
      ) {
        // a destructuring assignment writes every name in its pattern
        const names = (target) => {
          if (ts.isIdentifier(target)) unknownWrite(target.text, false);
          else ts.forEachChild(target, names);
        };
        names(node.left);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return { evaluate, requires, isCreateRequire, overflow };
}

const isComposition = (node) =>
  ts.isTemplateExpression(node) ||
  (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
  (ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ['concat', 'join'].includes(node.expression.name.text)) ||
  ts.isTaggedTemplateExpression(node);

/**
 * Every string value in `source`: each literal, and each composed string as the text it composes
 * (every value a constant name can stand for); a part that is not constant becomes the marker
 * ` ${} `, and what is inside such a part is read as values of its own.
 */
export function stringValues(source) {
  return readStrings(source).values;
}

/** `stringValues`, and what had more alternatives than the scan keeps (refused by both checks). */
function readStrings(source) {
  const ast = parse(source);
  const { evaluate, overflow } = stringEvaluator(ast);
  const values = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) {
      values.push(node.text);
      return;
    }
    if (isComposition(node)) {
      const opaque = [];
      const composed = evaluate(node, opaque);
      if (composed) {
        values.push(...composed);
        opaque.forEach(visit);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { values, overflow };
}

/**
 * The shell's own reading of a decoded string: continuations joined, quoted text blanked. A
 * double-quoted text that holds a command substitution keeps one (`"$(sleep 1)"` runs sleep), read
 * without regard for escapes: a doubtful `$(` counts.
 */
function shellView(text) {
  const joined = text.replace(/\\\r?\n/g, '');
  let view = '';
  for (let at = 0; at < joined.length;) {
    const char = joined[at];
    if (char === '\\') {
      view += ' Q ';
      at += 2;
    } else if (char === "'") {
      const end = joined.indexOf("'", at + 1);
      view += ' Q ';
      at = end < 0 ? joined.length : end + 1;
    } else if (char === '"') {
      let end = at + 1;
      while (end < joined.length && joined[end] !== '"') end += joined[end] === '\\' ? 2 : 1;
      view += /\$\(|`/.test(joined.slice(at + 1, end)) ? ' Q $( ' : ' Q ';
      at = end + 1;
    } else {
      view += char;
      at++;
    }
  }
  return view;
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
 * A loop that is not whole in one string: heads, `do`s and `done`s at command position that do not
 * pair up, in a string that reads as shell (it has a separator or a bracket). Such a string is the
 * part of a loop built where this guard cannot follow (an object field, an array element, a call's
 * result), and the other part is not seen either, so neither is trusted.
 */
export function loopFragments(text) {
  const fragments = [];
  const view = shellView(text);
  const tokens = [...view.matchAll(/\n|[^\s;&|(){}]+|[;&|(){}]/g)].map(
    (match) => match.groups ?? match[0],
  );
  let heads = 0;
  let dos = 0;
  let dones = 0;
  tokens.forEach((word, at) => {
    const previous = tokens[at - 1];
    const startsCommand = at === 0 || SEPARATOR.test(previous) || SHELL_KEYWORDS.has(previous);
    if (!startsCommand) return;
    if (LOOP_KEYWORDS.has(word)) heads++;
    else if (word === 'do') dos++;
    else if (word === 'done') dones++;
  });
  if (!(heads === dos && dos === dones) && /[;&|[\n]/.test(view.trim()))
    fragments.push(`${heads} loop head(s), ${dos} do, ${dones} done`);
  for (const quoted of text.replace(/\\\r?\n/g, '').matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g))
    fragments.push(...loopFragments(quoted[1] ?? quoted[2]));
  return fragments;
}

/**
 * Violations of rule 1 in one fixture source. `holder` is true for the one file that defines
 * holdUntil: there a loop may exist, but only over builtins. Everywhere else a stub has no
 * business writing a loop at all.
 */
export function waitViolations(source, { holder = false } = {}) {
  const { values, overflow } = readStrings(source);
  const violations = [...overflow].map(
    (where) => `more than ${CAP} alternatives, which the guard does not read: ${where}`,
  );
  for (const value of values) {
    for (const loop of shellLoops(value)) {
      const forking = loop.commands.filter((command) => !BUILTINS.has(command));
      if (!holder) violations.push(`a shell loop outside holdUntil: ${loop.region}`);
      else if (loop.region.includes(MARK.trim()))
        violations.push(`holdUntil's loop has a part the guard cannot read: ${loop.region}`);
      else if (forking.length > 0)
        violations.push(`holdUntil's loop runs ${forking.join(', ')}, which forks: ${loop.region}`);
    }
    // Whole loops were judged above; what is left is a loop built from parts the guard cannot join.
    if (loopFragments(value).length > 0)
      violations.push(
        `part of a shell loop built where it cannot be read whole (${loopFragments(value).join('; ')}): ${JSON.stringify(value)}`,
      );
  }
  return violations;
}

const SYNC_ONLY = new Set(['execFileSync', 'spawnSync', 'execSync']);
// Modules that start asynchronous processes of their own.
const CHILD_PROCESS = ['child', 'process'].join('_');
// ... and `vm`, which runs code made from text.
const PROCESS_MODULES = new Set([CHILD_PROCESS, 'cluster', 'vm']);
const isChildProcess = (name) => PROCESS_MODULES.has(name.replace(/^node:/, ''));

/** The name `call` loads a module by, when it is one of the ways to load one; else null. */
function loadsModule(call, requires, isCreateRequire) {
  const callee = call.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return 'import()';
  if (ts.isIdentifier(callee) && (callee.text === 'require' || requires.has(callee.text)))
    return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ['require', 'binding'].includes(callee.name.text))
    return callee.getText();
  if (ts.isCallExpression(callee) && isCreateRequire(callee)) return 'createRequire()()';
  return null;
}

/**
 * Violations of rule 2 in one fixture source: the ways to get an asynchronous child that this scan
 * recognises (spawn, exec, execFile, fork, a namespace import, an export from the module, `require`
 * or a name bound to `createRequire(...)`, `module.require`, a dynamic import, with the module name
 * composed by the forms the evaluator folds) other than the fixture owner. A module loaded through
 * one of those calls by a name that does not evaluate to constant strings is refused; so are the
 * direct calls `eval(...)`, `Function(...)`, `new Function(...)`, the module `vm`, `.binding(...)`,
 * and the character-code calls `fromCharCode`, `fromCodePoint`, `atob`. Other spellings of these
 * (the header lists them) are not recognised. The synchronous calls finish before they return and
 * carry their own timeouts. `owner` is true for the one file that IS the fixture owner.
 */
export function spawnViolations(source, { owner = false } = {}) {
  if (owner) return [];
  const ast = parse(source);
  const { evaluate, requires, isCreateRequire, overflow } = stringEvaluator(ast);
  const violations = [];
  const overflowed = () =>
    [...overflow].map(
      (where) => `more than ${CAP} alternatives, which the guard does not read: ${where}`,
    );
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      isChildProcess(node.moduleSpecifier.text)
    ) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
      const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : clause;
      const wholly = ts.isImportDeclaration(node)
        ? clause?.name || !bindings || ts.isNamespaceImport(bindings)
        : !bindings || ts.isNamespaceExport(bindings);
      if (wholly || node.moduleSpecifier.text.replace(/^node:/, '') !== CHILD_PROCESS)
        violations.push(`child_process imported as a whole: ${node.getText(ast)}`);
      else
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (!SYNC_ONLY.has(imported))
            violations.push(`${imported} imported from child_process: use the fixture owner`);
        }
    } else if (ts.isCallExpression(node)) {
      const loads = loadsModule(node, requires, isCreateRequire);
      for (const argument of node.arguments) {
        const names = evaluate(argument);
        if (names?.some(isChildProcess))
          violations.push(`child_process reached by a call: ${node.getText(ast)}`);
        else if (
          loads &&
          argument === node.arguments[0] &&
          (!names || names.some((n) => n.includes(MARK.trim())))
        )
          violations.push(
            `${loads} names a module by something that is not a constant string: ${node.getText(ast)}`,
          );
      }
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'binding')
        violations.push(`an internal binding is a way to start a process: ${node.getText(ast)}`);
      if (loads && node.arguments.length === 0)
        violations.push(`${loads} names no module: ${node.getText(ast)}`);
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText();
      if (['fromCharCode', 'fromCodePoint', 'atob'].includes(callee))
        violations.push(
          `text built from character codes or decoded at run time: ${node.getText(ast)}`,
        );
      if (ts.isIdentifier(node.expression) && ['eval', 'Function'].includes(node.expression.text))
        violations.push(`code made from text: ${node.getText(ast)}`);
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Function'
    )
      violations.push(`code made from text: ${node.getText(ast)}`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...overflowed(), ...violations];
}
