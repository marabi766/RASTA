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
// it. It FAILS CLOSED (D-096): what it cannot prove, it refuses. It refuses: a loop whose head,
// `do` or `done` sits in a string the scan cannot join to the rest; a loop of the holder with a
// part it cannot read; a module named by an expression it cannot evaluate to constant strings; a
// name with a write it cannot evaluate (an `=`, `+=` or other update whose value is not constant,
// a destructuring, a for-of / for-in / for-await-of head, a parameter, an import, a declaration
// WITHOUT an initializer (`let part;`: its value is undefined, which `join` reads as nothing), a
// `+=` that can run more than once or out of source order (inside any loop, function, callback,
// class field or static block: the name is unknown, not "extended once"): every reading of the
// name is then uncertain; a target is read through its parentheses and at any depth of a pattern);
// a name nothing gives a value to (`part = part`) is unknown, never an empty set of alternatives;
// names whose values build on each other without settling (the values are computed to a fixed
// point inside a BUDGET of rounds, generous and not proven: four per written name plus eight; a
// source still changing when it is spent, or whose values pass TABLE_BUDGET characters, is refused
// as "budget" exhausted, and only `s = s + 'x'` is called growth, because only that is proven);
// a script that reaches a shell assembled where the scan cannot follow it (the word after a shell
// flag `-c` in any array literal, the arguments of a spawning call, `execSync`, a `shell` option:
// a name whose text is built by a `+=` out of order, or composed from one, or a bare name or
// composition that is wholly unknown); and any expression or name with more than CAP alternatives.
// The values the names end with (an accumulated `s += ...` included) are read as text too.
// FALSE REFUSALS this adds, none in the eight fixture sources: a `+=` in a loop or callback makes
// the name unknown wherever it is used (only a module name or a shell script cares); a declaration
// without an initializer makes the name unknown file-wide, in every scope, shadows included (the
// scan has no lexical scopes: more refusals, never fewer); a lower-case `-c` of another tool
// (grep, psql) followed by a name the scan cannot read; a source needing more rounds than its
// budget. Known gaps, NOT refused (listed in STATUS of PR #532 and #539): bindings are file-wide,
// not lexically scoped; a `[...]` array bound to a name and joined later, or filled by `push`;
// property accumulation (`o.s += 'x'`); a script returned by a call (`['-c', build()]`,
// `holdUntil(...)` is the sanctioned one) or with constant text next to an unknown part; a `shell`
// option given by a spread; computed `module['require']`, a parenthesised, aliased or
// `.call`/`.apply`'d `require`, a renamed or chained `createRequire`, `process.getBuiltinModule`,
// `Module._load`; `eval`/`Function` reached through an alias, a property (`globalThis.eval`) or a
// computed key; a computed `binding`; character-code calls through an alias or a computed key; and
// text read at run time (a file, the environment). Nothing here is the code under test.
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
// Characters the values of all names may add up to while the fixed point is computed (see there);
// the eight fixture sources never pass 4 000.
const TABLE_BUDGET = 1_000_000;

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
const ASSIGNMENTS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ...UPDATES]);

/**
 * Code that can run more than once, or later than the code after it in the source: a loop of any
 * kind (the whole statement), a function of any kind (declaration, expression, arrow, method,
 * accessor, constructor: its callers set the order), a class static block or property initializer.
 * A `+=` inside one is applied an unknown number of times, in an unknown order.
 */
const runsOutOfOrder = (node) =>
  ts.isForStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isWhileStatement(node) ||
  ts.isDoStatement(node) ||
  ts.isFunctionLike(node) ||
  ts.isClassStaticBlockDeclaration(node) ||
  ts.isPropertyDeclaration(node);

/** `(a)`, `((a))` and the like read as what they wrap: the one place a target is normalised. */
const unwrap = (node) => {
  let inner = node;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
};

/**
 * Every name a write to `target` writes: an identifier; each name in an array or object pattern, at
 * any depth, through defaults (`[a = 1]`, `{ a = 1 }`, `{ k: a = 1 }`), rest (`...a`, `...[a]`),
 * nesting and parentheses; the same for a binding pattern of a declaration or a parameter. A
 * property or element access (`o.a`, `o[k]`) writes a property, not a name: none.
 */
