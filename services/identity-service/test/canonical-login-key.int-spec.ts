import { foldAsciiCase, runUnscoped } from '@rasta/nest-common';
import { ulid } from 'ulid';
import {
  createUserSchema,
  listRegistrationRequestsQuerySchema,
  listUsersQuerySchema,
  submitRegistrationSchema,
} from '../src/identity/dto';
import { IdentityRepository } from '../src/identity/identity.repository';
import { IdentityService } from '../src/identity/identity.service';
import type { KeycloakAdminClient } from '../src/keycloak/keycloak.client';
import type { KeycloakProjector } from '../src/keycloak/keycloak.projector';
import type { PrismaService } from '../src/prisma/prisma.service';
import { addMembershipRow } from './identity-fixtures';
import { asActor, newPrisma, tenants } from './helpers';

/**
 * One person, one login name, however it is typed (FU-084): the application and PostgreSQL fold
 * case the same way over every code point, the database holds nothing but printable ASCII, and a
 * name or address that differs only in case is the one already taken.
 */
describe('the canonical login key (FU-084)', () => {
  let prisma: PrismaService;
  const LAST_CODE_POINT = 0x10ffff;
  const PRINTABLE_ASCII = /^[!-~]+$/;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma?.stop();
  });

  it('the application and PostgreSQL agree on the key and on the form, over every code point', async () => {
    const [row] = await prisma.client.$queryRawUnsafe<{ keys: string[]; printable: number[] }[]>(
      `SELECT array_agg(user_login_key('x' || chr(cp)) ORDER BY cp) AS keys,
              array_agg(cp ORDER BY cp) FILTER (WHERE chr(cp) ~ U&'^[\\0021-\\007E]+$') AS printable
         FROM generate_series(1, ${LAST_CODE_POINT}) cp
        WHERE cp NOT BETWEEN 55296 AND 57343`,
    );
    const keys: string[] = [];
    const printable: number[] = [];
    for (let cp = 1; cp <= LAST_CODE_POINT; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const character = String.fromCodePoint(cp);
      keys.push(foldAsciiCase(`x${character}`));
      if (PRINTABLE_ASCII.test(character)) printable.push(cp);
    }
    expect(row!.keys).toEqual(keys);
    expect(row!.printable).toEqual(printable);
    expect(printable).toHaveLength(94);
  });

  it('every username and email the request schemas let through is in the stored form, and is its own key', () => {
    const user = createUserSchema.parse({
      username: ' Ali.Reza۱ ',
      email: ' Ali@Example.TEST ',
      firstName: 'علی',
      lastName: 'رضایی',
      organizationId: 'ORG_01HZY6M1W6V5G4QYV8A6BZ0F6D',
      roles: ['DRIVER'],
    });
    expect(user.username).toBe('ali.reza1');
    expect(user.email).toBe('ali@example.test');
    for (const value of [user.username, user.email]) {
      expect(PRINTABLE_ASCII.test(value)).toBe(true);
      expect(foldAsciiCase(value)).toBe(value);
    }
    for (const lookalike of ['ali\u200dreza', 'ali\u034freza', 'ali\u200ereza', 'аli']) {
      expect(submitRegistrationSchema.shape.username.safeParse(lookalike).success).toBe(false);
    }
  });

  it('the database refuses a second account by case alone, and anything but printable ASCII', async () => {
    const handle = `canon-${ulid().toLowerCase()}`;
    const insert = (id: string, username: string, email: string) =>
      prisma.client.$executeRaw`
        INSERT INTO "user" (id, username, email, first_name, last_name, status, created_by, updated_by, updated_at)
        VALUES (${id}, ${username}, ${email}, 'آزمون', 'کاربر', 'ACTIVE', 'ITEST', 'ITEST', now())`;
    await insert(`USR_${ulid()}`, handle, `${handle}@example.test`);

    await expect(
      insert(`USR_${ulid()}`, handle.toUpperCase(), `other-${handle}@example.test`),
    ).rejects.toThrow(/23505/);
    await expect(
      insert(`USR_${ulid()}`, `other-${handle}`, `${handle.toUpperCase()}@EXAMPLE.TEST`),
    ).rejects.toThrow(/23505/);
    for (const [username, email] of [
      [`${handle}\u200d`, `z-${handle}@example.test`],
      [`z-${handle}`, `${handle}\u034f@example.test`],
      [`z ${handle}`, `zz-${handle}@example.test`],
    ]) {
      await expect(insert(`USR_${ulid()}`, username!, email!)).rejects.toThrow(
        /ck_user_login_printable_ascii|23514/,
      );
    }
  });

  it('the database matches a printable-ASCII login case-insensitively exactly as user_login_key folds it', async () => {
    // The user search matches the login arms with ILIKE (`userSearchArms`); over printable ASCII,
    // the only characters a login holds, that must be the key's A–Z fold and nothing else. `%`, `_`
    // and `\` are LIKE syntax, so they are not used as patterns.
    const [row] = await prisma.client.$queryRawUnsafe<{ disagreements: number }[]>(
      `SELECT count(*)::int AS disagreements
         FROM generate_series(33, 126) c, generate_series(33, 126) d
        WHERE d NOT IN (37, 92, 95)
          AND (chr(c) ILIKE chr(d)) <> (user_login_key(chr(c)) = user_login_key(chr(d)))`,
    );
    expect(row!.disagreements).toBe(0);
  });

  it('every read finds a login by the spelling it was created with, legacy mixed case included (r2 F1)', async () => {
    const org = tenants().a;
    const tag = ulid().toLowerCase().slice(-10);
    const typed = `ali۱-${tag}`;
    const created = createUserSchema.parse({
      username: typed,
      email: `ali۱-${tag}@example.test`.replace('۱', '1'),
      firstName: 'علی',
      lastName: 'رضایی',
      organizationId: org,
      roles: ['DRIVER'],
    });
    const legacy = `Leg-${tag}`;
    const deleted = `gone-${tag}`;
    const users = [
      { id: `USR_${ulid()}`, username: created.username, email: created.email, deletedAt: null },
      { id: `USR_${ulid()}`, username: legacy, email: `Leg-${tag}@Example.TEST`, deletedAt: null },
      {
        id: `USR_${ulid()}`,
        username: deleted,
        email: `${deleted}@example.test`,
        deletedAt: new Date(),
      },
    ];
    await runUnscoped('test fixture', async () => {
      for (const user of users) {
        await prisma.client.user.create({
          data: {
            ...user,
            firstName: 'آزمون',
            lastName: 'کاربر',
            status: 'ACTIVE',
            createdBy: 'ITEST',
            updatedBy: 'ITEST',
          },
        });
      }
      await prisma.client.registrationRequest.create({
        data: {
          id: `REG_${ulid()}`,
          userId: users[1]!.id,
          requestedOrganizationId: org,
          requestedRoles: ['DRIVER'],
          documentRefs: [],
        },
      });
    });
    for (const user of users.slice(0, 2)) {
      await addMembershipRow(prisma, user.id, { organizationId: org, roles: ['DRIVER'] });
    }
    const repository = new IdentityRepository(prisma);

    // The uniqueness check: by key, deleted holders too.
    const username = (raw: string) => createUserSchema.shape.username.parse(raw);
    expect(
      await repository.findUserByUsernameOrEmail(username(legacy), `nobody-${tag}@example.test`),
    ).toEqual({ id: users[1]!.id });
    expect(
      await repository.findUserByUsernameOrEmail(`nobody-${tag}`, `LEG-${tag}@example.test`),
    ).toEqual({ id: users[1]!.id });
    expect(
      await repository.findUserByUsernameOrEmail(username(deleted), `nobody-${tag}@example.test`),
    ).toEqual({ id: users[2]!.id });
    expect(
      await repository.findUserByUsernameOrEmail(
        username(`ZZ-${tag}`),
        `nobody-${tag}@example.test`,
      ),
    ).toBeNull();

    // The search: the typed spelling and the legacy row, inside the caller's organization only.
    const search = (q: string, organizationId = org) =>
      asActor({ organizationId }, () =>
        repository.listUsersInOrganization(listUsersQuerySchema.parse({ q, limit: 10 })),
      ).then((page) => page.users.map((user) => user.id));
    expect(await search(typed)).toEqual([users[0]!.id]);
    expect(await search(`ALI1-${tag}`)).toEqual([users[0]!.id]);
    expect(await search(`leg-${tag}`)).toEqual([users[1]!.id]);
    expect(await search(`leg-${tag}@example.test`)).toEqual([users[1]!.id]);
    expect(await search(typed, tenants().b)).toEqual([]);
    // `_` and `%` are literal: `ali_-…` is not `ali1-…`, and NFKC's `％` finds no one.
    expect(await search(`ali_-${tag}`)).toEqual([]);
    expect(await search(`ali1-${tag.slice(0, 4)}％`)).toEqual([]);

    // The review queue's exact-username filter: the legacy `Leg-…` under its folded `leg-…`.
    const service = new IdentityService(
      repository,
      {} as KeycloakAdminClient,
      {} as KeycloakProjector,
    );
    const queue = (raw: string) =>
      asActor({ organizationId: org, roles: ['UNION_ADMIN'] }, () =>
        service.listRegistrationRequests(
          listRegistrationRequestsQuerySchema.parse({ username: raw, limit: 10 }),
        ),
      ).then((page) => page.items.map((item) => item.userId));
    expect(await queue(legacy)).toEqual([users[1]!.id]);
    expect(await queue(`LEG-${tag}`)).toEqual([users[1]!.id]);
    expect(await queue(typed)).toEqual([]);
  });
});
