// FU-335: which Playwright the lockfile pins for apps/web. The "Portal in a
// browser" job keys its Chromium cache on it.
//
//   node scripts/ci-playwright-version.mjs      (no arguments)
//
// Prints `version=x.y.z` and, in a workflow step, appends it to $GITHUB_OUTPUT.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXACT = /^\d+\.\d+\.\d+$/;

export class VersionRefusal extends Error {}

/**
 * The exact @playwright/test version pnpm-lock.yaml gives apps/web. Refuses
 * anything that is not one exact x.y.z (a range, a peer-suffixed or missing
 * entry), and a lockfile that disagrees with what is installed: a cache keyed
 * on one version and filled by another would never be refreshed.
 */
export function lockedPlaywrightVersion(lockText, installedVersion) {
  let importer;
  try {
    importer = parseYaml(lockText)?.importers?.['apps/web'];
  } catch {
    throw new VersionRefusal('pnpm-lock.yaml cannot be parsed');
  }
  const version = importer?.devDependencies?.['@playwright/test']?.version;
  if (typeof version !== 'string' || !EXACT.test(version))
    throw new VersionRefusal(
      `pnpm-lock.yaml does not pin one exact @playwright/test version for apps/web (found ${JSON.stringify(version)})`,
    );
  if (installedVersion !== version)
    throw new VersionRefusal(
      `apps/web has @playwright/test ${JSON.stringify(installedVersion)} installed, pnpm-lock.yaml pins ${version}`,
    );
  return version;
}

function main() {
  if (process.argv.length > 2)
    throw new VersionRefusal('ci-playwright-version.mjs takes no arguments');
  const read = (file) => readFileSync(resolve(ROOT, file), 'utf8');
  let installed;
  try {
    installed = JSON.parse(read('apps/web/node_modules/@playwright/test/package.json')).version;
  } catch {
    throw new VersionRefusal('apps/web has no readable @playwright/test installed');
  }
  const locked = lockedPlaywrightVersion(read('pnpm-lock.yaml'), installed);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${locked}\n`);
  process.stdout.write(`version=${locked}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof VersionRefusal)) throw error;
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}
