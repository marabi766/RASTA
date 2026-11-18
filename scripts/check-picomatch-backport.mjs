import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

// Verify the files pnpm installed, rather than just trusting the patch names.
const expected = new Map([
  ['picomatch@2.3.2', 'a3bfb12da1e0f34d6402441bc6f4dfb683c99e845d8434d696459cf3f656f2c5'],
  ['picomatch@4.0.7', 'b10cca1ff1eb49455a5d984244a53e7c8a6b768a92897a9d41c688ff056ebe3c'],
]);
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = parse(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'));
const locked = Object.keys(lock.packages).filter((key) => key.startsWith('picomatch@'));
assert.deepEqual(locked.sort(), [...expected.keys()]);

const store = join(root, 'node_modules', '.pnpm');
const installed = new Set();
for (const dir of readdirSync(store).filter((name) => name.startsWith('picomatch@'))) {
  const packagePath = join(store, dir, 'node_modules', 'picomatch');
  const manifestPath = join(packagePath, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const id = manifest.name + '@' + manifest.version;
  const expectedHash = expected.get(id);
  assert.ok(expectedHash, `Unverified installed dependency: ${id}`);
  assert.ok(lock.patchedDependencies[id], `Missing frozen lockfile backport: ${id}`);

  const parser = readFileSync(join(packagePath, 'lib', 'parse.js'));
  assert.equal(
    createHash('sha256').update(parser).digest('hex'),
    expectedHash,
    `Installed parser lacks the reviewed backport: ${id}`,
  );
  installed.add(id);
}
assert.deepEqual([...installed].sort(), [...expected.keys()]);
console.log('Verified the installed picomatch backports for both locked versions.');

// pnpm's report is version based. Leave the workspace config and audit itself
// untouched, and account for every blocking finding before accepting a backport.
const advisoryId = 'GHSA-fc5q-39xc-vjpf';
const audit = spawnSync('pnpm', ['audit', '--audit-level=high', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});
assert.ok(!audit.error && !audit.signal, 'Dependency audit did not complete');
assert.ok(audit.status === 0 || audit.status === 1, 'Unexpected dependency audit exit status');

const report = JSON.parse(audit.stdout);
const severity = report.metadata?.vulnerabilities;
assert.ok(
  Number.isSafeInteger(severity?.high) &&
    severity.high >= 0 &&
    Number.isSafeInteger(severity?.critical) &&
    severity.critical >= 0 &&
    report.advisories &&
    typeof report.advisories === 'object' &&
    !Array.isArray(report.advisories),
  'Incomplete dependency audit report',
);
const blockers = Object.values(report.advisories).filter(
  (advisory) => advisory.severity === 'high' || advisory.severity === 'critical',
);

if (audit.status === 0) {
  assert.ok(
    severity.high === 0 && severity.critical === 0 && blockers.length === 0,
    'Successful audit still reports blocking vulnerabilities',
  );
  console.log('Dependency audit found no high or critical vulnerabilities.');
} else {
  assert.ok(
    severity.high === 1 && severity.critical === 0 && blockers.length === 1,
    'Dependency audit has additional high or critical findings',
  );
  const [advisory] = blockers;
  assert.ok(
    advisory.github_advisory_id === advisoryId &&
      advisory.module_name === 'picomatch' &&
      advisory.severity === 'high' &&
      Array.isArray(advisory.findings) &&
      advisory.findings.length > 0 &&
      advisory.findings.every((finding) => expected.has('picomatch@' + finding.version)),
    'Dependency audit contains an unmitigated vulnerability',
  );
  console.log('The sole blocking advisory is covered by the verified picomatch backports.');
}
