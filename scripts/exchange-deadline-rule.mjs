/**
 * ESLint rule `internal/exchange-deadline`: an HTTP exchange's deadline belongs
 * to `exchangeWithDeadline` / `upstreamExchange` from `@rasta/nest-common`
 * (#502 r1 F1; PR #507 r1 F1/F2).
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
 * So this rule does not try to follow a caller through its control flow — an
 * earlier version matched `clearTimeout` and body reads by source order and
 * missed `try { return response.text(); } finally { clearTimeout(t); }`
 * (the `finally` runs before the promise settles), computed and aliased
 * readers, and flagged a `clearTimeout` that belonged to something else. It
 * refuses the timer instead:
 *
 * - **Refused:** `setTimeout(callback, …)` (also `globalThis.setTimeout`,
 *   `timers.setTimeout`) whose callback aborts something — an inline function
 *   whose body mentions `.abort`, or a callback reached through a local name:
 *   a `const`/function declaration, a destructured `{ abort }`, a
 *   `controller.abort` or `controller.abort.bind(controller)` reference. The
 *   mention is matched by name, so `controller.abort()`, `controller?.abort()`,
 *   `controller['abort']()` and a destructured `abort()` all count.
 * - **Allowed:** `AbortSignal.timeout(…)` (no timer to clear; the deadline
 *   stays armed through the body), a timer whose callback does not abort
 *   (sleeps, retries, a shutdown bound), and the shared boundary itself, which
 *   the workspace config exempts by path.
 *
 * Out of scope: a callback imported from another module, and a deadline built
 * without an abort at all (a `Promise.race` against a timer) — neither can be
 * seen from one file, and neither is a fetch deadline that this rule can name.
 */

const TIMER_NAMES = new Set(['setTimeout']);

const staticName = (property, computed) => {
  if (!computed) return property.type === 'Identifier' ? property.name : undefined;
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  if (
    property.type === 'TemplateLiteral' &&
    property.expressions.length === 0 &&
    property.quasis.length === 1
  ) {
    return property.quasis[0].value.cooked;
  }
  return undefined;
};

const timerCall = (callee) => {
  if (callee.type === 'Identifier') return TIMER_NAMES.has(callee.name);
  if (callee.type === 'MemberExpression') {
    const name = staticName(callee.property, callee.computed);
    return name !== undefined && TIMER_NAMES.has(name);
  }
  return false;
};

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      manualTimer:
        'A hand-made abort timer leaves the response body, and its release, to this caller. Use exchangeWithDeadline / upstreamExchange from @rasta/nest-common (or AbortSignal.timeout for a request that needs no body handling).',
    },
  },
  create(context) {
    const { sourceCode } = context;
    const keys = sourceCode.visitorKeys;

    /** Whether anything under `node` names an `abort` member or binding. */
    const mentionsAbort = (node, seen) => {
      if (!node || typeof node.type !== 'string' || seen.has(node)) return false;
      seen.add(node);
      if (node.type === 'MemberExpression') {
        if (staticName(node.property, node.computed) === 'abort') return true;
      }
      if (node.type === 'Identifier' && node.name === 'abort') {
        // A bare `abort` (a destructured method) — but not an object literal's
        // own key, which names a field and aborts nothing.
        const parent = node.parent;
        const isKey = parent?.type === 'Property' && parent.key === node && !parent.computed;
        if (!isKey || parent.shorthand) return true;
      }
      for (const key of keys[node.type] ?? []) {
        const child = node[key];
        if (Array.isArray(child)) {
          if (child.some((item) => mentionsAbort(item, seen))) return true;
        } else if (mentionsAbort(child, seen)) {
          return true;
        }
      }
      return false;
    };

    /** Whether the callback handed to the timer aborts, following a local name. */
    const aborts = (callback, scopeNode, seen) => {
      if (!callback) return false;
      if (callback.type === 'Identifier') {
        let scope = sourceCode.getScope(scopeNode);
        let variable;
        while (scope && !variable) {
          variable = scope.set.get(callback.name);
          scope = scope.upper;
        }
        for (const def of variable?.defs ?? []) {
          if (seen.has(def.node)) continue;
          seen.add(def.node);
          // `const { abort } = controller` — the binding is the abort.
          if (def.type === 'Variable' && def.name.parent?.type === 'Property') {
            if (staticName(def.name.parent.key, def.name.parent.computed) === 'abort') return true;
          }
          // A parameter or an import is somebody else's function: not followed.
          const body =
            def.type === 'Variable'
              ? def.node.init
              : def.type === 'FunctionName'
                ? def.node
                : undefined;
          if (mentionsAbort(body, new Set())) return true;
        }
        return false;
      }
      return mentionsAbort(callback, new Set());
    };

    return {
      CallExpression(node) {
        if (!timerCall(node.callee)) return;
        if (aborts(node.arguments[0], node, new Set())) {
          context.report({ node, messageId: 'manualTimer' });
        }
      },
    };
  },
};
