import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// git-ignored output (installs, build output, generated clients another task may be
// regenerating) is never listed: the authored-source inventory (FU-102).
const { authoredFiles } = require('../../../../scripts/authored-source-inventory.cjs') as {
  authoredFiles: (dir: string) => string[];
};

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

/**
 * Production sources: every authored file under a workspace's `src` (test files and test
 * directories aside) and every top-level script, as repository-relative paths.
 */
function sources(): string[] {
  const workspaces = ['services', 'packages', 'apps'].flatMap((top) =>
    authoredFiles(join(ROOT, top))
      .map((path) => relative(ROOT, path).split('\\').join('/'))
      .filter((file) => {
        const parts = file.split('/');
        return (
          parts[2] === 'src' &&
          !parts.slice(3, -1).some((name) => SKIP_DIR.has(name)) &&
          /\.(ts|tsx|mjs|cjs|js)$/.test(file) &&
          !TEST_FILE.test(parts.at(-1)!)
        );
      }),
  );
  const scripts = authoredFiles(join(ROOT, 'scripts'))
    .map((path) => relative(ROOT, path).split('\\').join('/'))
    .filter((file) => /^scripts\/[^/]+\.m?js$/.test(file) && !TEST_FILE.test(file));
  return [...workspaces, ...scripts];
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
  return sources().flatMap((file) => chunkCollectors(file, readFileSync(join(ROOT, file), 'utf8')));
}

/**
 * PR #722 r1 F1: the chunk sweep above sees one collector shape, not every
 * reader. A body read through `Response#text/json/arrayBuffer/blob/formData/
 * bytes`, an SDK `transformTo*` helper, `stream/consumers` or `Readable.fromWeb`
 * has no ceiling before collection — chunked or highly compressed, the decoded
 * bytes are buffered whole. Every such call, and every hand-rolled
 * `getReader()` loop, in production code is either one of the bounded readers
 * (`./bounded-body.ts`, `apps/web/src/server/bounded-body.ts`) or a reviewed
 * line below; a new one fails this test until it is bounded or reviewed.
 */
const BODY_READER =
  /\.(?:text|json|arrayBuffer|blob|formData|bytes)\(\s*\)|\.getReader\(\s*\)|\btransformTo(?:ByteArray|String|WebStream)\(|\bstream\/consumers\b|\bfromWeb\(/;

/** Reviewed body-reading lines: `file` → exact trimmed line → why it is bounded or not a peer. */
const REVIEWED_READERS: Record<string, Record<string, string>> = {
  'packages/nest-common/src/http/bounded-body.ts': {
    'const reader = response.body.getReader();': 'the bounded collector itself',
  },
  'apps/web/src/server/bounded-body.ts': {
    'const reader = response.body.getReader();': "the portal's bounded collector",
  },
  'services/marketplace-service/src/economic/economic.client.ts': {
    'const reader = response.body.getReader();':
      'BoundedBodyCollector with its own deadline check between chunks (FU-044)',
  },
  'services/document-service/src/storage/s3.storage.ts': {
    'const reader = body.transformToWebStream().getReader();':
      'prefix read: at most `length` bytes kept, then cancelled',
  },
  'scripts/verify-grafana-dashboard-probe.mjs': {
    'const reader = response.body.getReader();': 'byte-capped `boundedText` of the harness',
  },
  'apps/web/src/server/asset-documents.ts': {
    'const bytes = new Uint8Array(await file.arrayBuffer());':
      "the user's own upload, already parsed by Next under its server-action body limit; not a peer answer",
    'const bytes = new Uint8Array(await call.file.arrayBuffer());':
      "the user's own upload, already parsed by Next under its server-action body limit; not a peer answer",
  },
  'apps/web/src/app/auth/logout/route.ts': {
    'const form = await request.formData().catch(() => null);':
      "the browser's own logout form posted to this route, not a peer answer",
  },
};

/** `file:line` and trimmed text of every body-reading call in `text`. */
export function bodyReaders(file: string, text: string): { site: string; line: string }[] {
  return text.split('\n').flatMap((line, index) =>
    // Comment lines are prose, not reads.
    BODY_READER.test(line) && !/^\s*(?:\*|\/\/|\/\*)/.test(line)
      ? [{ site: `${file}:${index + 1}`, line: line.trim() }]
      : [],
  );
}

function sourceFiles(): string[] {
  return sources().filter((file) => !/\/generated\//.test(file));
}

describe('peer body readers (PR #722 r1 F1)', () => {
  const found = sourceFiles().flatMap((file) =>
    bodyReaders(file, readFileSync(join(ROOT, file), 'utf8')),
  );
  const fileOf = (site: string) => site.slice(0, site.lastIndexOf(':'));

  it('every production body read is bounded or reviewed', () => {
    const unreviewed = found.filter(
      ({ site, line }) => REVIEWED_READERS[fileOf(site)]?.[line] === undefined,
    );
    expect(unreviewed).toEqual([]);
  });

  it('every reviewed line still exists (a stale entry would hide a new one)', () => {
    const present = new Set(found.map(({ site, line }) => `${fileOf(site)}\u0000${line}`));
    const stale = Object.entries(REVIEWED_READERS).flatMap(([file, lines]) =>
      Object.keys(lines)
        .filter((line) => !present.has(`${file}\u0000${line}`))
        .map((line) => `${file}: ${line}`),
    );
    expect(stale).toEqual([]);
  });

  it('recognises every unbounded reader shape, the review inventory included', () => {
    for (const shape of [
      'async (response) => ({ status: response.status, text: await response.text() }),',
      'const parsed = schema.safeParse(await response.json());',
      'const buffer = await response.arrayBuffer();',
      'const blob = await response.blob();',
      'const bytes = await response.bytes();',
      'const form = await response.formData();',
      'return await body.transformToByteArray();',
      "import { text } from 'node:stream/consumers';",
      'const node = Readable.fromWeb(response.body);',
      'const reader = response.body.getReader();',
    ]) {
      expect(bodyReaders('x.ts', shape)).toHaveLength(1);
    }
    expect(bodyReaders('x.ts', 'const text = await readBoundedText(response, 1024);')).toEqual([]);
    expect(bodyReaders('x.ts', ' * the bounded drop-in for `response.json()`')).toEqual([]);
  });
});

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
