import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CANONICAL_ROOT = realpathSync(ROOT);

/**
 * A file's canonical repository path: its real path (links resolved) relative to
 * the repository's real root, `/`-separated; null when it is not a file on disk
 * inside the repository (stdin with no such file, another checkout), which
 * nothing grants. Every privilege in this rule — the shared boundary, both
 * allow-lists — is decided on this path and nothing else (#536 r1 F2; the same
 * shape as #503 r3's `repoPath`).
 */
export function repoPath(file) {
  try {
    const real = realpathSync(file);
    const rel = relative(CANONICAL_ROOT, real);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || !statSync(real).isFile()) {
      return null;
    }
    return rel.split(sep).join('/');
  } catch {
    return null; // not on disk: nothing to grant
  }
}

/**
 * The one file that holds the abort timer. The rule exempts it by its exact
 * canonical path — the workspace config no longer matches a suffix, so a
 * `src/http/exchange-deadline.ts` in any other workspace is checked like any
 * other file (#536 r1 F2).
 */
export const SHARED_BOUNDARY = 'packages/nest-common/src/http/exchange-deadline.ts';

/**
 * ESLint rule `internal/exchange-deadline`: an HTTP exchange's deadline belongs
 * to `exchangeWithDeadline` / `upstreamExchange` from `@rasta/nest-common`
 * (#502 r1 F1; PR #507 r1 F1/F2; #507 r2 F2).
 *
 * `fetch` settles when the headers arrive. A hand-made deadline — a
 * `setTimeout` that aborts an `AbortController`, cleared by the caller — is
 * released at whatever point the caller decides, and two things went wrong
 * there: a body read after the clear had no deadline at all, and a refusal
 * that returned without reading or cancelling its body left the connection
 * and its buffers to a peer that stalls or trickles. Both are the same
 * obligation: **a response's deadline may be released only once its body is
 * consumed or given up**. The shared boundary owns that obligation (it cancels
 * an unread body, aborts any exit that is not a clean full read, and enforces
 * the deadline itself); a hand-made timer leaves it to each caller.
 *
 * The rule does not follow a caller through its control flow, and — since
 * #507 r2 F2 — it does not follow a *name* either. Two earlier versions did
 * (clearTimeout by source order; then "the timer's callback mentions abort"),
 * and each was walked around with one more level of indirection: a wrapper
 * (`const stop = () => c.abort(); setTimeout(() => stop(), t)`), an alias, an
 * assignment, an object method, a renamed destructured `abort`, a timer
 * alias, `.call` / `.apply` / `.bind`, a computed method name. So it asks two
 * questions about the **module**, which indirection cannot change (and refuses one
 * thing it cannot read, C):
 *
 * - **A — who may hold an abort controller.** Outside `exchange-deadline.ts`,
 *   any reference to the global `AbortController` — `new`, an alias, a
 *   `globalThis.` member, a type annotation — is refused unless the file is in
 *   {@link ABORT_OWNERS}. Whoever builds the controller is whoever can build a
 *   deadline out of it; a helper elsewhere that is handed one still needs this
 *   file to make it.
 * - **B — timer and abort in one module.** A module that references
 *   `setTimeout` in ANY form (call, alias, `globalThis.setTimeout`,
 *   `timers.setTimeout`, destructured, imported — the reference is what counts,
 *   not the call) and also mentions an `abort` member or binding ANYWHERE
 *   (`c.abort`, `c['abort']`, a constant-folded computed name, a destructured
 *   `abort`, a renamed one) is refused unless it is in {@link TIMER_ABORT_MODULES}.
 *   Where the abort sits relative to the timer — inline, behind a wrapper, in
 *   another function — is not asked.
 * - **C — a global member READ by a name nobody can read.** A computed key on the
 *   global object that does not fold to a constant string and is not provably a
 *   number, bigint or symbol could be the controller or the timer, so the read is
 *   refused — fail closed, in files that may not hold a controller (#536 r1 F1,
 *   r3 N1/N2, r4 N1). Three shared pieces decide it, for member access and patterns alike:
 *   - **What a value is** (`valuesOf` for an expression, `targetValues` for a destructuring
 *     target — one resolver, each in terms of the other). A name; a variable holds EVERY
 *     value written to it (`let g; g = globalThis`); the right side of a declaration or
 *     assignment, so a CHAIN (`({ [k]: C } = g = globalThis)`) is worth its right-most value;
 *     a sequence, a conditional, a logical expression, a type assertion; a spread copy; a
 *     member of a literal object or array (`box.g[k]`, `list[0][k]`) or of the global
 *     (`globalThis.global`); a default (`function f({ [k]: C } = globalThis)`); a `for…of`
 *     head over a literal array; a nested pattern over a literal object or array; an object
 *     pattern over a literal ARRAY by index (`({ 0: { [k]: C } } = [globalThis])`); a REST
 *     element, which takes the rest of the array (`([...[{ [k]: C }]] = [globalThis])`).
 *     The answer is a set of kinds: the global object, the `timers` module, provably
 *     something else (a literal, a function, a platform name such as `process`), not
 *     provable (a parameter, a call, an import, `this`, `await`), or EXHAUSTED.
 *   - **Never a silent pass.** The resolver stops at 64 levels or 2000 steps, and running
 *     out counts as "could be the global object": refused. For a PATTERN with a computed
 *     key, any source the resolver cannot prove is not the global object is refused too (a
 *     parameter with no default — a default does not prove it, the caller may pass a value —
 *     a rest parameter, a catch clause, a call, `new`, `await`, `this`, an import, an ambient
 *     declaration, an iterator, `Object.assign({}, globalThis)`). A MEMBER read `x[k]` is
 *     refused when `x` resolves to the global object or the resolver gave up, but not when
 *     `x` is merely unknown: indexing is everywhere.
 *   - **What is a read** (`useOf`). Every use that takes the value: a plain use, a call,
 *     `.member`, every compound and logical assignment (`+=`, `||=`, `??=`, …), `++`/`--`,
 *     and every pattern (declaration, assignment, default, parameter, loop head). A pure
 *     WRITE reads nothing and is not refused: `g[k] = v` (also type-wrapped), a
 *     destructuring-assignment target (`[g[k]] = xs`, `({ a: g[k] = 1 } = o)`, rest
 *     targets), a `for…in`/`for…of` target, `delete g[k]`.
 *   - **What is not a name** (`keyKind`). Only a key PROVABLY numeric, bigint or
 *     symbol: numeric/bigint literals, unary `+ - ~` and arithmetic/bitwise of provable
 *     numerics, `NaN`/`Infinity`, `Number(…)`/`BigInt(…)`, `Math.<fn>(…)`,
 *     `Number.parseInt/parseFloat(…)`, `Math.PI` / `Number.MAX_SAFE_INTEGER`-style
 *     constants — these identifiers only when they resolve to the unshadowed global —
 *     `Symbol(…)`, `Symbol.for(…)`, `Symbol.<x>`, a constant alias of any of these, a
 *     conditional whose branches both are. Everything else (`x - 1`, `-x`, `String(1)`, a
 *     shadowed `Number`) could name a global and is refused.
 * - **Allowed:** `AbortSignal.timeout(…)` (no timer to clear; the deadline
 *   stays armed through the body), timers that no `abort` shares a module
 *   with (sleeps, outbox and consumer loops, shutdown bounds), a controller
 *   whose owner has no timer (shutdown fan-out, client-close cancellation),
 *   and the shared boundary itself, which the rule exempts by its exact
 *   canonical repository path ({@link SHARED_BOUNDARY}: real path relative to the
 *   real repo root; a file that is not on disk in this repository is exempt
 *   from nothing). Neither the workspace config nor any suffix grants it.
 *
 * **Trust model (PM decision D-095, with D-086/D-088/D-094).** This rule guards
 * against an ACCIDENTAL early-clear deadline. Deliberately obfuscated code is
 * caught by PR review, not here, and the forms below are ACCEPTED residual — they
 * produce no diagnostic, and no claim in this file or the docs says otherwise:
 *
 * - **A timer or controller host reached other than through a module-local value:**
 *   `Reflect.get(globalThis, 'setTimeout')`, a host handed in as a parameter
 *   (`h.setTimeout(…)`) or returned by a call, a qualified type annotation
 *   (`let c: globalThis.AbortController`), `timers[key]`, a timer used inside a
 *   dynamic-import callback (`import('node:timers').then((t) => t.setTimeout(…))`).
 * - **Abort reached other than by a member or binding named `abort`:**
 *   `Reflect.get(c, 'abort')`, a constant enum/object member (`c[E.A]()`), a constant
 *   conditional (`c[ok ? 'abort' : x]()`), a constant chain longer than the folding
 *   depth ({@link FOLD_DEPTH}), a name read from data (`c[name]()`).
 * - **Neither half in the module:** a timer and a controller that both come from
 *   other modules into one that owns neither — the module that owns either is the
 *   one refused.
 *
 * - **A computed MEMBER read whose object the resolver does not prove is the global
 *   object:** a call result (`getGlobal()[k]`, `Object.assign({}, globalThis)[k]`,
 *   `[globalThis].at(0)[k]`), a parameter with no default, an import, the global reached
 *   through `Reflect.get`, a member added to a literal container after it was written
 *   (`box.g = globalThis`, `list.push(globalThis)`, `Object.assign(box, …)`). (A computed key in a destructuring PATTERN over such a value is
 *   refused instead; see C — except through such an added member.) The resolver follows variables of the module only, treats an
 *   undeclared name other than `globalThis`, `window`, `self`, `global`, `frames` as a
 *   platform name (`process`), and does not model getters or proxies.
 *
 * The forms that are plausibly accidental are closed: any value that resolves to the
 * global object (an alias, a reassigned variable, a chain of assignments, a literal
 * container's member, a default, a rest slice, a loop element) and a computed global name
 * that is not a provable number or symbol, in every context that reads it (rule C). Every
 * closed form has a test; every residual form above is pinned by a test too, so that
 * changing either is visible.
 */