function writtenNames(target, out = []) {
  const node = unwrap(target);
  if (ts.isIdentifier(node)) out.push(node.text);
  else if (ts.isArrayLiteralExpression(node) || ts.isArrayBindingPattern(node))
    for (const element of node.elements) writtenNames(element, out);
  else if (ts.isObjectLiteralExpression(node))
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) writtenNames(property.initializer, out);
      else if (ts.isShorthandPropertyAssignment(property)) out.push(property.name.text);
      else if (ts.isSpreadAssignment(property)) writtenNames(property.expression, out);
    }
  else if (ts.isObjectBindingPattern(node))
    for (const element of node.elements) writtenNames(element, out);
  else if (ts.isBindingElement(node)) writtenNames(node.name, out);
  else if (ts.isSpreadElement(node)) writtenNames(node.expression, out);
  else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    writtenNames(node.left, out); // a default: `[a = 1] = v`
  return out;
}

/**
 * What the constant strings of one source evaluate to. `evaluate(node, opaque)` returns every
 * value the expression can have (`+`, templates, `.concat`, `[...].join(...)` over an array
 * literal, `String.raw`, parentheses, conditionals, and a name: every value written to it anywhere
 * in the source, file-wide, with the marker for each write it cannot evaluate), or null when it is
 * not a string expression. A part it cannot evaluate becomes the marker ` ${} ` and is pushed to
 * `opaque`, so the caller can still read what is inside it. `overflow` collects what had more than
 * CAP alternatives.
 */
