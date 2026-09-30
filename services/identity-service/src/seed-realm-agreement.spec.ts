import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { USERS } from '../prisma/seed-users';

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
