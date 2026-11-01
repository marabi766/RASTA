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
 *   r3 N1/N2). Two shared classifiers decide it, for member access and patterns alike:
 *   - **What is a read** (`useOf`, `sourcesOf`). Every use that takes the value:
 *     a plain use, a call, `.member`, every compound and logical assignment
 *     (`+=`, `||=`, `??=`, …), `++`/`--`, a destructuring declaration, a
 *     destructuring ASSIGNMENT, a parameter pattern with a default
 *     (`function f({ [k]: C } = globalThis)`), a default inside a pattern, a nested
 *     or array pattern over a literal source (`({ a: { [k]: C } } = { a: globalThis })`,
 *     `[{ [k]: C }] = [globalThis]`), a `for…of` head over a literal array. A pure
 *     WRITE reads nothing and is not refused: `g[k] = v` (also type-wrapped), a
 *     destructuring-assignment target (`[g[k]] = xs`, `({ a: g[k] = 1 } = o)`, rest
 *     targets), a `for…in`/`for…of` target, `delete g[k]`.
 *   - **What is not a name** (`keyKind`). Only a key PROVABLY numeric, bigint or
 *     symbol: numeric/bigint literals, unary `+ - ~` and arithmetic/bitwise of provable
 *     numerics, `NaN`/`Infinity`, `Number(…)`/`BigInt(…)` — these identifiers only
 *     when they resolve to the unshadowed global — `Symbol(…)`, `Symbol.for(…)`,
 *     `Symbol.<x>`, a constant alias of any of these, a conditional whose branches
 *     both are. Everything else (`x - 1`, `-x`, `Math.floor(x)`, `String(1)`, a
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
 * - **Global object reached other than by a name or a direct alias of one:** a
 *   nested member (`globalThis.global.AbortController`), a destructured one
 *   (`const { global: g } = globalThis`), an alias made by assignment
 *   (`let g; g = globalThis`), `Reflect.get(globalThis, 'setTimeout')`, a host
 *   handed in as a parameter (`h.setTimeout(…)`), a qualified type annotation
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
 * - **A computed read whose global object or source is not named or directly
 *   aliased** (rule C reaches only what it can resolve): a parameter that merely
 *   defaults to the global (`function f(g = globalThis) { g[k] }`); the global inside
 *   a logical or conditional expression (`(globalThis ?? o)[k]`, `(c ? globalThis : o)[k]`);
 *   a spread copy (`{ ...globalThis }`); a pattern fed by a handed-in value
 *   (a parameter with no default, a catch clause, a call, a `for…of` over a variable
 *   or a non-literal iterable); a member of the global (`globalThis.global`).
 *
 * The forms that are plausibly accidental are closed: a direct alias of the global
 * object (`const root = globalThis; new root.AbortController()`) and a computed
 * global name that is not a provable number or symbol, in every context that reads
 * it (rule C). Every closed form has a test; every residual form above is pinned by a
 * test too, so that changing either is visible.
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
        case 'MemberExpression':
          return isUnshadowedGlobal(at.object, 'Symbol') ? 'symbol' : undefined;
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

    /**
     * What a definition binds to, as a host: 'global' (the global object, or a
     * `const` alias of it), 'timers' (the `timers` module, however loaded), or
     * undefined. Every definition type the scope manager makes gets an answer
     * here, and an unknown one is "not a host" (#536 r1 F3): the TypeScript
     * import-equals forms (`import t = require('node:timers')`,
     * `import g = globalThis`) have no `ImportDeclaration` to read a source from.
     */
    const definitionKind = (def, depth) => {
      if (def.type === 'ImportBinding') {
        const { node } = def;
        if (node.type === 'TSImportEqualsDeclaration') {
          const reference = node.moduleReference;
          if (reference?.type === 'TSExternalModuleReference') {
            return TIMERS_MODULE.test(constantString(reference.expression) ?? '')
              ? 'timers'
              : undefined;
          }
          // `import g = globalThis` / `import t = timersAlias`; a qualified name
          // (`import t = ns.member`) is a member, not a host this rule can name.
          return reference?.type === 'Identifier' ? hostKind(reference, depth + 1) : undefined;
        }
        if (node.type === 'ImportSpecifier') return undefined;
        // Default / namespace specifier: the declaration holds the module.
        const source =
          def.parent?.type === 'ImportDeclaration' ? def.parent.source?.value : undefined;
        return typeof source === 'string' && TIMERS_MODULE.test(source) ? 'timers' : undefined;
      }
      if (def.type === 'Variable' && def.node.id === def.name) {
        return hostKind(def.node.init, depth + 1);
      }
      return undefined; // parameter, function, class, catch, enum, namespace, type, ...
    };

    /**
     * Whether `node` is something whose `setTimeout` member is the platform timer —
     * 'global' for a global object (or a `const` alias of one), 'timers' for the
     * `timers` module however it was loaded — and undefined for anything else. A test
     * runner's `test.setTimeout(ms)` or `jest.setTimeout(ms)` is not a timer at all,
     * so it is not one here. A name the module itself declares (a local `window`
     * array, a parameter called `self`) is that declaration, not the global.
     */
    const hostKind = (node, depth = 0) => {
      const at = unwrapped(node);
      if (!at || depth > FOLD_DEPTH) return undefined;
      if (at.type !== 'Identifier') {
        return TIMERS_MODULE.test(loadedModule(at) ?? '') ? 'timers' : undefined;
      }
      const variable = variableOf(at);
      if (!variable || variable.defs.length === 0) {
        return GLOBAL_OBJECTS.has(at.name) ? 'global' : undefined;
      }
      for (const def of variable.defs) {
        const kind = definitionKind(def, depth);
        if (kind) return kind;
      }
      return undefined;
    };
    const isTimerHost = (node) => hostKind(node) !== undefined;
    const isGlobalObject = (node) => hostKind(node) === 'global';

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

    /** The object/array literal an expression is — directly or through a constant alias. */
    const literalOf = (node, depth = 0) => {
      const at = unwrapped(node);
      if (!at || depth > FOLD_DEPTH) return undefined;
      if (at.type === 'ObjectExpression' || at.type === 'ArrayExpression') return at;
      return at.type === 'Identifier' ? literalOf(constantBinding(at), depth + 1) : undefined;
    };

    /** The values a literal array can hand out (a spread makes positions unknown, so it hands out any). */
    const elementsOf = (source, index) => {
      const array = literalOf(source);
      if (array?.type !== 'ArrayExpression') return [];
      const items = array.elements.filter((item) => item && item.type !== 'SpreadElement');
      if (index === undefined) return items; // a for…of head takes every element
      const positional = array.elements
        .slice(0, index + 1)
        .every((item) => item?.type !== 'SpreadElement');
      if (!positional) return items;
      return array.elements[index] ? [array.elements[index]] : [];
    };

    /**
     * The expressions that can supply the value a destructuring `target` takes apart —
     * the one resolver for patterns, wherever they stand (#536 r3 N1): a declaration's
     * initializer, an assignment's right side, a default (`{ [k]: C } = globalThis` as a
     * parameter, `[{ [k]: C } = globalThis] = []`, `{ a: { [k]: C } = globalThis } = {}`),
     * the matching member/element of a literal source for a nested pattern, and the
     * elements of a literal array for a `for…of` head. A source it cannot name (a
     * parameter with no default, a call, a variable holding an iterable) is not listed:
     * accepted residual, as for any value handed in.
     */
    const sourcesOf = (target, depth = 0) => {
      const { parent } = target;
      if (!parent || depth > FOLD_DEPTH) return [];
      switch (parent.type) {
        case 'VariableDeclarator': {
          if (parent.id !== target) return [];
          if (parent.init) return [parent.init];
          const loop = parent.parent?.parent;
          return loop?.type === 'ForOfStatement' && loop.left === parent.parent
            ? elementsOf(loop.right)
            : [];
        }
        case 'AssignmentExpression':
          return parent.left === target ? [parent.right] : [];
        case 'ForOfStatement':
          return parent.left === target ? elementsOf(parent.right) : [];
        case 'AssignmentPattern':
          return parent.left === target ? [parent.right, ...sourcesOf(parent, depth + 1)] : [];
        case 'Property': {
          if (parent.value !== target || parent.parent.type !== 'ObjectPattern') return [];
          const key = keyName(parent.key, parent.computed);
          return sourcesOf(parent.parent, depth + 1).flatMap((source) => {
            const object = literalOf(source);
            if (object?.type !== 'ObjectExpression') return [];
            return object.properties
              .filter((member) => member.type === 'Property')
              .filter((member) => {
                const own = keyName(member.key, member.computed);
                return key === undefined || own === undefined || own === key;
              })
              .map((member) => member.value);
          });
        }
        case 'ArrayPattern':
          return sourcesOf(parent, depth + 1).flatMap((source) =>
            elementsOf(source, parent.elements.indexOf(target)),
          );
        default:
          return [];
      }
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
        // Every way a pattern is fed (declaration, assignment, default, nested, for…of
        // head): a computed key reads the global when ANY source is the global object.
        let readsGlobal;
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          const name = keyName(property.key, property.computed);
          // `const { [key]: C } = globalThis`: the same unreadable name. A pattern
          // property always reads its source — there is no write-only form.
          if (name === undefined && property.computed && mayNameAGlobal(property.key)) {
            readsGlobal ??= sourcesOf(node).some(isGlobalObject);
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
