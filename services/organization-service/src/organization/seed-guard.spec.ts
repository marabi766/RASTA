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
    const write = readFileSync(join(__dirname, 'seed-organization.ts'), 'utf8');
    expect(write).toContain('assertSeedDoesNotReparent(');
    const update = /organization\.update\(\{([\s\S]*?)\}\);/.exec(write)?.[1] ?? '';
    expect(update).toContain('name: org.name');
    expect(update).not.toMatch(/parentId|depth|path/);
  });

  it('writes organizations only through seedOrganization, never with a statement of its own', () => {
    // seed-hierarchy-lock.int-spec.ts holds seedOrganization to the hierarchy lock; a write
    // beside it in the seed would be outside that lock again.
    const seed = readFileSync(join(__dirname, '..', '..', 'prisma', 'seed.ts'), 'utf8');
    expect(seed).toContain('await seedOrganization(repository, org)');
    expect(seed).not.toMatch(/\.organization\.(upsert|create|update|updateMany)\(/);
    expect(seed).not.toMatch(/UPDATE organization SET/);
  });
});
