import { foldAsciiCase } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { createUserSchema, submitRegistrationSchema } from '../src/identity/dto';
import type { PrismaService } from '../src/prisma/prisma.service';
import { newPrisma } from './helpers';

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
});