function stringEvaluator(ast, limit) {
  let bound = new Map(); // name -> Set of values, as of the last round
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
  const write = (into, name, values) => {
    const known = into.get(name) ?? new Set();
    for (const value of values)
      if (known.size < CAP || known.has(value)) known.add(value);
      else overflow.add(name);
    into.set(name, known);
  };
  // The write sites of the source, found ONCE, each with its target normalised (parentheses
  // stripped) and every name it writes enumerated, however deep in a pattern. Three kinds:
  //   'set'     a name written a value (`=`, a declaration with an initializer);
  //   'append'  `+=`;
  //   'unknown' every other write: a compound or logical update, `++`/`--`, a destructuring (an
  //             assignment, a declaration, a parameter, a catch variable), the head of a for-of,
  //             for-in or for-await-of, an import, a function or class name.
  const sites = [];
  const site = (names, kind, expression) => {
    for (const name of names) sites.push({ name, kind, expression });
  };
  // Names whose text is ASSEMBLED where the scan cannot follow the order (a `+=` in a loop, a
  // function, a callback), and what each name is made from: see `assembled` below.
  const assembledSeeds = new Set();
  const madeFrom = []; // { name, node }
  const visit = (node, repeating = false) => {
    if (ts.isVariableDeclaration(node)) {
      const names = writtenNames(node.name);
      if (node.initializer && ts.isIdentifier(node.name)) {
        site(names, 'set', node.initializer);
        madeFrom.push({ name: node.name.text, node: node.initializer });
        if (isCreateRequire(node.initializer)) requires.add(node.name.text);
      } else site(names, 'unknown'); // no initializer (`let part;`), a head, a pattern, a catch variable
    } else if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind)) {
      const target = unwrap(node.left);
      const kind = node.operatorToken.kind;
      if (ts.isIdentifier(target) && kind === ts.SyntaxKind.EqualsToken) {
        site([target.text], 'set', node.right);
        madeFrom.push({ name: target.text, node: node.right });
        if (isCreateRequire(node.right)) requires.add(target.text);
      } else if (ts.isIdentifier(target) && kind === ts.SyntaxKind.PlusEqualsToken) {
        // Applied once, in source order, only where the code runs once and in that order.
        site([target.text], repeating ? 'unknown' : 'append', node.right);
        if (repeating) assembledSeeds.add(target.text);
        if (isCreateRequire(node.right)) requires.add(target.text);
      } else site(writtenNames(target), 'unknown');
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    )
      site(writtenNames(node.operand), 'unknown');
    else if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    )
      site(writtenNames(node.initializer), 'unknown');
    else if (
      // Any other declaration of a name: a parameter (a pattern is enumerated by `writtenNames`, so
      // it is the one place that reads one), an import, a function or class (declared or an
      // expression's own name). Not a constant string the scan can read.
      (ts.isParameter(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassExpression(node)) &&
      node.name
    )
      site(writtenNames(node.name), 'unknown');
    const inside = repeating || runsOutOfOrder(node);
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(ast);
  // The names whose text is assembled out of order, and every name composed from one (`t = s + 'x'`,
  // a template with `${s}`, `t = s`): to a shell they are as unreadable as the marker. Only the
  // forms the evaluator composes are followed, not a call's arguments or a function's body: those
  // are the header's gaps, and following every identifier of an expression taints most of a file.
  const assembled = new Set(assembledSeeds);
  const readsAssembled = (node) => {
    const inner = unwrap(node);
    if (ts.isIdentifier(inner)) return assembled.has(inner.text);
    if (ts.isTemplateExpression(inner))
      return inner.templateSpans.some((span) => readsAssembled(span.expression));
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return readsAssembled(inner.left) || readsAssembled(inner.right);
    if (ts.isConditionalExpression(inner))
      return readsAssembled(inner.whenTrue) || readsAssembled(inner.whenFalse);
    if (ts.isArrayLiteralExpression(inner)) return inner.elements.some(readsAssembled);
    if (ts.isSpreadElement(inner)) return readsAssembled(inner.expression);
    if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression))
      return (
        readsAssembled(inner.expression.expression) ||
        (['concat', 'join'].includes(inner.expression.name.text) &&
          inner.arguments.some(readsAssembled))
      );
    return false;
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, node } of madeFrom)
      if (!assembled.has(name) && readsAssembled(node)) {
        assembled.add(name);
        grew = true;
      }
  }
  const written = new Set(sites.map((each) => each.name));
  // What the writes add up to, as a fixed point: a name is written from other names, so every
  // round reads the previous round's values and the rounds repeat until none changes. Values only
  // grow (a name starts with none), so a settled round is the answer. How many rounds that takes is
  // NOT bounded by the number of names: information crosses one name per round, which bounds names
  // that do not depend on each other in a cycle, but a cycle whose values are finite (the marker
  // folds repeated unknowns: `a = b + env; b = env + a` changes in rounds 0-3 and is stable in round
  // 4, two names) can take longer. So the rounds have a BUDGET, generous rather than proven (four
  // per written name plus eight; `limit` replaces it, for the tests); a source that is still changing
  // when it is spent is `unsettled` as 'budget': the guard cannot tell whether it would settle, so
  // it refuses (fail closed). Only one non-settling shape is PROVEN, and reported as 'grows': a
  // name written from its own text with a constant added (`s = s + 'x'`), which has a longer value
  // in every round. Both refuse in both checks.
  const unsettled = new Map(); // name -> 'grows' (proven) | 'budget' (not known)
  const growing = new Set(
    sites
      .filter((each) => each.kind === 'set' && growsOnItself(each.name, each.expression))
      .map((each) => each.name),
  );
  const budget = limit ?? written.size * 4 + 8;
  const empty = () => new Map([...written].map((name) => [name, new Set()]));
  const differs = (name, left, right) =>
    left.get(name).size !== right.get(name).size ||
    [...left.get(name)].some((value) => !right.get(name).has(value));
  // A name no write gave a value (it is only written from itself or from other such names:
  // `part = part`) has no value to read; that is UNKNOWN, never an empty alternative set, which
  // would read as "nothing to check". It is forced to the marker and the rounds start again.
  const forced = new Set();
  for (;;) {
    bound = empty();
    for (let round = 0; ; round++) {
      const next = empty();
      for (const name of forced) write(next, name, [MARK]);
      for (const { name, kind, expression } of sites)
        if (kind === 'unknown') write(next, name, [MARK]);
        else if (kind === 'set') write(next, name, evaluate(expression) ?? [MARK]);
      // Appends, in source order, to what the other writes gave the name: each is applied once
      // (a `+=` that is not run once, in source order, is an 'unknown' site above).
      for (const { name, kind, expression } of sites)
        if (kind === 'append') {
          const before = next.get(name);
          const values = evaluate(expression) ?? [MARK];
          write(next, name, before.size > 0 ? combine([[...before], values], name) : values);
        }
      const changed = [...written].filter((name) => differs(name, bound, next));
      bound = next;
      if (changed.length === 0) break;
      // Work is part of the budget: values that double every round (`a = b + c; b = c + a`) would
      // spend the rounds on text. A name past CAP alternatives is refused as that already.
      let text = 0;
      for (const known of next.values()) for (const value of known) text += value.length;
      if (overflow.size > 0 || text > TABLE_BUDGET) {
        for (const name of changed) unsettled.set(name, 'budget');
        break;
      }
      const grows = changed.filter((name) => growing.has(name));
      if (grows.length > 0) {
        for (const name of grows) unsettled.set(name, 'grows');
        break;
      }
      if (round + 1 >= budget) {
        for (const name of changed) unsettled.set(name, 'budget');
        break;
      }
    }
    const nothing = [...written].filter((name) => !forced.has(name) && bound.get(name).size === 0);
    if (unsettled.size > 0 || nothing.length === 0) break;
    for (const name of nothing) forced.add(name);
  }
  /** Every value a name can have once the rounds ended, for the checks that read them as text. */
  const bindings = () => bound;
  return {
    evaluate,
    requires,
    isCreateRequire,
    overflow,
    unsettled,
    bindings,
    budget,
    readsAssembled,
  };
}

