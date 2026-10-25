/** Require the redirect-rejecting transport in modules that send internal credentials. */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      unsafe: 'Send internal credentials only through internalFetch from @rasta/nest-common.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    // Examine the whole module: headers are often built separately from the exchange.
    const sendsToken = /['"`]x-internal-token['"`]/i.test(source.text);
    if (!sendsToken) return {};
    const rawNames = new Set(['fetch', 'fetchImpl', 'request', 'axios']);
    const bindings = [];
    const calls = [];
    const nameOf = (node) =>
      node?.type === 'Identifier'
        ? node.name
        : node?.type === 'MemberExpression'
          ? node.computed
            ? node.property.value
            : node.property.name
          : undefined;
    const referencesTransport = (node) => {
      if (rawNames.has(nameOf(node))) return true;
      if (node?.type === 'LogicalExpression')
        return referencesTransport(node.left) || referencesTransport(node.right);
      if (node?.type === 'ConditionalExpression')
        return referencesTransport(node.consequent) || referencesTransport(node.alternate);
      if (['TSAsExpression', 'TSTypeAssertion', 'TSNonNullExpression'].includes(node?.type))
        return referencesTransport(node.expression);
      return false;
    };
    return {
      ImportDeclaration(node) {
        if (
          /^(?:node:)?(?:http|https)$|^(?:undici|axios|node-fetch)(?:\/|$)/.test(node.source.value)
        ) {
          context.report({ node, messageId: 'unsafe' });
        }
      },
      VariableDeclarator(node) {
        bindings.push([node.id, node.init]);
      },
      AssignmentExpression(node) {
        bindings.push([node.left, node.right]);
      },
      CallExpression(node) {
        calls.push(node);
      },
      'Program:exit'() {
        // Resolve aliases throughout the module, including constructors declared after methods.
        let changed;
        do {
          changed = false;
          for (const [binding, value] of bindings) {
            const name = nameOf(binding);
            if (name && !rawNames.has(name) && referencesTransport(value)) {
              rawNames.add(name);
              changed = true;
            }
          }
        } while (changed);
        for (const node of calls) {
          if (referencesTransport(node.callee)) context.report({ node, messageId: 'unsafe' });
        }
      },
    };
  },
};