/**
 * The files that may hold an `AbortController`. Exact repository-relative
 * files, never a directory or a pattern — `exchange-deadline-rule.test.mjs`
 * holds every entry to an existing file and a reason. None of them sends an
 * HTTP request with a deadline of its own: the cancellation they own is a
 * shutdown, a client leaving, or a database/TCP exchange.
 */
export const ABORT_OWNERS = Object.freeze({
  'apps/web/src/lib/session-refusal.ts':
    "the browser's same-origin session probe: its own deadline, the body cancelled on every path (#507 r1 F1)",
  'services/api-gateway/src/proxy/gateway.controller.ts':
    'clientCancellation: aborts the upstream exchange when the caller closes; owns no timer',
  'services/document-service/src/scanning/clamav/clamd.client.ts':
    'clamd speaks TCP, not HTTP: one controller per socket exchange, destroyed with it',
  'services/identity-service/src/identity/membership-expiry.scanner.ts':
    'shutdown cancellation of the scan loop; the interval is not a deadline',
  'services/identity-service/src/identity/registration-intake.worker.ts':
    'shutdown cancellation of the drain loop; the interval is not a deadline',
  'services/identity-service/src/keycloak/keycloak-fence-sampler.ts':
    'shutdown cancellation of the fence sampler; the intervals are not deadlines',
  'services/identity-service/src/keycloak/keycloak-projection.consumer.ts':
    'shutdown cancellation of the projection consumer; owns no timer',
  'services/identity-service/src/keycloak/keycloak.projector.ts':
    'batch and recovery cancellation of the Keycloak projector; owns no timer',
  'services/identity-service/src/observability/outbox-gauges.ts':
    'shutdown cancellation of the gauge sampler; the interval is not a deadline',
  'services/identity-service/src/prisma/cancellation.ts':
    'statement cancellation against a database deadline (withCancellation); no HTTP exchange',
});

