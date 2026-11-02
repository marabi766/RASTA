/**
 * ESLint rule `zod/no-default`: no way to reach a method named `default`.
 *
 * zod 4's `.default(value)` returns `value` as the output without parsing it;
 * zod 3's parsed it through the chain (a pipe, a transform, a trim, an
 * object's own defaults). `.prefault(value)` is zod 3's `.default()` exactly,
 * so every schema says that (GHSA-mrhx-c7xc-m3w5). The first version of this
 * rule matched `x.default(…)` only (PR #444 r1 F2): `x['default'](…)`, a
 * template or concatenated name, a method taken out first (`const d =
 * x.default`, `const { default: d } = x`) and `.call` / `.apply` / `.bind`
 * all reached it. So the rule is about **access**, not calls: any member read,
 * destructured key or reflective lookup whose name is statically `default` is
 * refused, wherever the name came from — an identifier, a string, a template,
 * a `+` of strings, or a `const` holding one of those.
 *
 * Three reads are not a method of a schema and stay allowed:
 *  - a module's default export: the object is `require(…)`, `import(…)`,
 *    `jest.requireActual(…)` / `jest.requireMock(…)` (awaited, cast or not);
 *  - a plain `=` assignment to an object's `default` key (a JSON Schema built
 *    by hand: `schema.default = value`). `||=`, `&&=`, `??=` and the compound
 *    operators read the key first, and are refused like any read;
 *  - the value handed straight to `expect(…)`, which reads a JSON Schema's
 *    `default` keyword in an assertion and never calls it.
 *
 * A name computed from data at run time cannot be decided by any static rule;
 * none exists in this repository (PR #444 r2 body: the grep).
 *
 * **Out of scope by design (PM decision D-075, as D-074):** this rule is a
 * tripwire against *accidental* `.default` use, not a sandbox against
 * deliberate evasion, which code review catches. It does not follow a
 * reflective function reached by a computed or built name (`Reflect['get']`,
 * a template-built `Reflect` callee, `Object['getOwnPropertyDescriptor']`), a
 * reflective function taken out first (`const get = Reflect.get`), or one
 * called through `.call` / `.apply` / `.bind`. Do not grow it to.
 *
 * Used by the root config and by `apps/web/eslint.config.mjs`: one rule, both
 * trees.
 */

const NAME = 'default';
const MESSAGE = "zod 4's .default() skips parsing the value; use .prefault() (zod 3's .default()).";

/** The variable `name` refers to at `scope`, walking outwards. */
function variableOf(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);
    if (variable) return variable;
  }
  return undefined;
}

/**
 * The string `node` always evaluates to, or `undefined` when that is not
 * decidable here. `resolving` holds the constants on the current path only,
 * so a constant used twice (`empty + 'default' + empty`) is read each time,
 * and only a constant that refers back to itself stops the evaluation.
 */
function staticString(node, scope, resolving = new Set()) {
  if (!node) return undefined;
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? node.value : undefined;
    case 'TemplateLiteral': {
      let text = '';
      for (const [at, quasi] of node.quasis.entries()) {
        text += quasi.value.cooked ?? '';
        if (at < node.expressions.length) {
          const part = staticString(node.expressions[at], scope, resolving);
          if (part === undefined) return undefined;
          text += part;
        }
      }
      return text;
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return undefined;
      const left = staticString(node.left, scope, resolving);
      const right = staticString(node.right, scope, resolving);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion':
      return staticString(node.expression, scope, resolving);
    case 'Identifier': {
      const variable = variableOf(scope, node.name);
      const definition = variable?.defs[0];
      if (
        !resolving.has(variable) &&
        definition?.type === 'Variable' &&
        definition.parent?.kind === 'const' &&
        definition.node.id.type === 'Identifier'
      ) {
        resolving.add(variable);
        try {
          return staticString(definition.node.init, scope, resolving);
        } finally {
          resolving.delete(variable);
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The name a member access or a pattern key reads, when it is decidable. */
function keyName(key, computed, scope) {
  if (!computed && key.type === 'Identifier') return key.name;
  return staticString(key, scope);
}

const unwrap = (node) => {
  let current = node;
  while (
    current &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'AwaitExpression',
      'ChainExpression',
    ].includes(current.type)
  ) {
    current = current.type === 'AwaitExpression' ? current.argument : current.expression;
  }
  return current;
};

/** Whether `node` loads a module, whose `default` is its default export. */
function isModuleLoad(node) {
  const value = unwrap(node);
  if (!value) return false;
  if (value.type === 'ImportExpression') return true;
  if (value.type !== 'CallExpression') return false;
  const callee = value.callee;
  if (callee.type === 'Identifier') return callee.name === 'require';
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'jest' &&
    ['requireActual', 'requireMock'].includes(callee.property.name)
  );
}

/** A plain write (`x.default = value`); `||=`, `??=`, `&&=`, `+=` … read it first. */
function isAssignmentTarget(member) {
  const parent = member.parent;
  return (
    parent?.type === 'AssignmentExpression' && parent.operator === '=' && parent.left === member
  );
}

function isAssertedValue(member) {
  let node = member;
  while (node.parent?.type === 'ChainExpression') node = node.parent;
  const parent = node.parent;
  return (
    parent?.type === 'CallExpression' &&
    parent.arguments[0] === node &&
    parent.callee.type === 'Identifier' &&
    parent.callee.name === 'expect'
  );
}

/** The value a destructuring pattern takes apart, when it is the declaration's own. */
function destructuredFrom(pattern) {
  const parent = pattern.parent;
  if (parent?.type === 'VariableDeclarator' && parent.id === pattern) return parent.init;
  if (parent?.type === 'AssignmentExpression' && parent.left === pattern) return parent.right;
  return undefined;
}

const REFLECTIVE = new Set(['Reflect.get', 'Object.getOwnPropertyDescriptor']);

export default {
  meta: {
    type: 'problem',
    docs: { description: "Forbid reaching zod's .default() by any route; use .prefault()." },
    schema: [],
    messages: { noDefault: MESSAGE },
  },
  create(context) {
    const scopeOf = (node) => context.sourceCode.getScope(node);
    const report = (node) => context.report({ node, messageId: 'noDefault' });
    return {
      MemberExpression(node) {
        if (keyName(node.property, node.computed, scopeOf(node)) !== NAME) return;
        if (isModuleLoad(node.object) || isAssignmentTarget(node) || isAssertedValue(node)) return;
        report(node);
      },
      Property(node) {
        if (node.parent?.type !== 'ObjectPattern') return;
        if (keyName(node.key, node.computed, scopeOf(node)) !== NAME) return;
        if (isModuleLoad(destructuredFrom(node.parent))) return;
        report(node);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.object.type !== 'Identifier') return;
        if (!REFLECTIVE.has(`${callee.object.name}.${callee.property.name}`)) return;
        if (staticString(node.arguments[1], scopeOf(node)) === NAME) report(node);
      },
    };
  },
};
