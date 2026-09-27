import { runtimeRoleProblems, type RuntimeRoleFacts } from './prisma.service';

/**
 * The startup refusal (Codex review of #120, finding 2 and round 2 finding 2),
 * as a pure function of what the catalogue says about the connected role.
 */

const RUNTIME: RuntimeRoleFacts = {
  role: 'rasta_supplier',
  database: 'rasta_supplier',
  schema: 'public',
  superuser: false,
  createDb: false,
  createRole: false,
  databaseOwner: false,
  schemaOwner: false,
};

describe('who may run supplier-service', () => {
  it('accepts a role that owns nothing and can create nothing', () => {
    expect(runtimeRoleProblems(RUNTIME)).toEqual([]);
  });

  it.each([
    ['superuser', 'is a superuser'],
    ['createDb', 'holds CREATEDB'],
    ['createRole', 'holds CREATEROLE'],
    ['databaseOwner', 'can act as the owner of database rasta_supplier'],
    ['schemaOwner', 'can act as an owner in schema public'],
  ] as const)('refuses a role with %s', (fact, reason) => {
    expect(runtimeRoleProblems({ ...RUNTIME, [fact]: true })).toEqual([reason]);
  });

  it('names every reason at once', () => {
    expect(
      runtimeRoleProblems({ ...RUNTIME, createDb: true, databaseOwner: true, schemaOwner: true }),
    ).toHaveLength(3);
  });
});
