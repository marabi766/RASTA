import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { forgettableWhere, mayForget } from './idempotency-forget';

const NOW = 1_900_000_000_000;
const B = 67_000;

describe('mayForget (the one forget rule, D-067)', () => {
  const row = (expiresAt: number, deadline: number | null) => ({
    expiresAt: new Date(expiresAt),
    replayDeadlineAt: deadline === null ? null : new Date(deadline),
  });

  it('a row with a stored deadline: expiresAt < now − B, strictly', () => {
    expect(mayForget(row(NOW - B - 1, NOW - 2 * B), NOW, B)).toBe(true);
    expect(mayForget(row(NOW - B, NOW - 2 * B), NOW, B)).toBe(false);
    expect(mayForget(row(NOW - 1, NOW - 2 * B), NOW, B)).toBe(false);
    expect(mayForget(row(NOW + 1, NOW), NOW, B)).toBe(false);
  });

  it('a row without one: expiresAt ≤ now (the reclaim rule that was always in force)', () => {
    expect(mayForget(row(NOW - 1, null), NOW, B)).toBe(true);
    expect(mayForget(row(NOW, null), NOW, B)).toBe(true);
    expect(mayForget(row(NOW + 1, null), NOW, B)).toBe(false);
  });

  it('the budget changes only the rows with a deadline', () => {
    expect(mayForget(row(NOW - 1000, null), NOW, 10 * B)).toBe(true);
    expect(mayForget(row(NOW - 1000, NOW - 2000), NOW, 10 * B)).toBe(false);
  });

  it('forgettableWhere states the same two lines, with the same instants', () => {
    expect(forgettableWhere(NOW, B)).toEqual({
      OR: [
        { replayDeadlineAt: null, expiresAt: { lte: new Date(NOW) } },
        { replayDeadlineAt: { not: null }, expiresAt: { lt: new Date(NOW - B) } },
      ],
    });
  });
});

/** The reclaim spreads forgettableWhere into its where; the purge passes `where` built from it (asserted below). */
const isForgetting = (body: string): boolean =>
  body.includes('forgettableWhere(') || /^\{\s*where\s*\}/.test(body);

describe('every deletion of a key row goes through the rule', () => {
  const source = readFileSync(join(__dirname, 'idempotency.ts'), 'utf8');
  // Strip comments: prose mentions the calls.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // What each call is given: the text after `deleteMany(` up to the statement's end.
  const deletes = code
    .split(/idempotencyKey\s*\.\s*deleteMany\(/)
    .slice(1)
    .map((segment) =>
      segment.slice(0, segment.search(/\)\s*,?\s*;|\)\s*,\s*\)|\}\s*\),\s*\n/) + 1),
    );

  it('the store has exactly three deleteMany calls: the reclaim, the release and the purge', () => {
    expect([...code.matchAll(/idempotencyKey\s*\.\s*deleteMany\(/g)]).toHaveLength(3);
    expect(deletes).toHaveLength(3);
  });

  it('two of them carry forgettableWhere; the third is the owner’s own IN_PROGRESS release', () => {
    const forgetting = deletes.filter(isForgetting);
    expect(forgetting).toHaveLength(2);
    const [release, ...rest] = deletes.filter((d) => !isForgetting(d));
    expect(rest).toEqual([]);
    expect(release).toContain("state: 'IN_PROGRESS'");
    expect(release).toContain('claimToken: claim.token');
    expect(release).toContain('organizationId: claim.organizationId');
  });

  it('the purge computes its where from forgettableWhere, and the reclaim also asks mayForget', () => {
    expect(code).toMatch(/const where = forgettableWhere\(/);
    expect(code).toMatch(/if \(\s*mayForget\(/);
  });

  it('nothing else in the construction source deletes from the key table', () => {
    // Any other module touching `idempotencyKey` deletes would bypass the rule.
    const other = [
      'tender',
      'project',
      'progress',
      'approval',
      'events',
      'prisma',
      'access',
    ].flatMap((dir) => listTs(join(__dirname, '..', dir)));
    for (const file of other) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/idempotencyKey\s*\.\s*(delete|deleteMany)\(/);
    }
  });
});

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'generated') out.push(...listTs(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}
