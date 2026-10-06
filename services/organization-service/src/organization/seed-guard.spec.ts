import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SeedWouldReparentError, assertSeedDoesNotReparent } from './seed-guard';

describe('the demo seed never re-parents an existing organization', () => {
  it('lets a new organization, and an existing one under the same parent, through', () => {
    expect(() => assertSeedDoesNotReparent('ORG-A', null, 'ORG-P')).not.toThrow();
    expect(() => assertSeedDoesNotReparent('ORG-A', { parentId: 'ORG-P' }, 'ORG-P')).not.toThrow();
    expect(() => assertSeedDoesNotReparent('ROOT', { parentId: null }, null)).not.toThrow();
  });

  it('refuses an existing organization whose parent differs, either way round', () => {
    expect(() => assertSeedDoesNotReparent('ORG-A', { parentId: 'ORG-Q' }, 'ORG-P')).toThrow(
      SeedWouldReparentError,
    );
    expect(() => assertSeedDoesNotReparent('ORG-A', { parentId: null }, 'ORG-P')).toThrow(
      SeedWouldReparentError,
    );
    expect(() => assertSeedDoesNotReparent('ORG-A', { parentId: 'ORG-P' }, null)).toThrow(
      SeedWouldReparentError,
    );
  });

  it('is what the seed runs before it writes, and its update never touches the parent, path or depth', () => {
    const seed = readFileSync(join(__dirname, '..', '..', 'prisma', 'seed.ts'), 'utf8');
    expect(seed).toContain('assertSeedDoesNotReparent(');
    const update = /update: \{([\s\S]*?)\},\n {4}\}\);/.exec(seed)?.[1] ?? '';
    expect(update).toContain('name: org.name');
    expect(update).not.toMatch(/parentId|depth|path/);
  });
});