/**
 * The files that may reference `setTimeout` and mention `abort` in one module.
 * Same shape and same test as {@link ABORT_OWNERS}. Each is a deadline over
 * something that is not an HTTP exchange's body, or an audited transport.
 */
export const TIMER_ABORT_MODULES = Object.freeze({
  'scripts/ci-trivy-db-lib.mjs':
    "child-process time limits (spawn, then signal the group) and a tar parser's parser.abort(): no in-process HTTP exchange",
  'scripts/replay-dlq.mjs':
    'Kafka replay: transaction.abort() ends a producer transaction, not an HTTP exchange',
  'apps/web/src/lib/session-refusal.ts':
    "the browser's same-origin session probe (an audited transport): timer cleared on every path, body cancelled (#507 r1 F1)",
  'services/document-service/src/scanning/clamav/clamd.client.ts':
    'the clamd TCP exchange deadline: destroys the socket and aborts its own read; no HTTP response body',
});

const TIMER_NAMES = new Set(['setTimeout']);
const ABORT_CONTROLLER = 'AbortController';
/** Names of the global object: a timer or controller reached by member. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self', 'global', 'frames']);
/** Wrappers that say the same value again: type assertions, non-null, optional chains. */
const TYPE_WRAPPERS = new Set([
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'ChainExpression',
]);

/** `timers` and `timers/promises`, with or without the `node:` prefix. */
const TIMERS_MODULE = /^(?:node:)?timers(?:\/promises)?$/;

const FOLD_DEPTH = 8;

