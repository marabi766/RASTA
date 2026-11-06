import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findKeyReaders } from './key-readers';

describe('findKeyReaders (FU-084 r2)', () => {
  const scan = (source: string) => {
    const root = mkdtempSync(join(tmpdir(), 'key-readers-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'repo.ts'), source);
      writeFileSync(
        join(root, 'src', 'repo.spec.ts'),
        'db.user.findFirst({ where: { username } });',
      );
      return findKeyReaders({ root, fields: ['username'], columns: ['username'] }).map(
        (site) => `${site.reader}#${site.kind}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it.each([
    [
      'a where filter',
      'function a(username) { return db.user.findFirst({ where: { username } }); }',
      'a#filter',
    ],
    [
      'a nested relation filter',
      'function a(u) { db.r.findMany({ where: { user: { is: { username: u } } } }); }',
      'a#filter',
    ],
    [
      'a filter object built elsewhere',
      'function a(q) { return [{ username: { contains: q } }]; }',
      'a#filter',
    ],
    [
      'a filter in a callback inside where',
      'function a(xs) { db.user.findMany({ where: { OR: xs.map((x) => ({ username: x })) } }); }',
      'a#filter',
    ],
    [
      'a where variable',
      'function a(username) { const where = { username }; return db.user.findFirst({ where }); }',
      'a#filter',
    ],
    [
      'raw SQL',
      'function a(u) { return db.$queryRaw`SELECT 1 FROM "user" WHERE username = ${u}`; }',
      'a#sql',
    ],
    [
      'raw SQL in call form',
      "function a(u) { return db.$queryRawUnsafe('SELECT 1 WHERE username = $1', u); }",
      'a#sql',
    ],
    ['a Prisma.sql fragment', 'function a(u) { return Prisma.sql`username = ${u}`; }', 'a#sql'],
    ['an equality', 'class C { m(a, b) { return a.username === b; } }', 'C.m#compare'],
    ['a membership test', 'const f = (names, u) => names.includes(u.username);', 'f#compare'],
    [
      'a class-property arrow',
      'class C { m = (u) => u.username.toLowerCase() === "x"; }',
      'C.m#compare',
    ],
  ])('finds %s', (_what, source, site) => {
    expect(scan(source)).toEqual([site]);
  });

  it.each([
    ['a write', 'function a(u) { return db.user.create({ data: { username: u } }); }'],
    ['a projection', 'function a() { return db.user.findMany({ select: { username: true } }); }'],
    ['a presence check', 'function a(dto) { return dto.username !== undefined; }'],
    [
      'the field as one of several arguments',
      'function a(u) { return repair(u.id, u.username) === "ok"; }',
    ],
  ])('leaves out %s, and every spec file', (_what, source) => {
    expect(scan(source)).toEqual([]);
  });
});
