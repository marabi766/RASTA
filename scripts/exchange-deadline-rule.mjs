import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

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
 * questions about the **module**, which indirection cannot change:
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
 * - **Allowed:** `AbortSignal.timeout(…)` (no timer to clear; the deadline
 *   stays armed through the body), timers that no `abort` shares a module
 *   with (sleeps, outbox and consumer loops, shutdown bounds), a controller
 *   whose owner has no timer (shutdown fan-out, client-close cancellation),
 *   and the shared boundary itself, which the workspace config exempts by path.
 *
 * Out of scope: an abort whose method name is not a constant (`c[name]()` with
 * a name read from data) held in a module that was handed the controller, and
 * a timer and a controller that both come from other modules into one that
 * owns neither — the module that owns either is the one refused.
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

/** `timers` and `timers/promises`, with or without the `node:` prefix. */
const TIMERS_MODULE = /^(?:node:)?timers(?:\/promises)?$/;

const FOLD_DEPTH = 8;

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      controller:
        'An AbortController outside the shared boundary builds a hand-made deadline that leaves the response body, and its release, to this caller. Use exchangeWithDeadline / upstreamExchange from @rasta/nest-common (or AbortSignal.timeout for a request that needs no body handling). A file with a reason to own one joins ABORT_OWNERS in scripts/exchange-deadline-rule.mjs.',
      timerAbort:
        'This module references a timer ({{timer}}) and mentions abort ({{abort}}): however they are connected, that is a hand-made abort timer, which leaves the response body, and its release, to this caller. Use exchangeWithDeadline / upstreamExchange from @rasta/nest-common (or AbortSignal.timeout for a request that needs no body handling). A deadline over something that is not an HTTP exchange joins TIMER_ABORT_MODULES in scripts/exchange-deadline-rule.mjs with a reason.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    const file = relative(ROOT, context.physicalFilename).split(sep).join('/');
    const mayHoldController = Object.hasOwn(ABORT_OWNERS, file);
    const mayPairTimerAndAbort = Object.hasOwn(TIMER_ABORT_MODULES, file);

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
        case 'Identifier': {
          // A `const` (or a `let` never reassigned) read through its binding.
          let scope = scopeOf(node);
          let variable;
          while (scope && !variable) {
            variable = scope.set.get(node.name);
            scope = scope.upper;
          }
          if (!variable || variable.defs.length !== 1) return undefined;
          const [def] = variable.defs;
          if (def.type !== 'Variable' || def.node.id !== def.name) return undefined;
          if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return undefined;
          return constantString(def.node.init, depth + 1);
        }
        default:
          return undefined;
      }
    };

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

    /**
     * Whether `node` is something whose `setTimeout` member is the platform timer: a
     * global object (or a `const` alias of one), or the `timers` module however it
     * was loaded. A test runner's `test.setTimeout(ms)` or `jest.setTimeout(ms)` is
     * not a timer at all, so it is not one here.
     */
    const isTimerHost = (node, depth = 0) => {
      if (!node || depth > FOLD_DEPTH) return false;
      if (['TSAsExpression', 'TSNonNullExpression', 'ChainExpression'].includes(node.type)) {
        return isTimerHost(node.expression, depth + 1);
      }
      if (node.type !== 'Identifier') return TIMERS_MODULE.test(loadedModule(node) ?? '');
      const variable = variableOf(node);
      if (!variable || variable.defs.length === 0) return GLOBAL_OBJECTS.has(node.name);
      return variable.defs.some((def) => {
        if (def.type === 'ImportBinding') {
          return def.node.type !== 'ImportSpecifier' && TIMERS_MODULE.test(def.parent.source.value);
        }
        if (def.type !== 'Variable' || def.node.id !== def.name) return false;
        return isTimerHost(def.node.init, depth + 1);
      });
    };

    /** A reference that no module-level binding answers: the global of that name. */
    const isGlobalReference = (ref) => !ref.resolved || ref.resolved.defs.length === 0;

    const timers = [];
    const aborts = [];
    const controllers = [];

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
      // `globalThis.AbortController`, `globalThis['AbortController']`: the
      // global reached by member. Any other receiver is somebody's own field.
      MemberExpression(node) {
        const name = keyName(node.property, node.computed);
        if (name === undefined) return;
        if (name === ABORT_CONTROLLER) {
          const { object } = node;
          if (object.type === 'Identifier' && GLOBAL_OBJECTS.has(object.name)) {
            note(controllers, node, name);
          }
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
        for (const property of node.properties) {
          if (property.type !== 'Property') continue;
          const name = keyName(property.key, property.computed);
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
      'Program:exit'() {
        if (!mayHoldController) {
          for (const { node } of controllers) context.report({ node, messageId: 'controller' });
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