/**
 * A name written from its own text with a constant added: `s = s + 'x'`, `s = 'x' + s`,
 * `` s = `${s}x` ``, through parentheses. It has a longer value than any it had, in every round.
 */
function growsOnItself(name, expression) {
  const operands = (node, out = []) => {
    const inner = unwrap(node);
    if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return operands(inner.right, operands(inner.left, out));
    if (ts.isTemplateExpression(inner)) {
      out.push(inner.head);
      for (const span of inner.templateSpans) {
        operands(span.expression, out);
        out.push(span.literal);
      }
    } else out.push(inner);
    return out;
  };
  const parts = operands(expression);
  return (
    parts.some((part) => ts.isIdentifier(part) && part.text === name) &&
    parts.some(
      (part) =>
        (ts.isStringLiteralLike(part) || ts.isTemplateLiteralToken(part)) && part.text.length > 0,
    )
  );
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

/**
 * `stringValues`, what had more alternatives than the scan keeps, and the names whose writes do
 * not settle (both refused by both checks).
 */
function readStrings(source, limit) {
  const ast = parse(source);
  const { evaluate, overflow, unsettled, bindings, readsAssembled } = stringEvaluator(ast, limit);
  const values = [];
  // A source refused for its names (too many alternatives, writes that do not settle) is refused
  // whatever else it says; its values are not computed (they can be thousands of long texts).
  if (overflow.size > 0 || unsettled.size > 0)
    return { values, overflow, unsettled, ast, evaluate, readsAssembled };
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
  // The values the names end with (an accumulated `s += ...` is no literal and no composition, yet
  // it is what reaches the shell): read as text too, once each.
  const seen = new Set(values);
  for (const known of bindings().values())
    for (const value of known)
      if (value.trim() !== '' && value !== MARK && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
  return { values, overflow, unsettled, ast, evaluate, readsAssembled };
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

/** What the scan refuses to read at all, in either check: too many alternatives, writes that do not settle. */
const unreadable = (overflow, unsettled) => [
  ...[...overflow].map(
    (where) => `more than ${CAP} alternatives, which the guard does not read: ${where}`,
  ),
  ...[...unsettled].map(([name, why]) =>
    why === 'grows'
      ? `writes to ${name} do not settle (it is built on its own text and grows without end), which the guard does not read`
      : `writes to ${name} do not settle within the budget of rounds (budget exhausted: the guard cannot tell whether they would), which the guard does not read`,
  ),
];

// A flag that makes a shell read its next word as the script (`bash -c`, `sh -lc`, `-ec`). Lower
// case only: `pg_dump -Fc` is a format, not a script.
const SHELL_FLAG = /^-[a-z]*c[a-z]*$/;
const unknownText = (values) => !values || values.some((value) => value.includes(MARK.trim()));
// The calls that start a process, or hand one a command line.
const SPAWNERS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
  'spawnOwned',
  'runOwned',
]);

/**
 * A script the scan cannot read, where a shell reads it, in either check. Refused:
 *   - a spawning call (SPAWNERS) with a name in its arguments whose text is assembled out of order
 *     (a `+=` in a loop, a function or a callback, or a name or function made from one);
 *   - the same name, in the word after a shell flag in ANY array literal (`['-c', s]`, whether the
 *     array is handed to a call or bound to a name first), and the command of `execSync` or of a
 *     call with a `shell` option that is not `false`;
 *   - a script word, or a command that is run by a shell, that is a bare name or a composition and
 *     is wholly unknown (no constant text next to the unknown part: a name written from something
 *     the scan cannot evaluate, or a name no write gave a value).
 * Not refused (a text the scan cannot read in a call result is one of the header's known gaps):
 * `['-c', holdUntil(...)]`, a call's result, a script with constant text next to an unknown part.
 */
function shellInputs(ast, evaluate, assembledIn) {
  const problems = [];
  const unread = (node) =>
    problems.push(
      `a value the guard cannot read reaches a shell: ${node.getText(ast).replace(/\s+/g, ' ').slice(0, 80)}`,
    );
  // Wholly unknown: nothing but the marker (spaces aside), or no value at all. A call is not one.
  const wholly = (node) => {
    const inner = unwrap(node);
    if (ts.isCallExpression(inner) || ts.isNewExpression(inner)) return false;
    const values = evaluate(inner);
    return (
      !values || values.some((value) => value.replace(/\s+/g, '') === MARK.replace(/\s+/g, ''))
    );
  };
  const visit = (node) => {
    if (ts.isArrayLiteralExpression(node)) {
      const flag = node.elements.findIndex(
        (element) =>
          !ts.isSpreadElement(element) && evaluate(element)?.some((v) => SHELL_FLAG.test(v)),
      );
      if (flag >= 0)
        for (const element of node.elements.slice(flag + 1)) {
          if (assembledIn(element) || wholly(element)) {
            unread(element);
            break;
          }
          // An option (`--`, `-x`) is skipped; the next word is the script, and it is read.
          if (!evaluate(element)?.every((value) => value.startsWith('-'))) break;
        }
    } else if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : node.expression.getText();
      if (SPAWNERS.has(callee))
        for (const argument of node.arguments) if (assembledIn(argument)) unread(argument);
      const viaShell =
        callee === 'execSync' ||
        node.arguments.some(
          (argument) =>
            ts.isObjectLiteralExpression(argument) &&
            argument.properties.some(
              (property) =>
                property.name?.getText() === 'shell' &&
                !(
                  ts.isPropertyAssignment(property) &&
                  property.initializer.kind === ts.SyntaxKind.FalseKeyword
                ),
            ),
        );
      if (viaShell && node.arguments.length > 0 && wholly(node.arguments[0]))
        unread(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return problems;
}

/**
 * Violations of rule 1 in one fixture source. `holder` is true for the one file that defines
 * holdUntil: there a loop may exist, but only over builtins. Everywhere else a stub has no
 * business writing a loop at all.
 */
export function waitViolations(source, { holder = false, rounds } = {}) {
  const { values, overflow, unsettled, ast, evaluate, readsAssembled } = readStrings(
    source,
    rounds,
  );
  const violations = [
    ...unreadable(overflow, unsettled),
    ...shellInputs(ast, evaluate, readsAssembled),
  ];
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
export function spawnViolations(source, { owner = false, rounds } = {}) {
  if (owner) return [];
  const ast = parse(source);
  const { evaluate, requires, isCreateRequire, overflow, unsettled, readsAssembled } =
    stringEvaluator(ast, rounds);
  const violations = [];
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
        else if (loads && argument === node.arguments[0] && unknownText(names))
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
  return [
    ...unreadable(overflow, unsettled),
    ...shellInputs(ast, evaluate, readsAssembled),
    ...violations,
  ];
}
