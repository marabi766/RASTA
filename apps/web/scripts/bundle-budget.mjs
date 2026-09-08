/**
 * Measures the initial JavaScript each route actually ships, gzipped.
 *
 * ADR-003 Compliance sets the budget: «Bundle اولیه کمتر از ۲۰۰ کیلوبایت
 * gzip», restated in docs/16 § 16.10. Next's build summary prints its own
 * "First Load JS" column, but this script gzips the emitted files itself and
 * sums them per route, so the number reported is one anybody can reproduce with
 * `gzip -c | wc -c` rather than one taken on trust from the build tool.
 *
 * Run after `next build`:
 *   node scripts/bundle-budget.mjs [--budget-kib 200]
 *
 * Exits non-zero when a route is over budget, so it can sit in CI.
 */

import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const BUDGET_KIB = readBudget(process.argv);
const NEXT_DIR = path.join(process.cwd(), '.next');

const manifest = JSON.parse(await readFile(path.join(NEXT_DIR, 'app-build-manifest.json'), 'utf8'));

const sizeCache = new Map();

async function gzippedSize(relativePath) {
  if (!sizeCache.has(relativePath)) {
    const bytes = await readFile(path.join(NEXT_DIR, relativePath));
    sizeCache.set(relativePath, gzipSync(bytes, { level: 9 }).byteLength);
  }
  return sizeCache.get(relativePath);
}

/**
 * What a route actually downloads on first paint.
 *
 * The manifest lists layouts and pages as separate entries, and a page entry
 * alone understates the truth: opening `/marketplace` loads the root layout and
 * the portal layout as well. So each page is scored against the union of its
 * own files and every ancestor layout's, de-duplicated — a shared chunk is
 * downloaded once, and counting it twice would invent a budget problem that
 * does not exist.
 */
const entries = Object.entries(manifest.pages);
const layouts = entries.filter(([key]) => key.endsWith('/layout'));
const pages = entries.filter(([key]) => !key.endsWith('/layout'));

const rows = [];

for (const [route, ownFiles] of pages) {
  const segment = route.replace(/\/[^/]+$/, '');
  const files = new Set(ownFiles);

  for (const [layoutKey, layoutFiles] of layouts) {
    const layoutSegment = layoutKey.slice(0, -'/layout'.length);
    if (segment === layoutSegment || segment.startsWith(`${layoutSegment}/`)) {
      for (const file of layoutFiles) files.add(file);
    }
  }

  const scripts = [...files].filter((file) => file.endsWith('.js'));
  let total = 0;
  for (const file of scripts) total += await gzippedSize(file);
  rows.push({ route, bytes: total, files: scripts.length });
}

rows.sort((a, b) => b.bytes - a.bytes);

const budgetBytes = BUDGET_KIB * 1024;
const over = rows.filter((row) => row.bytes > budgetBytes);

const width = Math.max(...rows.map((row) => row.route.length));
process.stdout.write(`Initial JS per route (gzip -9), budget ${BUDGET_KIB} KiB\n\n`);
for (const row of rows) {
  const kib = (row.bytes / 1024).toFixed(1).padStart(7);
  const flag = row.bytes > budgetBytes ? '  OVER BUDGET' : '';
  process.stdout.write(`  ${row.route.padEnd(width)}  ${kib} KiB  (${row.files} files)${flag}\n`);
}

const worst = rows[0];
process.stdout.write(
  `\nLargest route: ${worst.route} at ${(worst.bytes / 1024).toFixed(1)} KiB gzip.\n`,
);

if (over.length > 0) {
  process.stderr.write(`\n${over.length} route(s) exceed the ${BUDGET_KIB} KiB gzip budget.\n`);
  process.exit(1);
}

function readBudget(argv) {
  const index = argv.indexOf('--budget-kib');
  if (index === -1) return 200;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('--budget-kib must be a positive number');
  }
  return value;
}