/** Operators whose result is a number/bigint when both operands are (a `+` of two numerics cannot concatenate). */
const NUMERIC_UNARY = new Set(['+', '-', '~']);
/** Members of the global `Math` / `Number` that are numbers (a function member is not). */
const MATH_CONSTANTS = new Set(['E', 'LN10', 'LN2', 'LOG10E', 'LOG2E', 'PI', 'SQRT1_2', 'SQRT2']);
const NUMBER_CONSTANTS = new Set([
  'EPSILON',
  'MAX_SAFE_INTEGER',
  'MAX_VALUE',
  'MIN_SAFE_INTEGER',
  'MIN_VALUE',
  'NaN',
  'NEGATIVE_INFINITY',
  'POSITIVE_INFINITY',
]);
/** `Number.<f>(…)` calls that return a number whatever they are given. */
const NUMBER_PARSERS = new Set(['parseFloat', 'parseInt']);
const NUMERIC_BINARY = new Set(['+', '-', '*', '/', '%', '**', '&', '|', '^', '<<', '>>', '>>>']);

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      controller:
        'An AbortController outside the shared boundary builds a hand-made deadline that leaves the response body, and its release, to this caller. Use exchangeWithDeadline / upstreamExchange from @rasta/nest-common (or AbortSignal.timeout for a request that needs no body handling). A file with a reason to own one joins ABORT_OWNERS in scripts/exchange-deadline-rule.mjs.',
      globalByName:
        'A member of the global object is read by a name this rule cannot read ({{text}}): it could be AbortController or setTimeout. Name the global you mean (globalThis.fetch), or use exchangeWithDeadline / upstreamExchange from @rasta/nest-common. A file with a reason to own a controller joins ABORT_OWNERS in scripts/exchange-deadline-rule.mjs.',
      timerAbort:
        'This module references a timer ({{timer}}) and mentions abort ({{abort}}): however they are connected, that is a hand-made abort timer, which leaves the response body, and its release, to this caller. Use exchangeWithDeadline / upstreamExchange from @rasta/nest-common (or AbortSignal.timeout for a request that needs no body handling). A deadline over something that is not an HTTP exchange joins TIMER_ABORT_MODULES in scripts/exchange-deadline-rule.mjs with a reason.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    // The canonical path, or null (not a file of this repository): null is
    // exempt from nothing.
    const file = repoPath(context.physicalFilename);
    if (file === SHARED_BOUNDARY) return {};
    const mayHoldController = file !== null && Object.hasOwn(ABORT_OWNERS, file);
    const mayPairTimerAndAbort = file !== null && Object.hasOwn(TIMER_ABORT_MODULES, file);

    const scopeOf = (node) => {
      for (let at = node; at; at = at.parent) {
        const scope = sourceCode.scopeManager.acquire(at, true);
        if (scope) return scope;
      }
      return sourceCode.scopeManager.globalScope;
    };

    /** The value of a string-valued expression built from constants, if it is one. */
    const constantString = (node, depth = 0) => {
      if (!node || depth > FOLD_DEPTH) return undefined;
      switch (node.type) {
        case 'Literal':
          return typeof node.value === 'string' ? node.value : undefined;
        case 'TemplateLiteral': {
          let text = node.quasis[0].value.cooked;
          for (let i = 0; i < node.expressions.length; i++) {
            const part = constantString(node.expressions[i], depth + 1);
            if (part === undefined) return undefined;
            text += part + node.quasis[i + 1].value.cooked;
          }
          return text;
        }
        case 'BinaryExpression': {
          if (node.operator !== '+') return undefined;
          const left = constantString(node.left, depth + 1);
          const right = constantString(node.right, depth + 1);
          return left === undefined || right === undefined ? undefined : left + right;
        }
        case 'TSAsExpression':
        case 'TSSatisfiesExpression':
        case 'TSNonNullExpression':
        case 'TSTypeAssertion':
          return constantString(node.expression, depth + 1);
        case 'Identifier':
          return constantString(constantBinding(node), depth + 1);
        default:
          return undefined;
      }
    };

    /**
     * The initializer of a `const` (or a `let` never reassigned) read through its binding:
     * one declaration, a plain identifier id, no write after the initializer. The one
     * place "a constant alias" is decided, for strings, keys and containers alike.
     */
    const constantBinding = (identifier) => {
      const variable = variableOf(identifier);
      if (!variable || variable.defs.length !== 1) return undefined;
      const [def] = variable.defs;
      if (def.type !== 'Variable' || def.node.id !== def.name) return undefined;
      if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return undefined;
      return def.node.init ?? undefined;
    };

    /** `node` is the platform's global of that name — no declaration of the module answers it. */
    const isUnshadowedGlobal = (node, name) => {
      if (node?.type !== 'Identifier' || node.name !== name) return false;
      const variable = variableOf(node);
      return !variable || variable.defs.length === 0;
    };

    /**
     * THE key classifier, shared by member access (`globalThis[key]`) and patterns
     * (`{ [key]: C } = globalThis`): what a computed key provably is, when it is
     * provably not a string — 'numeric' (number or bigint) or 'symbol' — and
     * undefined for anything else, which could be the name `AbortController` /
     * `setTimeout` and so fails closed (#536 r3 N2). Proof, not guess:
     *
     * - numeric: a number/bigint literal; unary `+ - ~` and arithmetic/bitwise
     *   (`+ - * / % ** & | ^ << >> >>>`) of provably numeric operands (a `+` of two
     *   numerics cannot concatenate); the global `NaN` / `Infinity`; a call of the
     *   global `Number` / `BigInt` — all only when the identifier resolves to the
     *   unshadowed global, never to a module's own `Number`;
     * - symbol: `Symbol(…)`, `Symbol.for(…)`, `Symbol.<well-known>` of the global `Symbol`;
     * - a constant alias inherits (`const n = -1; globalThis[n]`); both branches of a
     *   conditional must agree on being provable; type wrappers are looked through.
     */
    const keyKind = (key, depth = 0) => {
      const at = unwrapped(key);
      if (!at || depth > FOLD_DEPTH) return undefined;
      const inner = (node) => keyKind(node, depth + 1);
      switch (at.type) {
        case 'Literal':
          return typeof at.value === 'number' || typeof at.value === 'bigint'
            ? 'numeric'
            : undefined;
        case 'UnaryExpression':
          return NUMERIC_UNARY.has(at.operator) && inner(at.argument) === 'numeric'
            ? 'numeric'
            : undefined;
        case 'BinaryExpression':
          return NUMERIC_BINARY.has(at.operator) &&
            inner(at.left) === 'numeric' &&
            inner(at.right) === 'numeric'
            ? 'numeric'
            : undefined;
        case 'ConditionalExpression': {
          const yes = inner(at.consequent);
          const no = inner(at.alternate);
          return yes === undefined || no === undefined ? undefined : yes === no ? yes : 'mixed';
        }
        case 'Identifier':
          if (isUnshadowedGlobal(at, 'NaN') || isUnshadowedGlobal(at, 'Infinity')) return 'numeric';
          return inner(constantBinding(at));
        case 'CallExpression': {
          const callee = unwrapped(at.callee);
          if (isUnshadowedGlobal(callee, 'Number') || isUnshadowedGlobal(callee, 'BigInt')) {
            return 'numeric';
          }
          // `Math.floor(x)`, `Number.parseInt(x)`: a number whatever x is.
          if (callee.type === 'MemberExpression' && !callee.computed) {
            const method = callee.property.name;
            const owner = unwrapped(callee.object);
            if (isUnshadowedGlobal(owner, 'Math')) return 'numeric';
            if (isUnshadowedGlobal(owner, 'Number') && NUMBER_PARSERS.has(method)) {
              return 'numeric';
            }
          }
          if (
            isUnshadowedGlobal(callee, 'Symbol') ||
            (callee.type === 'MemberExpression' &&
              !callee.computed &&
              callee.property.name === 'for' &&
              isUnshadowedGlobal(callee.object, 'Symbol'))
          ) {
            return 'symbol';
          }
          return undefined;
        }
        case 'MemberExpression': {
          if (isUnshadowedGlobal(at.object, 'Symbol')) return 'symbol';
          const member = at.computed ? undefined : at.property.name;
          if (isUnshadowedGlobal(at.object, 'Math') && MATH_CONSTANTS.has(member)) return 'numeric';
          if (isUnshadowedGlobal(at.object, 'Number') && NUMBER_CONSTANTS.has(member)) {
            return 'numeric';
          }
          return undefined;
        }
        default:
          return undefined;
      }
    };
    /** A computed key that could name a global: everything not provably a number or a symbol. */
    const mayNameAGlobal = (key) => keyKind(key) === undefined;

    /** The name a member access / pattern key spells, when it is a constant. */
    const keyName = (key, computed) => {
      if (!computed) {
        if (key.type === 'Identifier') return key.name;
        if (key.type === 'Literal') return String(key.value);
        return undefined;
      }
      // A number/bigint literal names the member of that text (`a[0]` is `a['0']`).
      if (
        key.type === 'Literal' &&
        (typeof key.value === 'number' || typeof key.value === 'bigint')
      ) {
        return String(key.value);
      }
      return constantString(key);
    };

    const variableOf = (identifier) => {
      let scope = scopeOf(identifier);
      while (scope) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
        scope = scope.upper;
      }
      return undefined;
    };

    /** The module a `require('x')` / `import('x')` (awaited or not) loads, if it spells one. */
    const loadedModule = (node) => {
      if (node?.type === 'AwaitExpression') return loadedModule(node.argument);
      if (node?.type === 'ImportExpression') return constantString(node.source);
      if (
        node?.type === 'CallExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require'
      ) {
        return constantString(node.arguments[0]);
      }
      return undefined;
    };

    /** `x as T`, `x!`, `x satisfies T`, `<T>x`, `x?.`: the same value, said again. */
    const unwrapped = (node) => {
      let at = node;
      while (at && TYPE_WRAPPERS.has(at.type)) at = at.expression;
      return at;
    };

    // -----------------------------------------------------------------------------------
    // THE value resolver (#536 r4 N1). One function says what an EXPRESSION can evaluate
    // to (`valuesOf`) and one what a destructuring TARGET is handed (`targetValues`); each
    // is written in terms of the other, so a value is followed the same way wherever it
    // is read — a member access, a declaration, an assignment, a default, a parameter, a
    // loop head, a chain of assignments, a literal array or object, a rest slice.
    //
    // A result is a list of items: `{ k }`, a KIND — 'global' (the global object),
    // 'timers' (the `timers` module), 'other' (provably neither: a literal, a function, a
    // platform name such as `process`), 'unknown' (not provable: a parameter, a call, an
    // import, `this`), 'exhausted' (the resolver ran out of depth or work, which is never
    // an answer) — or `{ c, offset }`, a literal array/object whose members can still be
    // selected. Variables are flow-insensitive: a variable holds every value written to it.
    // -----------------------------------------------------------------------------------
    const MAX_DEPTH = 64;
    const MAX_STEPS = 2000;
    const LOGICAL_ASSIGNMENTS = new Set(['||=', '&&=', '??=']);
    const ARRAY_INDEX = /^(?:0|[1-9]\d*)$/;
    const only = (k) => [{ k }];
    const newRun = () => ({ steps: 0, active: new Set() });
    const spent = (run, depth) => depth > MAX_DEPTH || ++run.steps > MAX_STEPS;
    const isSpread = (node) => node?.type === 'SpreadElement';

    /** The kinds of a list of items (a literal container is some other object). */
    const kindsOf = (items) => new Set(items.map((item) => item.k ?? 'other'));

    /** What a definition (not a write) of a variable makes it: imports, functions, classes, … */
    const definitionValues = (def, run, depth) => {
      switch (def.type) {
        case 'Variable':
          return []; // its values are its writes
        case 'FunctionName':
        case 'ClassName':
        case 'TSEnumName':
        case 'TSModuleName':
        case 'Type':
          return only('other');
        case 'ImportBinding': {
          const { node } = def;
          if (node.type === 'TSImportEqualsDeclaration') {
            const reference = node.moduleReference;
            if (reference?.type === 'TSExternalModuleReference') {
              return only(
                TIMERS_MODULE.test(constantString(reference.expression) ?? '')
                  ? 'timers'
                  : 'unknown',
              );
            }
            // `import g = globalThis` / `import t = timersAlias`; a qualified name
            // (`import t = ns.member`) is a member, not a host this rule can name.
            return reference?.type === 'Identifier'
              ? valuesOf(reference, run, depth + 1)
              : only('unknown');
          }
          if (node.type === 'ImportSpecifier') return only('unknown');
          // Default / namespace specifier: the declaration holds the module.
          const source =
            def.parent?.type === 'ImportDeclaration' ? def.parent.source?.value : undefined;
          return only(
            typeof source === 'string' && TIMERS_MODULE.test(source) ? 'timers' : 'unknown',
          );
        }
        default:
          return only('unknown'); // parameter, catch, implicit global, …
      }
    };

    /** What a name holds: its definitions, plus the value of EVERY write to it. */
    const identifierValues = (identifier, run, depth) => {
      const variable = variableOf(identifier);
      if (!variable || variable.defs.length === 0) {
        // A name the module does not declare: a global object by name, else a platform name.
        return only(GLOBAL_OBJECTS.has(identifier.name) ? 'global' : 'other');
      }
      if (run.active.has(variable)) return []; // a cycle adds nothing new
      run.active.add(variable);
      try {
        const items = variable.defs.flatMap((def) => definitionValues(def, run, depth));
        const writes = variable.references.filter((ref) => ref.isWrite());
        // Declared and never written (`declare const host: H`): handed in.
        if (writes.length === 0 && variable.defs.some((def) => def.type === 'Variable')) {
          return only('unknown');
        }
        for (const ref of writes) items.push(...targetValues(ref.identifier, run, depth + 1));
        return items;
      } finally {
        run.active.delete(variable);
      }
    };

    /** The elements of an array literal from position `from`; at `index` (relative) or, undefined, any. */
    const arrayElements = (array, from, index, run, depth) => {
      const { elements } = array;
      const start = elements.slice(0, from).some(isSpread) ? 0 : from; // a spread shifts positions
      const take = (item) =>
        isSpread(item)
          ? iterationOf(valuesOf(item.argument, run, depth + 1), run, depth + 1)
          : valuesOf(item, run, depth + 1);
      const any = () => elements.slice(start).filter(Boolean).flatMap(take);
      if (index === undefined) return any();
      const at = start + index;
      if (elements.slice(0, at + 1).some(isSpread)) return any(); // positions are unknown
      return elements[at] ? take(elements[at]) : [];
    };

    /** What iterating each item (`for…of`, an array pattern, a spread) can hand out. */
    const iterationOf = (items, run, depth) =>
      items.flatMap((item) => {
        if (item.c?.type === 'ArrayExpression') {
          return arrayElements(item.c, item.offset, undefined, run, depth + 1);
        }
        if (item.c) {
          // A literal object is not iterable — unless it brings its own iterator.
          return item.c.properties.some((member) => isSpread(member) || member.computed)
            ? only('unknown')
            : [];
        }
        return item.k === 'global' || item.k === 'timers' ? [] : [item];
      });

    /** The member named `name` (undefined: any member) of each item. */
    const memberOf = (items, name, run, depth) =>
      items.flatMap((item) => {
        if (item.c?.type === 'ObjectExpression') {
          return item.c.properties.flatMap((member) => {
            if (isSpread(member)) {
              return memberOf(valuesOf(member.argument, run, depth + 1), name, run, depth + 1);
            }
            const own = keyName(member.key, member.computed);
            return name === undefined || own === undefined || own === name
              ? valuesOf(member.value, run, depth + 1)
              : [];
          });
        }
        if (item.c) {
          // A literal array: an index names an element; `length`, `map`, … name none.
          if (name === undefined)
            return arrayElements(item.c, item.offset, undefined, run, depth + 1);
          return ARRAY_INDEX.test(name)
            ? arrayElements(item.c, item.offset, Number(name), run, depth + 1)
            : [];
        }
        switch (item.k) {
          case 'global':
            return only(
              name === undefined ? 'unknown' : GLOBAL_OBJECTS.has(name) ? 'global' : 'other',
            );
          case 'timers':
            return only(name === undefined ? 'unknown' : 'other');
          default:
            return [item]; // a member of something provably other / unknown is that again
        }
      });

    /** The element at `index` of what an array pattern takes apart. */
    const elementOf = (items, index, run, depth) =>
      items.flatMap((item) =>
        item.c?.type === 'ArrayExpression'
          ? arrayElements(item.c, item.offset, index, run, depth + 1)
          : iterationOf([item], run, depth + 1),
      );

    /** What `...rest` at position `index` of an array pattern is: the rest of the array. */
    const restOf = (items, index, run, depth) =>
      items.flatMap((item) =>
        item.c?.type === 'ArrayExpression'
          ? [{ c: item.c, offset: item.offset + index }]
          : iterationOf([item], run, depth + 1),
      );

    /** The values an expression can evaluate to. */
    const valuesOf = (node, run, depth = 0) => {
      if (!node) return only('unknown');
      if (spent(run, depth)) return only('exhausted');
      const at = unwrapped(node);
      const next = (child) => valuesOf(child, run, depth + 1);
      switch (at.type) {
        case 'AssignmentExpression':
          // `a = b = globalThis`: an assignment is worth its right side.
          if (at.operator === '=' || LOGICAL_ASSIGNMENTS.has(at.operator)) return next(at.right);
          return only('other'); // arithmetic compound assignment
        case 'SequenceExpression':
          return next(at.expressions.at(-1));
        case 'ConditionalExpression':
          return [...next(at.consequent), ...next(at.alternate)];
        case 'LogicalExpression':
          return [...next(at.left), ...next(at.right)];
        case 'Identifier':
          return identifierValues(at, run, depth);
        case 'ObjectExpression': {
          // A spread copy carries what it copies.
          const copied = at.properties
            .filter(isSpread)
            .flatMap((member) => next(member.argument))
            .filter((item) => item.k !== undefined && item.k !== 'other');
          return [{ c: at, offset: 0 }, ...copied];
        }
        case 'ArrayExpression':
          return [{ c: at, offset: 0 }];
        case 'MemberExpression':
          return memberOf(next(at.object), keyName(at.property, at.computed), run, depth + 1);
        case 'Literal':
        case 'TemplateLiteral':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
        case 'ClassExpression':
        case 'UnaryExpression':
        case 'BinaryExpression':
        case 'UpdateExpression':
          return only('other');
        default:
          // `require('node:timers')`, `await import('node:timers')`; a call, `this`, `await x`, … is not provable.
          return only(TIMERS_MODULE.test(loadedModule(at) ?? '') ? 'timers' : 'unknown');
      }
    };

    /**
     * The values a destructuring target (an identifier, a member, a pattern) is handed, read
     * off the position it stands in: the right side of its declaration or assignment, the
     * iterated element of a loop head, a default, the member/element/rest of its enclosing
     * pattern's own values. A parameter, a catch clause or a rest parameter is handed in.
     */
    const targetValues = (target, run, depth = 0) => {
      const { parent } = target;
      if (!parent) return only('unknown');
      if (spent(run, depth)) return only('exhausted');
      const next = (node) => valuesOf(node, run, depth + 1);
      const up = (node) => targetValues(node, run, depth + 1);
      if (TYPE_WRAPPERS.has(parent.type) && parent.expression === target) return up(parent);
      switch (parent.type) {
        case 'VariableDeclarator': {
          if (parent.id !== target) return only('unknown');
          if (parent.init) return next(parent.init);
          const loop = parent.parent?.parent;
          if (loop?.left !== parent.parent) return []; // `let x;`: undefined
          if (loop.type === 'ForOfStatement') return iterationOf(next(loop.right), run, depth + 1);
          return loop.type === 'ForInStatement' ? only('other') : [];
        }
        case 'AssignmentExpression':
          if (parent.left !== target) return only('unknown');
          return parent.operator === '=' || LOGICAL_ASSIGNMENTS.has(parent.operator)
            ? next(parent.right)
            : only('other');
        case 'UpdateExpression':
          return only('other');
        case 'ForOfStatement':
          return parent.left === target
            ? iterationOf(next(parent.right), run, depth + 1)
            : only('unknown');
        case 'ForInStatement':
          return only('other'); // string keys
        case 'AssignmentPattern':
          // The default, or what was handed in when it is not undefined.
          return parent.left === target ? [...next(parent.right), ...up(parent)] : only('unknown');
        case 'Property':
          if (parent.value !== target || parent.parent.type !== 'ObjectPattern') {
            return only('unknown');
          }
          return memberOf(up(parent.parent), keyName(parent.key, parent.computed), run, depth + 1);
        case 'ArrayPattern':
          return elementOf(up(parent), parent.elements.indexOf(target), run, depth + 1);
        case 'RestElement': {
          const holder = parent.parent;
          if (holder.type === 'ArrayPattern') {
            return restOf(up(holder), holder.elements.indexOf(parent), run, depth + 1);
          }
          return holder.type === 'ObjectPattern' ? up(holder) : only('unknown'); // rest parameter
        }
        default:
          return only('unknown'); // function parameter, catch clause, …
      }
    };

    /** The kinds an expression can be. */
    const kindsOfValue = (node) => kindsOf(valuesOf(node, newRun()));
    /** A global object — or the resolver could not tell (never an answer): fail closed. */
    const isGlobalObject = (node) => {
      const kinds = kindsOfValue(node);
      return kinds.has('global') || kinds.has('exhausted');
    };
    /** The platform timer's host: a global object or the `timers` module (or not told, fail closed). */
    const isTimerHost = (node) => {
      const kinds = kindsOfValue(node);
      return kinds.has('global') || kinds.has('timers') || kinds.has('exhausted');
    };
    /**
     * Whether a destructuring pattern may be taking the global object apart: it is handed
     * the global object, or something the resolver cannot prove is not (fail closed).
     */
    const patternMayBeGlobal = (pattern) => {
      const kinds = kindsOf(targetValues(pattern, newRun()));
      return kinds.has('global') || kinds.has('unknown') || kinds.has('exhausted');
    };

    /**
     * THE read/write classifier for a computed global (#536 r3 N1): how the code around
     * a member access `node` uses the slot it names.
     *
     * - 'read' — the value is taken: a plain use, a call, `.member`, but also every
     *   compound and logical assignment (`+=`, `||=`, `??=`, …) and `++` / `--`, which
     *   read before they write;
     * - 'write' — the slot is only replaced or removed, so there is no value to be a
     *   controller or a timer: a plain `=`, an element/property/rest/default target of a
     *   destructuring assignment (`[g[k]] = xs`, `({ a: g[k] = 1 } = o)`), a `for…in` /
     *   `for…of` target, and `delete`. Type wrappers (`(g[k] as any) = v`, `g[k]! = v`)
     *   are looked through on the way up.
     */
    const useOf = (node) => {
      let at = node;
      for (;;) {
        const { parent } = at;
        if (!parent) return 'read';
        if (TYPE_WRAPPERS.has(parent.type) && parent.expression === at) at = parent;
        else if (
          parent.type === 'Property' &&
          parent.value === at &&
          parent.parent.type === 'ObjectPattern'
        ) {
          at = parent.parent;
        } else if (parent.type === 'ArrayPattern' || parent.type === 'ObjectPattern') at = parent;
        else if (parent.type === 'RestElement' && parent.argument === at) at = parent;
        else if (parent.type === 'AssignmentPattern' && parent.left === at) at = parent;
        else break;
      }
      const { parent } = at;
      if (parent.type === 'AssignmentExpression' && parent.left === at) {
        return parent.operator === '=' ? 'write' : 'read';
      }
      if (
        (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') &&
        parent.left === at
      ) {
        return 'write';
      }
      if (parent.type === 'UnaryExpression' && parent.operator === 'delete') return 'write';
      return 'read';
    };

    /** A reference that no module-level binding answers: the global of that name. */
    const isGlobalReference = (ref) => !ref.resolved || ref.resolved.defs.length === 0;

    const timers = [];
    const aborts = [];
    const controllers = [];
    const byName = [];

    const note = (list, node, text) => {
      list.push({ node, text });
    };

    // Every reference to the global `AbortController` (value or type) is a
    // controller; every reference to the global `setTimeout` is a timer —
    // calls, aliases, arguments, `.call` receivers alike.
    for (const scope of sourceCode.scopeManager.scopes) {
      for (const ref of scope.references) {
        const { name } = ref.identifier;
        if (!isGlobalReference(ref)) continue;
        if (name === ABORT_CONTROLLER) note(controllers, ref.identifier, name);
        else if (TIMER_NAMES.has(name)) note(timers, ref.identifier, name);
      }
    }

    return {
      // `globalThis.AbortController`, `globalThis['AbortController']`, and the same
      // through a direct alias (`const root = globalThis; root.AbortController`): the
      // global reached by member. Any other receiver is somebody's own field. A
      // computed name that is not a constant (`globalThis[key]`) could be the
      // controller or the timer: refused, fail closed (#536 r1 F1).
      MemberExpression(node) {
        const name = keyName(node.property, node.computed);
        if (name === undefined) {
          if (
            node.computed &&
            mayNameAGlobal(node.property) &&
            isGlobalObject(node.object) &&
            useOf(node) === 'read'
          ) {
            note(byName, node, '[…]');
          }
          return;
        }
        if (name === ABORT_CONTROLLER && isGlobalObject(node.object)) {
          note(controllers, node, name);
        }
        if (TIMER_NAMES.has(name) && isTimerHost(node.object)) note(timers, node, name);
        if (name === 'abort') note(aborts, node, `.${name}`);
      },
      // `const { setTimeout: later } = globalThis`, `const { abort: halt } = c`,
      // `const { abort } = c`: the key names it, whatever the binding is called.
      ObjectPattern(node) {
        // From a declaration, only a timer host counts; a parameter or nested pattern
        // takes whatever it is handed, so a `setTimeout` key there is a timer.
        const from = node.parent?.type === 'VariableDeclarator' ? node.parent.init : undefined;
        const timerSource = from === undefined || isTimerHost(from);
        // Every way a pattern is fed (declaration, assignment, chain, default, nested, rest,
        // parameter, for…of head): a computed key reads the global when ANY value it is
        // handed is the global object, or one the resolver cannot prove is not.
        let readsGlobal;
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          const name = keyName(property.key, property.computed);
          // `const { [key]: C } = globalThis`: the same unreadable name. A pattern
          // property always reads its source — there is no write-only form.
          if (name === undefined && property.computed && mayNameAGlobal(property.key)) {
            readsGlobal ??= patternMayBeGlobal(node);
            if (readsGlobal) note(byName, property, '[…]');
          }
          if (TIMER_NAMES.has(name) && timerSource) note(timers, property, name);
          if (name === 'abort') note(aborts, property, name);
          if (name === ABORT_CONTROLLER) note(controllers, property, name);
        }
      },
      // `import { setTimeout as later } from 'node:timers'`, `import { AbortController as AC }`.
      ImportSpecifier(node) {
        const name = node.imported.type === 'Identifier' ? node.imported.name : node.imported.value;
        if (TIMER_NAMES.has(name)) note(timers, node, name);
        if (name === 'abort') note(aborts, node, name);
        if (name === ABORT_CONTROLLER) note(controllers, node, name);
      },
      // `import t = globalThis.setTimeout`, `import a = globalThis.AbortController`: a
      // TypeScript import-equals alias of the member itself, named like a member access.
      TSImportEqualsDeclaration(node) {
        const reference = node.moduleReference;
        if (reference?.type !== 'TSQualifiedName' || reference.left.type !== 'Identifier') return;
        const name = reference.right.name;
        if (TIMER_NAMES.has(name) && isTimerHost(reference.left)) note(timers, node, name);
        if (name === ABORT_CONTROLLER && isGlobalObject(reference.left)) {
          note(controllers, node, name);
        }
        if (name === 'abort') note(aborts, node, name);
      },
      'Program:exit'() {
        if (!mayHoldController) {
          for (const { node } of controllers) context.report({ node, messageId: 'controller' });
          for (const { node, text } of byName) {
            context.report({ node, messageId: 'globalByName', data: { text } });
          }
        }
        if (timers.length > 0 && aborts.length > 0 && !mayPairTimerAndAbort) {
          context.report({
            node: timers[0].node,
            messageId: 'timerAbort',
            data: { timer: timers[0].text, abort: aborts[0].text },
          });
        }
      },
    };
  },
};
