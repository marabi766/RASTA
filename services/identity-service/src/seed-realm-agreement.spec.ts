import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * The development realm and the identity seed name the same people.
 *
 * They are two files that were written separately and drifted once: the second
 * tenant's administrator (`dehyari.admin.b`) existed in Keycloak with the id
 * `USR-SEED-DEHYARI-ADMIN-B` and nowhere in identity-service, so a token for
 * them was valid, carried the right organization, and `/v1/users/me` answered
 * 404. Every check that read only the token passed for that person anyway.
 *
 * Only the fields a token and `/v1/users/me` both carry are compared: who the
 * person is, which organization they act for, and which roles they hold there.
 */

/**
 * The seed is read as source, not imported: `prisma/seed.ts` runs `main()` the
 * moment it is loaded, and moving the data into a module of its own does not
 * survive the way the seed is actually run (`node --import
 * @swc-node/register/esm-register`, where a TypeScript module imported from the
 * entry file arrives as CommonJS with no readable named exports — the seed
 * failed in CI that way once). Reading the literals out of the source needs no
 * module system, and refuses anything it cannot read literally.
 */
interface SeedUser {
  readonly id: string;
  readonly username: string;
  readonly organizationId: string;
  readonly roles: readonly string[];
}

function seedUsers(): SeedUser[] {
  const text = readFileSync(join(__dirname, '..', 'prisma', 'seed.ts'), 'utf8');
  const source = ts.createSourceFile('seed.ts', text, ts.ScriptTarget.Latest, true);

  const topLevel = (name: string): ts.Expression => {
    const found: ts.Expression[] = [];
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          if (!declaration.initializer) throw new Error(`\`${name}\` has no initializer`);
          found.push(declaration.initializer);
        }
      }
    }
    if (found.length !== 1)
      throw new Error(`expected one \`const ${name}\`, found ${found.length}`);
    return found[0];
  };

  const organizations: Record<string, string> = {};
  const evaluate = (node: ts.Node): unknown => {
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))
      return evaluate(node.expression);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(evaluate);
    if (ts.isObjectLiteralExpression(node)) {
      const out: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property))
          throw new Error('a property the reader cannot take at its word');
        out[property.name.getText()] = evaluate(property.initializer);
      }
      return out;
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText() === 'ORG' &&
      organizations[node.name.text] !== undefined
    ) {
      return organizations[node.name.text];
    }
    throw new Error(`cannot read ${node.getText()} literally`);
  };

  Object.assign(organizations, evaluate(topLevel('ORG')) as Record<string, string>);
  return (evaluate(topLevel('USERS')) as SeedUser[]).map((user) => ({
    id: user.id,
    username: user.username,
    organizationId: user.organizationId,
    roles: user.roles,
  }));
}

const USERS = seedUsers();

interface RealmUser {
  username: string;
  attributes?: Record<string, string[]>;
}

const realm = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', 'infrastructure', 'docker', 'keycloak', 'rasta-realm.json'),
    'utf8',
  ),
) as { users: RealmUser[] };

/** The realm's people, leaving out the client's service account, which is no person. */
const people = realm.users.filter((user) => user.attributes?.rasta_user_id !== undefined);

describe('the development realm and the identity seed', () => {
  it('has people to compare, or this spec proves nothing', () => {
    expect(people.length).toBeGreaterThanOrEqual(6);
    expect(USERS.length).toBeGreaterThanOrEqual(7);
  });

  it.each(people.map((user) => [user.username, user] as const))(
    'agree about %s',
    (_name, person) => {
      const attributes = person.attributes ?? {};
      const seeded = USERS.find((user) => user.id === attributes.rasta_user_id?.[0]);

      expect(seeded).toBeDefined();
      expect(seeded?.username).toBe(person.username);
      expect(seeded?.organizationId).toBe(attributes.active_organization_id?.[0]);

      const realmRoles = (attributes.organization_roles ?? [])
        .filter((entry) => entry.startsWith(`${seeded?.organizationId}:`))
        .map((entry) => entry.slice(entry.indexOf(':') + 1))
        .sort();
      expect([...(seeded?.roles ?? [])].sort()).toEqual(realmRoles);
    },
  );

  it('does not seed a person the realm cannot sign in', () => {
    const inRealm = new Set(people.map((person) => person.attributes?.rasta_user_id?.[0]));
    // `dehyari2.admin` is the other tenant's *fleet and marketplace* user (their
    // seeds point at it); it is not a login. Named here so a new one-sided row
    // is a decision, not an accident.
    const notLogins = new Set(['USR-SEED-DEHYARI2-ADMIN']);
    for (const user of USERS) {
      expect(inRealm.has(user.id) || notLogins.has(user.id)).toBe(true);
    }
  });
});
