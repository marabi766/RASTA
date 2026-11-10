import {
  RastaError,
  canonicalUniqueText,
  isCanonicalUniqueText,
  uniqueTextKey,
} from '@rasta/nest-common';
import { ulid } from 'ulid';
import { createOrganizationSchema, listOrganizationsQuerySchema } from '../src/organization/dto';
import { OrganizationRepository } from '../src/organization/organization.repository';
import { OrganizationService } from '../src/organization/organization.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { asActor, newPrisma } from './helpers';

/**
 * One external code, however it is typed (FU-084): the application and PostgreSQL hold the same form
 * and compare the same key, over every code point, and a lookalike is the code it looks like.
 */
describe('the canonical external code (FU-084)', () => {
  let prisma: PrismaService;
  let service: OrganizationService;
  const LAST_CODE_POINT = 0x10ffff;
  const isSurrogate = (cp: number) => cp >= 0xd800 && cp <= 0xdfff;
  const quoted = (text: string) => `'${text.replace(/'/g, "''")}'`;

  beforeAll(async () => {
    prisma = newPrisma();
    await prisma.onModuleInit();
    service = new OrganizationService(new OrganizationRepository(prisma), {
      maxDepth: 8,
      policySetterRoles: ['SYSTEM_ADMIN'],
    });
  });

  afterAll(async () => {
    await prisma?.stop();
  });

  it.each([
    ['alone', '', ''],
    ['inside Latin', 'T', 'x'],
    ['between Persian letters', 'ب', 'ب'],
    ['after heh', 'ه', 'ب'],
  ])(
    'the application and PostgreSQL accept exactly the same code points %s, with the same key',
    async (_where, before, after) => {
      const [row] = await prisma.client.$queryRawUnsafe<{ accepted: number[]; keys: string[] }[]>(
        `SELECT array_agg(cp ORDER BY cp) AS accepted,
                array_agg(organization_text_key(${quoted(before)} || chr(cp) || ${quoted(after)}) ORDER BY cp) AS keys
           FROM generate_series(1, ${LAST_CODE_POINT}) cp
          WHERE cp NOT BETWEEN 55296 AND 57343
            AND organization_text_is_canonical(${quoted(before)} || chr(cp) || ${quoted(after)})`,
      );
      const accepted: number[] = [];
      const keys: string[] = [];
      for (let cp = 1; cp <= LAST_CODE_POINT; cp += 1) {
        if (isSurrogate(cp)) continue;
        const candidate = `${before}${String.fromCodePoint(cp)}${after}`;
        if (!isCanonicalUniqueText(candidate)) continue;
        accepted.push(cp);
        keys.push(uniqueTextKey(candidate));
      }
      expect(accepted.length).toBeGreaterThan(90);
      expect(row!.accepted).toEqual(accepted);
      expect(row!.keys).toEqual(keys);
    },
    120_000,
  );

  it('the application and PostgreSQL agree on where a blank, a half-space and the mark may stand', async () => {
    for (const candidate of [
      'a b',
      'a  b',
      ' a',
      'a ',
      'ب\u200cب',
      '\u200cب',
      'ب\u200c',
      'ب\u200c\u200cب',
      'ب\u200c ب',
      'a\u200cb',
      'خانه\u0654',
      'خانه\u0654\u200cها',
      '\u0654',
      'ه\u0654\u0654',
    ]) {
      const [row] = await prisma.client.$queryRawUnsafe<{ canonical: boolean }[]>(
        'SELECT organization_text_is_canonical($1) AS canonical',
        candidate,
      );
      expect([candidate, row!.canonical]).toEqual([candidate, isCanonicalUniqueText(candidate)]);
    }
  });

  it('a code a person cannot tell from a taken one is taken: 409, before and inside the write', async () => {
    const suffix = ulid().slice(-8);
    const taken = `کد-یزد-${suffix}`;
    const operator = <T>(fn: () => Promise<T>) =>
      asActor({ organizationId: 'ORG-ITEST-OPERATOR', roles: ['SYSTEM_ADMIN'] }, fn);
    const create = (externalCode?: string) =>
      operator(() =>
        service.create(
          createOrganizationSchema.parse({ name: 'سازمان کد', type: 'DEHYARI', externalCode }),
        ),
      );
    await create(taken);

    // Arabic kaf and yeh; a half-space between Persian letters.
    for (const lookalike of [`كد-يزد-${suffix}`, `کد-ی\u200cزد-${suffix}`]) {
      const refused = await create(lookalike).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(RastaError);
      expect((refused as RastaError).status).toBe(409);
    }

    // Two writers at once: the check before the transaction saw nothing (as the second of two
    // concurrent requests can), and the write itself is still the 409, not a 500.
    const racing = new OrganizationRepository(prisma);
    racing.findByExternalCode = () => Promise.resolve(null);
    const blind = new OrganizationService(racing, {
      maxDepth: 8,
      policySetterRoles: ['SYSTEM_ADMIN'],
    });
    const raced = await operator(() =>
      blind.create(
        createOrganizationSchema.parse({
          name: 'سازمان کد',
          type: 'DEHYARI',
          externalCode: `كد-يزد-${suffix}`,
        }),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(raced).toBeInstanceOf(RastaError);
    expect((raced as RastaError).status).toBe(409);

    // The database alone refuses it too: the key, not the bytes. On this test's own organization,
    // created without a code and addressed by its id, so neither statement can pass by touching no
    // row (r1 F2).
    const bare = await create();
    const [fixture] = await prisma.client.$queryRaw<{ external_code: string | null }[]>`
      SELECT external_code FROM organization WHERE id = ${bare.id}`;
    expect(fixture).toEqual({ external_code: null });
    await expect(
      prisma.client.$executeRawUnsafe(
        'UPDATE organization SET external_code = $1 WHERE id = $2',
        `کد-ی\u200cزد-${suffix}`,
        bare.id,
      ),
    ).rejects.toThrow(/23505/);
    // And holds nothing outside the form, whatever the code forgets.
    await expect(
      prisma.client.$executeRawUnsafe(
        'UPDATE organization SET external_code = $1 WHERE id = $2',
        `IR\u200d${suffix}`,
        bare.id,
      ),
    ).rejects.toThrow(/ck_organization_external_code_canonical|23514/);
    // The statement itself is sound: a code in the form, free by key, is written.
    await expect(
      prisma.client.$executeRawUnsafe(
        'UPDATE organization SET external_code = $1 WHERE id = $2',
        `IR-FREE-${suffix}`,
        bare.id,
      ),
    ).resolves.toBe(1);
  });

  it('the search finds a code by the spelling it was created with (r2 F1)', async () => {
    const suffix = ulid().slice(-8);
    const operator = <T>(fn: () => Promise<T>) =>
      asActor({ organizationId: 'ORG-ITEST-OPERATOR', roles: ['SYSTEM_ADMIN'] }, fn);
    const created = await operator(() =>
      service.create(
        createOrganizationSchema.parse({
          name: 'سازمان جست‌وجو',
          type: 'DEHYARI',
          externalCode: `IR-۱۲-كد\u200cيزد-${suffix}`,
        }),
      ),
    );
    expect(created.externalCode).toBe(`IR-12-کد\u200cیزد-${suffix}`);
    const search = (q: string) =>
      operator(() => service.list(listOrganizationsQuerySchema.parse({ q, limit: 100 }))).then(
        (page) => page.items.map((item) => item.id),
      );
    for (const spelling of [
      `IR-۱۲-كد\u200cيزد-${suffix}`,
      `ir-12-کدیزد-${suffix}`,
      `۱۲-كد\u200cيزد-${suffix}`,
      `IR-١٢-کدیزد-${suffix}`,
    ]) {
      expect([spelling, await search(spelling)]).toEqual([spelling, [created.id]]);
    }
    // A term that folds to nothing searches no code, rather than every code.
    expect(await search('\u0640')).not.toContain(created.id);
  });

  it('the request schema folds what keyboards vary and refuses what nobody sees', () => {
    expect(canonicalUniqueText('IR-۱۲', { caseFold: false })).toBe('IR-12');
    const parsed = createOrganizationSchema.safeParse({
      name: 'سازمان',
      type: 'DEHYARI',
      externalCode: 'IR\u034f12',
    });
    expect(parsed.success).toBe(false);
  });
});
