/**
 * Header names and form fields that carry a credential, compared lower-cased:
 * the internal token, a user's or client's authorization, a cookie, an API key,
 * and the OAuth form fields that hold a secret or a grant (Q-155). A function,
 * so that internal/token-source can allow this one list to name the internal
 * token header (eslint.config.mjs).
 */
function credentialNames() {
  return [
    'x-internal-token',
    'authorization',
    'proxy-authorization',
    'cookie',
    'x-api-key',
    'api-key',
    'apikey',
    'client_secret',
    'client_assertion',
    'refresh_token',
    'code_verifier',
    'access_token',
    'subject_token',
    'password',
  ];
}
const CREDENTIAL_NAMES = new Set(credentialNames());
/** A header value that is itself a credential: `Bearer …`, `Basic …`. */
const CREDENTIAL_SCHEME = /^(?:bearer|basic)\s/i;

/**
 * Require a redirect-refusing transport in modules that send credentials: the
 * internal token (#423), and since Q-155 any authorization, cookie, API key or
 * secret/grant form field. Syntactic, per module — not a token-source boundary.
 */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      unsafe:
        'Send credentials only through a redirect-refusing transport: internalFetch from @rasta/nest-common, credentialFetch in apps/web and scripts, or guardedFetch / guardRequestContext from @rasta/testing in E2E code.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    // Examine the whole module: headers are often built separately from the exchange.
    let sendsCredential = /['"`]x-internal-token['"`]/i.test(source.text);
    const credentialName = (value) =>
      typeof value === 'string' && CREDENTIAL_NAMES.has(value.toLowerCase());
    const credentialText = (value) =>
      credentialName(value) || (typeof value === 'string' && CREDENTIAL_SCHEME.test(value));
    const imports = [];
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
          imports.push(node);
        }
      },
      // `{ authorization: … }`; a quoted key is a Literal, below.
      Property(node) {
        if (!node.computed && node.key.type === 'Identifier' && credentialName(node.key.name))
          sendsCredential = true;
      },
      // `'x-api-key'`, `headers.set('Cookie', …)`, `form.append('client_secret', …)`, `'Basic …'`.
      Literal(node) {
        if (credentialText(node.value)) sendsCredential = true;
      },
      TemplateElement(node) {
        if (credentialText(node.value.cooked)) sendsCredential = true;
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
        if (!sendsCredential) return;
        for (const node of imports) context.report({ node, messageId: 'unsafe' });
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
