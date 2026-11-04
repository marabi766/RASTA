import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * FU-081: a byte collector that keeps every incoming chunk object until a
 * final concat costs memory per chunk, not per byte. Peer bodies go through
 * `BoundedBodyCollector` / `readCappedText` (./bounded-body.ts). This sweep
 * finds production code that pushes an incoming chunk — the value of a
 * `reader.read()`, a `'data'` event, a `for await` over a stream, or an
 * `onData` handler — onto an array, and fails on any site not reviewed below.
 */
const ROOT = resolve(__dirname, '../../../..');

/** Reviewed sites: `file` → why per-chunk retention is acceptable there. */
const REVIEWED: Record<string, string> = {
  'packages/testing/src/redirect-probe.ts':
    'dev-only test probe server (@rasta/testing never ships), reading its own test client',
  'scripts/ci-trivy-db-lib.mjs':
    'stdout of a local child process the CI job spawned (trivy/oras), not a network peer; byte cap still enforced',
  'scripts/backup-restore-drill-lib.mjs':
    'stdout of local pg_dump/psql spawned by the drill, not a network peer; byte cap still enforced',
};

const SKIP_DIR = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'test',
  '__tests__',
]);
const TEST_FILE = /\.(spec|test|int-spec|e2e-spec|pg\.test)\.[cm]?[jt]sx?$|\.fixture\.|-fake\./;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIR.has(name)) sources(path, out);
    } else if (/\.(ts|tsx|mjs|cjs|js)$/.test(name) && !TEST_FILE.test(name)) out.push(path);
  }
  return out;
}

/** Names bound to an incoming chunk in `text`. */
function chunkNames(text: string): Set<string> {
  const names = new Set<string>();
  if (/\{\s*done\s*,\s*value\s*\}\s*=\s*await\s+[\w.]+\.read\(\)/.test(text)) names.add('value');
  for (const pattern of [
    /\.on\(\s*['"]data['"]\s*,\s*(?:async\s*)?\(?\s*(\w+)/g,
    /for\s+await\s*\(\s*(?:const|let)\s+(\w+)\s+of\b/g,
    /\bon\w*Data\s*=\s*(?:async\s*)?\(\s*(\w+)/g,
    /function\s+on\w*Data\s*\(\s*(\w+)/g,
  ]) {
    for (const match of text.matchAll(pattern)) names.add(match[1]!);
  }
  return names;
}

/** `file:line` of every site that pushes an incoming chunk onto an array. */
export function chunkCollectors(file: string, text: string): string[] {
  const names = [...chunkNames(text)];
  if (names.length === 0) return [];
  const push = new RegExp(`\\b\\w+\\.push\\(\\s*(?:${names.join('|')})\\s*[,)]`);
  return text
    .split('\n')
    .flatMap((line, index) => (push.test(line) ? [`${file}:${index + 1}`] : []));
}

function sweep(): string[] {
  const roots = ['services', 'packages', 'apps'].flatMap((top) =>
    readdirSync(join(ROOT, top))
      .map((name) => join(ROOT, top, name, 'src'))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory();
        } catch {
          return false;
        }
      }),
  );
  const files = [
    ...roots.flatMap((dir) => sources(dir)),
    ...readdirSync(join(ROOT, 'scripts'))
      .filter((name) => /\.m?js$/.test(name) && !TEST_FILE.test(name))
      .map((name) => join(ROOT, 'scripts', name)),
  ];
  return files.flatMap((path) =>
    chunkCollectors(relative(ROOT, path).split('\\').join('/'), readFileSync(path, 'utf8')),
  );
}

describe('incoming-chunk collectors (FU-081)', () => {
  const found = sweep();

  it('only reviewed sites keep incoming chunks; peer bodies use BoundedBodyCollector', () => {
    const unreviewed = found.filter((site) => !(site.slice(0, site.lastIndexOf(':')) in REVIEWED));
    expect(unreviewed).toEqual([]);
  });

  it('every reviewed site still exists (a stale entry would hide a new one)', () => {
    const files = new Set(found.map((site) => site.slice(0, site.lastIndexOf(':'))));
    expect(Object.keys(REVIEWED).filter((file) => !files.has(file))).toEqual([]);
  });

  it('recognises each collector shape the class was found in', () => {
    const shapes = [
      'const { done, value } = await reader.read();\nchunks.push(value);',
      "socket.on('data', (chunk: Buffer) => { parts.push(chunk); });",
      'for await (const piece of stream) out.push(piece);',
      'const onData = (chunk: Buffer): void => {\n  chunks.push(chunk);\n};',
      "child.stdout.on('data', (b) => { chunks.push(b); });",
    ];
    for (const shape of shapes) expect(chunkCollectors('x.ts', shape)).toHaveLength(1);
    expect(
      chunkCollectors('x.ts', 'const { done, value } = await reader.read();\nbody.append(value);'),
    ).toEqual([]);
  });
});
