import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every interactive transaction of this service is opened through
 * `PrismaService.transaction`, the one place that refuses a cancelled worker's
 * transaction both before it begins and before it may COMMIT (#402 r3 R3-1).
 * A direct `$transaction(` call would bypass that check, so `src/` may hold
 * none but the two inside `PrismaService` itself and the one batch named
 * below with its reason — a new one fails here until it is routed or named.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'prisma/prisma.service.ts': 'the boundary itself',
  'security-events/security-event-outbox.store.ts':
    'one batched transaction (`capture`): no callback, so nothing of this service runs between its last statement and its COMMIT',
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sources(path);
    return /\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name) ? [path] : [];
  });
}

describe('every interactive transaction goes through PrismaService.transaction', () => {
  const root = join(__dirname, '..');
  const calls = sources(root).flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, index) =>
        /\$transaction\s*[(<]/.test(line)
          ? [{ file: relative(root, path), line: index + 1, text: line.trim() }]
          : [],
      ),
  );

  it('finds no direct $transaction call outside the named places', () => {
    expect(calls.filter((call) => !(call.file in ALLOWED))).toEqual([]);
  });

  it('the batch it allows is a batch: an array, no callback', () => {
    const batches = calls.filter(
      (call) => call.file === 'security-events/security-event-outbox.store.ts',
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]!.text).toMatch(/\$transaction\(\[$/);
  });

  it('PrismaService opens both of its branches through the post-callback check', () => {
    const service = calls.filter((call) => call.file === 'prisma/prisma.service.ts');
    expect(service).toHaveLength(2);
    const source = readFileSync(join(root, 'prisma/prisma.service.ts'), 'utf8');
    expect(source.match(/committable\(tx as ExtendedPrismaClient\)/g)).toHaveLength(2);
  });
});
