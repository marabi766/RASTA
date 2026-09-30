/**
 * The seeded organizations and people, in a module of their own so a test can
 * read them: `seed.ts` runs `main()` on import and cannot be required without
 * writing to a database.
 *
 * The Keycloak development realm
 * (`infrastructure/docker/keycloak/rasta-realm.json`) names the same people.
 * `src/seed-realm-agreement.spec.ts` fails when the two disagree, because a
 * token for a user identity-service has never heard of still carries the right
 * organization claim and so passes for the wrong reason everywhere but
 * `/v1/users/me`.
 */

export const ORG = {
  province: 'ORG-PROVINCE-YAZD',
  union: 'ORG-UNION-YAZD',
  dehyari1: 'ORG-DEH-0001',
  dehyari2: 'ORG-DEH-0002',
} as const;

export const USERS = [
  {
    id: 'USR-SEED-SYSTEM-ADMIN',
    username: 'system.admin',
    email: 'system.admin@rasta.local',
    firstName: 'System',
    lastName: 'Administrator',
    organizationId: ORG.union,
    roles: ['SYSTEM_ADMIN'],
  },
  {
    id: 'USR-SEED-UNION-ADMIN',
    username: 'union.admin',
    email: 'union.admin@rasta.local',
    firstName: 'مدیر',
    lastName: 'اتحادیه',
    organizationId: ORG.union,
    roles: ['UNION_ADMIN'],
  },
  {
    id: 'USR-SEED-DEHYARI-ADMIN',
    username: 'dehyari.admin',
    email: 'dehyari.admin@rasta.local',
    firstName: 'دهیار',
    lastName: 'نمونه',
    organizationId: ORG.dehyari1,
    roles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER', 'PROCUREMENT_USER'],
  },
  {
    id: 'USR-SEED-AUDITOR',
    username: 'province.auditor',
    email: 'auditor@rasta.local',
    firstName: 'ناظر',
    lastName: 'استانداری',
    organizationId: ORG.province,
    roles: ['AUDITOR'],
  },
  {
    // Exists so tenant isolation is demonstrable against live data: this user
    // is in a different dehyari and must not see ORG-DEH-0001's records.
    id: 'USR-SEED-DEHYARI2-ADMIN',
    username: 'dehyari2.admin',
    email: 'dehyari2.admin@rasta.local',
    firstName: 'دهیار',
    lastName: 'دوم',
    organizationId: ORG.dehyari2,
    roles: ['ORGANIZATION_ADMIN', 'FLEET_MANAGER'],
  },
  {
    // The second tenant's administrator as the Keycloak realm fixture defines
    // them (`dehyari.admin.b`, rasta_user_id USR-SEED-DEHYARI-ADMIN-B): without
    // this row a token for that person named a user identity-service had never
    // heard of, and `/v1/users/me` answered 404. The browser suite signs in as
    // them and requires `/users/me` to answer before it trusts the session.
    id: 'USR-SEED-DEHYARI-ADMIN-B',
    username: 'dehyari.admin.b',
    email: 'dehyari.admin.b@rasta.local',
    firstName: 'دهیار',
    lastName: 'نمونه دو',
    organizationId: ORG.dehyari2,
    roles: ['ORGANIZATION_ADMIN'],
  },
  {
    id: 'USR-SEED-OPERATOR',
    username: 'operator.one',
    email: 'operator.one@rasta.local',
    firstName: 'اپراتور',
    lastName: 'یکم',
    organizationId: ORG.dehyari1,
    roles: ['OPERATOR', 'DRIVER'],
  },
] as const;
