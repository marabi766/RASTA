/**
 * ESLint rule `internal/exchange-deadline`: a response body is read before the
 * deadline timer is cleared, never after (PR #502 r1 F1).
 *
 * `fetch` settles when the headers arrive. A caller that clears its abort
 * timer at that point and then awaits `response.text()` has no deadline on the
 * body: a server that stalls or trickles it holds the caller for as long as
 * the socket lives. Two internal clients did exactly that. The deadline has to
 * cover the exchange up to the last byte read — `withExchangeDeadline` from
 * `@rasta/nest-common`, or a `try { send; read } finally { clearTimeout }`.
 *
 * What is refused: inside one function, a body read — `.text()`, `.json()`,
 * `.arrayBuffer()`, `.blob()`, `.formData()`, `.bytes()` or `.getReader()`
 * with no arguments, or a call to `readCapped(…)` — that comes **after** a
 * `clearTimeout(…)` call in the source. The sound shape puts the clear in a
 * `finally` after every read, so the order tells the two apart without
 * following control flow.
 *
 * Out of scope, as for the transport rule: a timer cleared through a helper or
 * a nested function, and a read of a body whose deadline lives elsewhere. An
 * `AbortSignal.timeout(…)` has no timer to clear and is not a case at all.
 */

const BODY_METHODS = new Set([
  'text',
  'json',
  'arrayBuffer',
  'blob',
  'formData',
  'bytes',
  'getReader',
]);
const BODY_HELPERS = new Set(['readCapped']);

const nameOf = (callee) =>
  callee.type === 'Identifier'
    ? callee.name
    : callee.type === 'MemberExpression' && !callee.computed
      ? callee.property.name
      : undefined;

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      afterClear:
        'The response body is read after the deadline timer was cleared, so a stalled body has no deadline. Read it before clearTimeout (finally), or use withExchangeDeadline from @rasta/nest-common.',
    },
  },
  create(context) {
    const frames = [];
    const enter = () => frames.push({ clears: [], reads: [] });
    const leave = () => {
      const { clears, reads } = frames.pop();
      for (const read of reads) {
        if (clears.some((clear) => clear.range[1] <= read.range[0])) {
          context.report({ node: read, messageId: 'afterClear' });
        }
      }
    };
    return {
      Program: enter,
      'Program:exit': leave,
      FunctionDeclaration: enter,
      'FunctionDeclaration:exit': leave,
      FunctionExpression: enter,
      'FunctionExpression:exit': leave,
      ArrowFunctionExpression: enter,
      'ArrowFunctionExpression:exit': leave,
      CallExpression(node) {
        const frame = frames.at(-1);
        const name = nameOf(node.callee);
        if (!frame || name === undefined) return;
        if (name === 'clearTimeout') {
          frame.clears.push(node);
        } else if (
          BODY_HELPERS.has(name) ||
          (node.callee.type === 'MemberExpression' &&
            BODY_METHODS.has(name) &&
            node.arguments.length === 0)
        ) {
          frame.reads.push(node);
        }
      },
    };
  },
};
